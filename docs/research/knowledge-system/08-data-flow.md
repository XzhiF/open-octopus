# 08 — 完整数据流

本文档追踪一条规则从产生到生效的完整生命周期，定义每个环节的数据变换和函数签名。

## 1. 总览：完整闭环

```
执行完成
  │
  ▼
① ArchiveService.archiveExecution()
  → 写入 execution_archive 表 (指标数据)
  │
  ▼
② ArchiveService.proposeRulesForReview()
  → extractRules(execResult, logDir) → ProposedRule[]
  → detectConflicts(rule, knowledgeDir) → ConflictInfo[]
  → pendingDAO.insert(PendingItem) → 审核队列
  │
  ▼
③ 用户审核 (Dashboard / Agent 对话)
  → approveItem(pendingItem) → 写入知识文件
  → rebuildIndex(org) → 更新 index.md
  │
  ▼
④ 下次执行 — injectKnowledge(node, pool)
  → 读 user_preference.md (全量)
  → 读 index.md → findRelevantRules(index, prompt) → rule IDs
  → 从 {project}.md 提取相关规则段落
  → 拼接到 agent prompt
  │
  ▼
⑤ Agent 带着知识执行 → 更好的结果
  │
  ▼
⑥ effectivenessTracker.compareWithKnowledge(executionId)
  → 对比"有知识注入"vs"无知识注入"的执行结果
  → 更新规则置信度
  │
  ▼
⑦ 定期: compactKnowledgeFile() + retireStaleRules()
  → 合并重复规则、移除过时规则
  │
  └──→ Loop 回到 ①
```

## 2. 各环节数据结构变换

### ① 执行归档

**输入**: `Execution` (DB 记录) + `state/{exec-id}.json` (节点结果)

**输出**: `execution_archive` 表一行

```typescript
// 已有实现，在 execution-memory-loop.md 中定义
// 此处只存指标，不存"经验"
```

### ② 规则提取 → 审核队列

**输入**: `ExecutionResult` + `logDir`

**变换链**:

```
ExecutionResult
  → extractRules()          → ProposedRule[]
  → detectConflicts()       → ProposedRule[] + ConflictInfo[]
  → toPendingItem()         → PendingItem[]
  → pendingDAO.insert()     → 审核队列 (SQLite)
```

**数据定义**:

```typescript
interface ProposedRule {
  text: string           // 规则文本（祈使句）
  scope: 'project' | 'workflow' | 'global'
  target: string         // 项目名或工作流名
  source: string         // 来源说明
}

interface ConflictInfo {
  existing_rule: string  // 已有规则文本
  existing_file: string  // 已有规则所在文件
  conflict_type: 'contradicts' | 'overlaps' | 'supersedes'
}

interface PendingItem {
  id: string
  type: 'rule' | 'skill'
  source: 'workspace_archive' | 'agent_conversation' | 'behavior_pattern' | 'scheduler' | 'clone_merge'
  source_ref: string
  source_label: string
  content: string         // 规则文本（= ProposedRule.text）
  target_file: string     // 写入哪个知识文件
  scope: 'project' | 'workflow' | 'global'
  conflicts: ConflictInfo[]
  confidence: number      // 0-1
  auto_approve: boolean
  status: 'pending' | 'approved' | 'edited' | 'rejected' | 'deferred'
  created_at: string
  reviewed_at?: string
  user_notes?: string
}
```

**转换函数**:

```typescript
function toPendingItem(
  rule: ProposedRule,
  conflicts: ConflictInfo[],
  archiveId: string,
  workflowName: string,
  date: string,
): PendingItem {
  return {
    id: generateId(),
    type: 'rule',
    source: 'workspace_archive',
    source_ref: archiveId,
    source_label: `${workflowName} ${date}`,
    content: rule.text,
    target_file: rule.scope === 'workflow'
      ? `workflow-${rule.target}.md`
      : `${rule.target}.md`,
    scope: rule.scope,
    conflicts,
    confidence: 0.5,
    auto_approve: false,
    status: 'pending',
    created_at: new Date().toISOString(),
  }
}
```

### ③ 审核通过 → 写入知识文件

**输入**: `PendingItem` (status: 'approved' 或 'edited')

**变换链**:

```
PendingItem (approved)
  → appendToKnowledgeFile(org, [rule])  → 追加到 {project}.md
  → rebuildIndex(org)                   → 重建 index.md
  → pendingDAO.update(id, {status, reviewed_at})
```

**approveItem 实现**:

```typescript
async function approveItem(item: PendingItem): Promise<void> {
  const org = getOrgFromKnowledgeDir(item.target_file)
  const rule: ProposedRule = {
    text: item.content,
    scope: item.scope,
    target: item.target_file.replace(/^workflow-/, '').replace(/\.md$/, ''),
    source: item.source_label,
  }

  // 写入知识文件
  await appendToKnowledgeFile(org, [rule])

  // 更新审核状态
  await pendingDAO.update(item.id, {
    status: 'approved',
    reviewed_at: new Date().toISOString(),
    user_notes: item.user_notes ?? null,
  })
}
```

**rebuildIndex 实现**:

```typescript
async function rebuildIndex(org: string): Promise<void> {
  const knowledgeDir = join(os.homedir(), '.octopus', org, 'knowledge')
  const indexPath = join(knowledgeDir, 'index.md')

  const files = readdir(knowledgeDir)
    .filter(f => f.endsWith('.md') && f !== 'index.md' && f !== 'user_preference.md')

  const entries: IndexEntry[] = []

  for (const file of files) {
    const content = await readFile(join(knowledgeDir, file), 'utf-8')
    const rules = parseRulesFromMarkdown(content)

    for (const rule of rules) {
      entries.push({
        id: rule.id,
        file: file,
        summary: rule.text.length > 60 ? rule.text.slice(0, 57) + '...' : rule.text,
        source: rule.source,
        date: rule.date,
        status: 'active',
      })
    }
  }

  // 统计
  const projectCount = groupBy(entries, e => e.file).size
  const recentDate = entries.reduce((max, e) => e.date > max ? e.date : max, '')

  const content = `# 知识索引 — ${org}

## 统计
${[...groupBy(entries, e => e.file).entries()]
  .map(([file, items]) => `${file.replace('.md', '')} (${items.length} 条)`)
  .join(' | ')}
最近更新: ${recentDate}

## 规则条目

| ID | 文件 | 摘要 | 来源 | 日期 | 状态 |
|----|------|------|------|------|------|
${entries.map(e => `| ${e.id} | ${e.file} | ${e.summary} | ${e.source} | ${e.date} | ${e.status} |`).join('\n')}
`

  await writeFile(indexPath, content)
}
```

**parseRulesFromMarkdown 实现**:

```typescript
interface ParsedRule {
  id: string
  text: string
  date: string
  source: string
}

function parseRulesFromMarkdown(content: string): ParsedRule[] {
  const rules: ParsedRule[] = []
  const lines = content.split('\n')

  for (const line of lines) {
    // 匹配: - 规则文本 <!-- id:xxx | date | source -->
    const match = line.match(/^- (.+?) <!-- id:(\S+) \| (\S+) \| (\S+)(?: \| \S+)? -->/)
    if (match) {
      rules.push({
        text: match[1].trim(),
        id: match[2],
        date: match[3],
        source: match[4],
      })
    }
  }

  return rules
}
```

**generateRuleId 实现**:

```typescript
async function generateRuleId(filePath: string, target: string): Promise<string> {
  // 项目缩写: octopus → oct, agency-agents-zh → aaz
  const prefix = target.split('-').map(w => w[0]).join('').slice(0, 3)

  // 读取现有规则，找到最大序号
  const content = existsSync(filePath) ? await readFile(filePath, 'utf-8') : ''
  const existing = parseRulesFromMarkdown(content)
  const maxNum = existing.reduce((max, r) => {
    const num = parseInt(r.id.replace(new RegExp(`^${prefix}-`), ''), 10)
    return num > max ? num : max
  }, 0)

  return `${prefix}-${String(maxNum + 1).padStart(3, '0')}`
}
```

### ④ 知识注入

详见 [03-knowledge-injection.md](./03-knowledge-injection.md)。

关键函数 `extractRuleSection`：

```typescript
function extractRuleSection(fileContent: string, ruleId: string): string | null {
  const lines = fileContent.split('\n')
  for (const line of lines) {
    if (line.includes(`id:${ruleId}`)) {
      return line.trim()
    }
  }
  return null
}
```

### ⑤ 执行完成（Loop 回到 ①）

同 ①，无额外操作。

### ⑥ 效果追踪（新增）

**目的**：验证注入的知识是否真的帮到了 agent。

```typescript
interface KnowledgeEffectiveness {
  rule_id: string
  injected_count: number      // 被注入的次数
  helpful_count: number       // 注入后该规则相关的问题未再出现
  not_helpful_count: number   // 注入后问题仍然出现
  last_injected: string
  confidence: number          // helpful / (helpful + not_helpful)
}

// 存储在 SQLite
CREATE TABLE knowledge_effectiveness (
  rule_id TEXT PRIMARY KEY,
  injected_count INTEGER DEFAULT 0,
  helpful_count INTEGER DEFAULT 0,
  not_helpful_count INTEGER DEFAULT 0,
  last_injected TEXT,
  confidence REAL DEFAULT 0.5
);
```

**追踪逻辑**:

```typescript
async function trackEffectiveness(
  executionId: string,
  injectedRules: string[],  // 本次注入的规则 ID
  executionResult: ExecutionResult,
): Promise<void> {
  for (const ruleId of injectedRules) {
    // 检查本次执行是否出现了该规则要防止的问题
    const reviewNode = executionResult.nodes['review']
    const blockers = reviewNode ? extractBlockers(reviewNode.lastOutput) : []

    // 简单判断：如果 blocker 中提到了规则相关的关键词 → not_helpful
    // 否则 → helpful（该规则相关的代码没出问题）
    const rule = await getRuleById(ruleId)
    const isHelpful = !blockers.some(b =>
      semanticSimilarity(b.text, rule.text) > 0.7
    )

    await effectivenessDAO.update(ruleId, {
      injected_count: '+1',
      helpful_count: isHelpful ? '+1' : undefined,
      not_helpful_count: isHelpful ? undefined : '+1',
      last_injected: new Date().toISOString(),
      confidence: null,  // 重新计算
    })
  }
}
```

### ⑦ 知识衰减（新增）

```typescript
async function retireStaleRules(org: string): Promise<number> {
  const stale = await effectivenessDAO.query({
    where: {
      injected_count_gte: 3,       // 至少注入过 3 次
      confidence_lte: 0.2,         // 但帮助率低于 20%
      last_injected_before: daysAgo(30),
    },
  })

  let retired = 0
  for (const entry of stale) {
    // 从知识文件中移除（标记为已删除，不物理删除）
    await markRuleAsRetired(org, entry.rule_id)
    retired++
  }

  return retired
}
```

## 3. 审核队列的入口统一

不管是规则还是 Skill，都通过 `PendingItem` 进入同一个队列：

```
workspace 归档 ──→ extractRules() ──→ toPendingItem(type:'rule') ──┐
                                                                    │
Agent 对话 ────→ proposeSkill() ──→ toPendingItem(type:'skill') ───┤──→ pendingDAO
                                                                    │
行为检测 ──────→ detectPatterns() ─→ toPendingItem(type:'skill') ──┤
                                                                    │
重复踩坑 ──────→ detectRecurring() → toPendingItem(auto_approve) ──┤
                                                                    │
分身合并 ──────→ mergeClone() ─────→ toPendingItem(source:'clone') ─┘
```

## 4. 知识整理触发机制

```typescript
// 每次写入知识文件后检查
async function onKnowledgeFileWrite(org: string, filePath: string): Promise<void> {
  const content = await readFile(filePath, 'utf-8')
  const lineCount = content.split('\n').length

  const threshold = agentConfig.knowledge?.compact_threshold ?? 100
  if (lineCount >= threshold) {
    // 不自动整理，而是放入审核队列让用户确认
    await pendingDAO.insert({
      id: generateId(),
      type: 'rule',
      source: 'system',
      source_ref: filePath,
      source_label: `知识整理: ${basename(filePath)}`,
      content: `文件 ${basename(filePath)} 已达 ${lineCount} 行，建议整理`,
      target_file: basename(filePath),
      scope: 'global',
      conflicts: [],
      confidence: 0.8,
      auto_approve: false,
      status: 'pending',
    })
  }
}
```

## 5. 全局 + Org 级合并策略

两层**同时生效**，不是二选一。

```
~/.octopus/knowledge/                    ← 全局（跨所有 org 共享）
├── user_preference.md                   ← 通用偏好（编码习惯、模型偏好）
└── index.md                             ← 全局规则索引

~/.octopus/{org}/knowledge/              ← Org 级（特定组织）
├── user_preference.md                   ← Org 偏好（覆盖全局同名条目）
├── index.md                             ← Org 规则索引
├── {project}.md                         ← 项目规则
└── workflow-{name}.md                   ← 工作流规则
```

**合并规则**：
- **user_preference.md**：全局 + Org 内容拼接，Org 条目覆盖全局同名条目
- **知识文件**：全局的和 Org 的各自独立，注入时都读
- **index.md**：全局和 Org 各自维护，注入时合并查询
- **写入默认到 Org 级**，除非用户显式标记 `scope: 'global'`

```typescript
const GLOBAL_KNOWLEDGE_DIR = join(os.homedir(), '.octopus', 'knowledge')

function getKnowledgeDirs(org: string): string[] {
  const orgDir = join(os.homedir(), '.octopus', org, 'knowledge')
  const dirs = [GLOBAL_KNOWLEDGE_DIR]
  if (existsSync(orgDir)) dirs.push(orgDir)
  return dirs
}

// user_preference.md 合并
function getEffectiveUserPreference(org: string): string {
  const globalPref = join(GLOBAL_KNOWLEDGE_DIR, 'user_preference.md')
  const orgPref = join(os.homedir(), '.octopus', org, 'knowledge', 'user_preference.md')

  let content = ''
  if (existsSync(globalPref)) {
    content += await readFile(globalPref, 'utf-8')
  }
  if (existsSync(orgPref)) {
    // Org 级追加（同名条目覆盖全局）
    content += '\n\n<!-- org override -->\n\n'
    content += await readFile(orgPref, 'utf-8')
  }
  return content
}

// 注入时：读两层的所有知识文件
async function collectAllKnowledgeFiles(org: string): string[] {
  const dirs = getKnowledgeDirs(org)
  const files: string[] = []

  for (const dir of dirs) {
    const mdFiles = readdir(dir)
      .filter(f => f.endsWith('.md') && f !== 'index.md' && f !== 'user_preference.md')
      .map(f => join(dir, f))
    files.push(...mdFiles)
  }

  return files
}
```

**写入路径选择**：

```typescript
function getWriteTarget(org: string, scope: 'global' | 'project' | 'workflow'): string {
  if (scope === 'global') {
    return GLOBAL_KNOWLEDGE_DIR
  }
  return join(os.homedir(), '.octopus', org, 'knowledge')
}
```

## 6. 实现前置条件

开 feat 分支前需要明确的 3 个架构决策：

### 6.1 引擎如何获取知识文件

**方案 A（采用）：引擎直接读文件系统**

```
Server (packages/server/)          Engine (packages/engine/)
  │                                   │
  │  启动执行时传入 org 参数            │
  │  engine.start(workflow, {         │
  │    org: 'xzf-dev',               │
  │    workspacePath: '...',          │
  │  })                               │
  │                                   │
  │                              injectKnowledge(node, pool)
  │                                   │
  │                              readFile(~/.octopus/{org}/knowledge/*.md)
  │                                   │
  │                              拼接到 prompt → 发送给 LLM
```

- Engine 直接 `readFile` 知识文件（`~/.octopus/{org}/knowledge/`）
- 不通过 Server API 中转
- **前提**：Engine 进程有文件系统读权限（同机部署时天然满足）

### 6.2 相关性判断时机

**每个 agent 节点都调 haiku 判断相关性** → 太贵（10+ 个节点 = 10+ 次 LLM 调用）

**改为：工作流启动时判断一次，缓存到执行上下文**

```typescript
// 工作流启动时（执行前）
async function precomputeRelevantRules(
  org: string,
  workflowName: string,
  inputValues: Record<string, string>,
): Promise<string[]> {
  const allFiles = await collectAllKnowledgeFiles(org)
  const indexContent = await collectAllIndexes(org)

  // 一次 haiku 调用，判断整个工作流相关的规则
  const relevantIds = await findRelevantRules(
    indexContent,
    `workflow: ${workflowName}, inputs: ${JSON.stringify(inputValues)}`,
  )

  return relevantIds  // ['oct-007', 'oct-008', 'bh-001']
}

// 结果缓存到 VarPool，所有 agent 节点共享
pool.set('__relevant_rule_ids', JSON.stringify(relevantIds))

// 每个 agent 节点的 injectKnowledge() 读缓存，不再调 haiku
private async injectKnowledge(node: NodeDef, pool: VarPool): Promise<string> {
  const ruleIds = JSON.parse(pool.get('__relevant_rule_ids') ?? '[]')
  // 直接从文件读取这些 ID 对应的规则段落
  // ...
}
```

### 6.3 知识文件与 workspace 生命周期

**知识文件永远在 `~/.octopus/` 下，不在 workspace 内。**

```
~/.octopus/{org}/knowledge/     ← 持久，workspace 删除不影响
workspace/                      ← 临时，删除时级联清空
  ├── state/                    ← 执行记录（被归档到 execution_archive）
  ├── logs/                     ← JSONL 日志（归档后不再需要）
  └── projects/                 ← git worktree（删除时释放）
```

- workspace 删除 → `cascadeDeleteByWorkspace()` 清空 state/logs/
- 知识文件在 `~/.octopus/{org}/knowledge/` → 不受影响
- 归档流程：workspace 删除前 → `proposeRulesForReview()` 提取规则到审核队列 → 审核通过后写入全局知识文件 → workspace 可安全删除
