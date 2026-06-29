# Execution Memory — 让 Octopus 进入 Loop Engineering

## 1. 问题诊断

### 1.1 模块完备度

当前 Octopus 平台拥有 Loop Engineering 六大构建模块中的五个：

| 模块 | 现状 | 评估 |
|------|------|------|
| Automations | Scheduler + Cron + Agent 自注册 | ✅ 完备 |
| Worktrees | 完整 git worktree 隔离 | ✅ 完备 |
| Skills | 20+ 内置 + 本地进化 + FTS 搜索 | ✅ 完备 |
| Connectors | MCP 协议 + Hermes 通知 | ✅ 可用（单向） |
| Sub-agents | Swarm + 多角色 + maker/checker | ✅ 完备 |
| **Memory/State** | Agent 三层记忆 + experiences 表 | **⚠️ 缺少执行记忆** |

### 1.2 五个断裂点

| # | 断裂点 | 现状 | 影响 |
|---|--------|------|------|
| 1 | **Token 黑洞** | 花 50 万 token 跑的 bug-hunter，删 workspace 后统计归零 | 无法衡量 ROI |
| 2 | **经验断裂** | 上次跑出的 BUG 修复经验，下次跑时 Agent 完全不知道 | 每次冷启动 |
| 3 | **Dashboard 盲区** | 只能看"当前存活"的 workspace，删了就没了 | 无法做趋势分析 |
| 4 | **Agent 失忆** | 编排器无法基于历史执行数据做智能决策 | 无法闭环 |
| 5 | **Hermes 单向** | 只能 Octopus→Telegram 推送，不能 Telegram→Octopus 交互 | 无法远程操控 |

### 1.3 根因

```
workspace 删除 → cascadeDeleteByWorkspace() → 17 张表级联清空
  ├── executions (执行记录)
  ├── node_executions (节点执行)
  ├── node_token_usages (token 用量)
  ├── llm_calls (LLM 调用详情)
  ├── agent_events (agent 事件)
  ├── branch_executions (分支执行)
  └── ... 全部消失

而 experiences 表、evolution_log 表虽然全局保留,
但没有任何机制将执行结果写入这些表。
执行产生的知识随 workspace 消亡，系统无法积累。
```

---

## 2. 设计目标

> **每一次执行都为系统贡献持久知识，而非随 workspace 消亡。**

四个核心能力：
1. **执行归档** — workspace 删除前，自动提取并持久化执行摘要 + token + 诊断信号
2. **诊断提取** — 从 DB 聚合 + JSONL 日志中程序提取结构性诊断信号
3. **Loop Dashboard** — 跨 workspace 的执行历史、成本追踪、趋势分析
4. **Agent 闭环** — 编排器注入执行记忆 + Hermes 双向交互 + 自主调度

---

## 3. "经验"是什么？——从 AI 工程化角度重新定义

### 3.1 核心洞察：Agent 需要规则，不需要指标

从真实执行数据出发，问一个关键问题：**什么信息能让 agent 在下一次执行时表现更好？**

以 `feat-acturator-enahnce` 工作空间的 `prd-impl` 执行为例，review 发现了 4 个 blocker：

```
B1: Tests missing scheduleRunDAO dependency
B2: ErrorTracker never injected in production code
B3: RecoveryResolver uses started_at instead of updated_at
B4: HealthResolver missing global 5s timeout
```

review-fix 节点花了 7 分钟修复。如果下次跑类似任务：

| 信息类型 | 示例 | Agent 能用吗？ |
|---------|------|--------------|
| 指标 | "review 发现 4 个 blocker" | ❌ 看不懂，不改变行为 |
| 指标 | "FragilityScore: review 0.3" | ❌ 看不懂，不改变行为 |
| 指标 | "implement 节点 318 tool calls" | ❌ 看不懂，不改变行为 |
| **规则** | "创建 actuator 测试时，必须在 setup 中导入所有 DAO 依赖 (ScheduleRunDAO, TokenUsageDAO)" | ✅ 直接遵守，避免 B1 |
| **规则** | "HealthResolver 的 Promise.allSettled 必须包 withTimeout(5000)" | ✅ 直接遵守，避免 B4 |
| **规则** | "actuator 端点不能仅依赖 x-real-ip 做 localhost 判断" | ✅ 直接遵守，避免安全警告 |

**结论：agent 需要的是规则和约束（imperative），不是指标和统计（descriptive）。**

### 3.2 知识文件格式：Markdown，不是 JSON/YAML

JSON/YAML 的问题：
- 加一个字段 → schema 变更 → 迁移 → 序列化/反序列化全改
- 对 LLM 不友好（需要解析结构才能理解）
- 不适合表达"规则"这种自然语言内容

Markdown 的优势：
- 加一条规则 → 追加一行文本
- LLM 原生理解，直接注入 prompt
- 规则天然适合用祈使句表达
- 人可直接编辑，不需要工具

### 3.3 知识的存储位置

```
~/.octopus/{org}/knowledge/           ← 全局持久（不随 workspace 删除）
├── xzf-dev-octopus.md                ← 项目级知识（跨工作流共享）
├── workflow-prd-impl.md              ← 工作流级知识
└── workflow-bug-hunter.md            ← 工作流级知识
```

**项目知识文件**（`xzf-dev-octopus.md`）：跨工作流共享的项目约束

```markdown
# 项目知识: xzf-dev-octopus

## 构建规则
- 修改 shared/ 后必须 `pnpm build -w shared` 再全量构建
- 构建命令: `pnpm build`
- 启动隔离服务: `pnpm dev --isolated`

## 测试
- 运行测试: `pnpm test`
- git-ops.test.ts 有已知环境相关失败，与代码改动无关，不需要修复
- 创建 actuator 测试时，必须导入并实例化 ScheduleRunDAO, TokenUsageDAO

## 已知陷阱
- HealthResolver 的 Promise.allSettled 必须包 withTimeout(5000)
- RecoveryResolver 的 stale 检测用 updated_at（不是 started_at）
- actuator 端点不能仅依赖 x-real-ip 做 localhost 判断

## 端口规则
- ⛔ 保护端口: 3000, 3001, 3098, 3099（用户开发环境，绝不触碰）
- 只允许 kill $vars.e2e_dev_pid 杀 e2e 隔离服务进程
```

**工作流知识文件**（`workflow-prd-impl.md`）：工作流特有的经验

```markdown
# 工作流知识: prd-impl

## 实现阶段
- P1 基础框架和 P2 详细诊断是最重要的阶段，各占 ~8 个任务
- implement 节点通常 30+ 分钟，是最大的 token 消耗点
- 拆分为 P1-P5 子阶段提交，每阶段独立 commit

## 审查阶段
- review 通常发现 4-6 个问题，大多数是依赖注入和超时相关
- 4 个 blocker + review-fix 会增加 ~7 分钟，如果实现阶段遵守已知规则可以避免

## E2E 阶段
- E2E 修复通常 1 轮即通过
- TC 都是 api_response/cli_output/file_content 类型（infrastructure 项目无 UI）
```

### 3.4 归档记录 vs 知识文件：职责分离

| 维度 | 归档记录（SQL） | 知识文件（Markdown） |
|------|----------------|---------------------|
| 用途 | Dashboard 指标、成本趋势、搜索 | Agent 注入、改变下次行为 |
| 读者 | 人（Dashboard）、程序（聚合查询） | AI Agent（直接读 prompt） |
| 内容 | 结构化数据（status、cost、duration） | 规则、约束、已知陷阱 |
| 更新方式 | 每次执行 INSERT | 每次执行追加新规则、衰减旧规则 |
| 生命周期 | 永久保留 | 累积进化，过时规则被移除 |
| 存储位置 | SQLite（execution_archive 表） | 文件系统（~/.octopus/{org}/knowledge/） |

**归档记录保留但瘦身**——只存指标（Dashboard 需要），不存"经验"：

```sql
CREATE TABLE execution_archive (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  total_cost_usd REAL,
  -- 节点耗时 profile (JSON: [{nodeId, durationMs, toolCallCount}])
  node_profile TEXT,
  -- 关键输出 (JSON: {conclusion, pr_url, completeness_score})
  key_outputs TEXT,
  -- 父子链
  parent_execution_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 4. 知识怎么产生？——执行 → 规则提取 → 写入知识文件

### 4.1 完整循环

```
工作流执行
  ↓
执行完成，ArchiveService 归档指标 → SQL (Dashboard 用)
  ↓
规则提取（LLM，这是 haiku 真正有价值的地方）:
  ├── 输入: review 的 blockers/warnings
  │         e2e 的失败用例和修复
  │         关键 vars_update 中的 conclusion
  ├── Prompt: "从以下执行结果中，提取 1-3 条具体规则，
  │            供下次执行同类任务的 agent 遵守。
  │            规则必须是 imperative（做X/不做Y），
  │            不是 descriptive（发生了X）"
  └── 输出: 新规则文本
  ↓
追加到知识文件:
  ~/.octopus/{org}/knowledge/{project}.md
  ~/.octopus/{org}/knowledge/workflow-{name}.md
  ↓
下次执行:
  Agent 读到这些规则 → 直接遵守 → 更少 blocker → 更快完成
```

### 4.2 规则提取的触发条件

不是每次执行都值得提取。触发条件：

| 条件 | 原因 |
|------|------|
| review 发现 blocker ≥ 1 | blocker 说明实现有遗漏，应该成为下次规则 |
| E2E 修复轮次 ≥ 2 | 多轮修复说明有系统性问题 |
| 安全警告 ≥ 1 | 安全问题必须成为硬规则 |
| 节点失败后重试成功 | 失败原因可能成为预防规则 |
| 全部成功且无异常 | **跳过**——成功执行不产生新规则 |

### 4.3 规则提取实现

```typescript
async function extractRules(
  execResult: ExecutionResult,
  logDir: string,
): Promise<string[]> {
  // 1. 收集提取素材
  const materials: string[] = []

  // Review blockers (从 lastOutput 提取)
  const reviewNode = execResult.nodes['review']
  if (reviewNode?.lastOutput) {
    const blockers = extractBlockers(reviewNode.lastOutput)
    if (blockers.length > 0) {
      materials.push(`Review blockers:\n${blockers.join('\n')}`)
    }
  }

  // E2E 修复轮次 (从 e2e-fix-round.jsonl 提取失败模式)
  const e2eFixLog = join(logDir, 'e2e-fix-round.jsonl')
  if (existsSync(e2eFixLog)) {
    const events = readJSONL(e2eFixLog)
    const fixRounds = events.filter(e => e.event === 'end').length
    if (fixRounds >= 2) {
      materials.push(`E2E 修复用了 ${fixRounds} 轮，检查测试覆盖是否有遗漏`)
    }
  }

  // 安全警告
  if (reviewNode?.lastOutput?.includes('Security Review')) {
    const warnings = extractSecurityWarnings(reviewNode.lastOutput)
    if (warnings.length > 0) {
      materials.push(`Security warnings:\n${warnings.join('\n')}`)
    }
  }

  if (materials.length === 0) return []  // 全部成功，不提取

  // 2. LLM 提取规则（haiku，~$0.01）
  const prompt = `从以下执行结果中，提取 1-3 条具体规则。
规则要求:
- 必须是祈使句（"做X" 或 "不做Y"）
- 必须足够具体，agent 读到后能直接遵守
- 不要写"建议"或"注意"，写"必须"或"禁止"

执行结果:
${materials.join('\n\n')}

输出格式（每条规则一行，无其他内容）:`

  const rules = await llmCall(prompt, 'haiku')
  return rules.split('\n').filter(r => r.trim().length > 0)
}
```

### 4.4 写入知识文件

```typescript
async function appendToKnowledgeFile(
  org: string,
  project: string,
  workflowName: string,
  rules: string[],
): Promise<void> {
  const knowledgeDir = join(os.homedir(), '.octopus', org, 'knowledge')
  await mkdir(knowledgeDir, { recursive: true })

  const date = new Date().toISOString().slice(0, 10)

  // 项目级知识
  const projectFile = join(knowledgeDir, `${project}.md`)
  const header = `# 项目知识: ${project}\n\n`
  const entry = `\n## ${date} ${workflowName}\n${rules.map(r => `- ${r}`).join('\n')}\n`

  if (!existsSync(projectFile)) {
    await writeFile(projectFile, header + entry)
  } else {
    await appendFile(projectFile, entry)
  }

  // 工作流级知识
  const wfFile = join(knowledgeDir, `workflow-${workflowName}.md`)
  const wfHeader = `# 工作流知识: ${workflowName}\n\n`
  const wfEntry = `\n## ${date} (${project})\n${rules.map(r => `- ${r}`).join('\n')}\n`

  if (!existsSync(wfFile)) {
    await writeFile(wfFile, wfHeader + wfEntry)
  } else {
    await appendFile(wfFile, wfEntry)
  }
}
```

### 4.5 知识衰减

知识文件不能无限增长。定期（每月或每 10 次执行后）用 LLM 整理：

```typescript
async function compactKnowledgeFile(filePath: string): Promise<void> {
  const content = await readFile(filePath, 'utf-8')
  const lineCount = content.split('\n').length

  // 超过 100 行时触发整理
  if (lineCount < 100) return

  const prompt = `整理以下知识文件:
1. 合并重复规则
2. 移除已过时的规则（引用已修复的 BUG 或已删除的代码）
3. 按主题分组（构建、测试、安全、已知陷阱）
4. 保留最近的 30 条最重要的规则

${content}`

  const compacted = await llmCall(prompt, 'haiku')
  await writeFile(filePath, compacted)
}
```

---

## 5. 知识怎么用？——注入 Agent Prompt

### 5.1 注入时机

引擎在执行 agent 节点前，自动读取相关知识文件并注入 prompt：

```
工作流开始
  ↓
引擎解析 agent 节点的 knowledge_scope:
  projects: ["$inputs.project_dir"]   ← 变量替换后: ["xzf-dev-octopus"]
  workflows: ["prd-impl"]
  ↓
读取知识文件:
  ~/.octopus/{org}/knowledge/xzf-dev-octopus.md     → 项目级规则
  ~/.octopus/{org}/knowledge/workflow-prd-impl.md    → 工作流级规则
  ↓
组装 context:

  "📋 项目知识 (xzf-dev-octopus):
   - 修改 shared/ 后必须 pnpm build -w shared 再全量构建
   - 创建 actuator 测试时，必须导入 ScheduleRunDAO, TokenUsageDAO
   - HealthResolver 的 Promise.allSettled 必须包 withTimeout(5000)
   - ⛔ 保护端口: 3000, 3001, 3098, 3099
   
   📋 工作流知识 (prd-impl):
   - implement 节点通常 30+ 分钟，拆分为 P1-P5 子阶段提交
   - review 通常发现依赖注入和超时相关问题"
  ↓
注入到 agent prompt 前面
  ↓
Agent 读到规则 → 直接遵守 → 更少 blocker → 更快完成
```

### 5.2 注入实现

```typescript
// packages/engine/src/engine.ts — agent 节点执行前
private async injectKnowledge(
  node: NodeDef,
  pool: VarPool,
): Promise<string> {
  if (!node.knowledge_scope) return ''

  const projects = resolveVar(node.knowledge_scope.projects, pool)
  const workflows = resolveVar(node.knowledge_scope.workflows, pool)

  const sections: string[] = []

  // 项目级知识
  for (const project of projects) {
    const filePath = join(knowledgeDir, `${project}.md`)
    if (existsSync(filePath)) {
      const content = await readFile(filePath, 'utf-8')
      sections.push(`📋 项目知识 (${project}):\n${content}`)
    }
  }

  // 工作流级知识
  for (const wf of workflows) {
    const filePath = join(knowledgeDir, `workflow-${wf}.md`)
    if (existsSync(filePath)) {
      const content = await readFile(filePath, 'utf-8')
      sections.push(`📋 工作流知识 (${wf}):\n${content}`)
    }
  }

  return sections.length > 0 ? sections.join('\n\n') + '\n\n---\n\n' : ''
}
```

### 5.3 价值验证：从真实数据看闭环

以 `feat-acturator-enahnce` 为例：

```
第 1 次执行 prd-impl (无知识注入):
  implement → review (4 blockers) → review-fix (7min) → ship
  总耗时: 117min

  提取规则:
  - "创建 actuator 测试时必须导入 ScheduleRunDAO 等 DAO 依赖"
  - "HealthResolver 必须包 withTimeout(5000)"
  - "RecoveryResolver stale 检测用 updated_at"
  - "actuator 端点用 TCP remoteAddress 而非 x-real-ip"

第 2 次执行 prd-impl (有知识注入):
  implement → agent 读到规则 → 直接遵守
  → review (0 blockers) → 跳过 review-fix → ship
  预计: 节省 ~7min + review-fix 的 token 成本

第 N 次执行:
  知识文件持续累积 → agent 越来越了解项目约束
  → 实现质量越来越高 → review 越来越轻 → 循环越来越快
```

这才是真正的 Loop：**执行 → 提取规则 → 注入规则 → 更好的执行 → 提取新规则 → Loop**

---

## 6. Hermes ↔ Octopus 双向交互

### 6.1 现状: 单向

```
Octopus → Hermes CLI → Telegram  (通知推送)
                          ↑ 只能看, 不能回复
```

### 6.2 目标: 双向

```
Telegram 用户发消息: "扫描 engine 包的 BUG"
       ↓
Telegram Bot (webhook 模式)
       ↓
Octopus Server: POST /agent/telegram/webhook
       ↓
Agent 处理:
  1. 识别意图 → bug-hunter
  2. 注入执行记忆上下文
  3. 创建 workspace + 执行
       ↓
Octopus → Hermes → Telegram:
  "🚀 已启动 bug-hunter (engine 包)
   📚 历史: 上次发现 1 个 P1, $3.20
   ⏱️ 预计 30-45 分钟, 会实时推送进度。"
```

### 6.3 Telegram 指令集

| 指令 | 动作 | 示例 |
|------|------|------|
| `扫描 <scope>` | 触发 bug-hunter | `扫描 engine` |
| `开发 <需求>` | 触发 feat-dev 工作流 | `开发 用户注册功能` |
| `状态` | 查询运行中的执行 | `状态` |
| `报告` | 最近 7 天执行摘要 + 成本 | `报告` |
| `经验 <关键词>` | 搜索历史经验 | `经验 CORS` |
| `注册 <工作流> <cron>` | Agent 自注册定时任务 | `注册 bug-hunter 每天2点` |
| `停止 <执行ID>` | 取消正在运行的执行 | `停止 abc123` |

### 6.4 实现方案

```typescript
// packages/server/src/routes/telegram.ts
app.post('/agent/telegram/webhook', async (c) => {
  const { message } = await c.req.json()
  
  // 转发给 Agent 处理
  const response = await agentService.processMessage({
    session_id: `telegram-${message.chat.id}`,
    message: message.text,
    source: 'telegram',
  })
  
  // 通过 Hermes 回复
  await hermes.send({
    target: `telegram:${message.chat.id}`,
    message: response.text,
  })
})
```

Hermes 需要从"通知工具"升级为"通信桥梁"——支持 webhook 接收 Telegram 消息并转发给 Octopus。

---

## 7. 自主运行的四个级别

### Level 0: 手动（现状）

```
用户手动创建 workspace → 手动选工作流 → 手动输入参数 → 手动查看结果
每一步都需要人在 web UI 上点击操作。
```

### Level 1: 消息触发（Hermes 双向后）

```
用户在 Telegram 说 "扫描 BUG"
  → Agent 自动创建 workspace + 执行
  → 实时推送进度到 Telegram
  → 完成后推送结果 + PR 链接
人只需发一条消息, 其余全自动。
```

### Level 2: 事件驱动（webhook 集成后）

```
git push → webhook → Agent 判断是否需要跑测试/扫描 → 自动执行
CI 失败 → Agent 分析日志 → 自动触发 bug-fixer
PR 合并 → Agent 触发回归测试 → 自动推送结果
由外部事件触发, 无需人参与。
```

### Level 3: 定时自治（Loop Engineering 目标）

```
┌──────────────────────────────────────────────┐
│                  Octopus Agent                │
│                                              │
│  ┌─────────┐    ┌──────────┐    ┌─────────┐ │
│  │ 观察    │───→│ 决策     │───→│ 执行    │ │
│  │ Observe │    │ Decide   │    │ Execute │ │
│  └─────────┘    └──────────┘    └─────────┘ │
│       ↑                              │       │
│       │         ┌──────────┐         │       │
│       └─────────│ 学习     │←────────┘       │
│                 │ Learn    │                 │
│                 └──────────┘                 │
└──────────────────────────────────────────────┘

观察 (Observe):
  - 读取 execution_archive 历史数据
  - 分析成功率、成本、耗时趋势
  - 识别重复模式 (同样的 BUG 反复出现)

决策 (Decide):
  - 该跑什么工作流？(基于项目状态 + 历史效果)
  - 什么参数最优？(基于历史 cost/success rate)
  - 需要通知谁？(基于结果严重度)

执行 (Execute):
  - 通过 Scheduler 注册 cron job
  - 自动创建 workspace + 执行工作流
  - Hermes 实时推送到 Telegram

学习 (Learn):
  - ArchiveService 自动归档执行结果
  - 程序提取诊断信号（FragilityScore、JSONL 分析）
  - 写入 execution_archive + 知识文件
  - 下次"观察"时读到这些诊断数据
```

**Observe 的三种触发方式**:

| 触发方式 | 时机 | 实现 |
|---------|------|------|
| 事件触发 | 每次归档完成后 | `DomainEventBus.emit('archive:complete')` → `ObserveService.analyze()` |
| 定时调度 | 每 6 小时 | Scheduler 内置 job `agent-observe`, cron `0 */6 * * *` |
| 用户触发 | Telegram "报告" 指令或 Agent 对话 | `Agent 对话 "最近怎么样"` → 触发 Observe |

### 7.1 一个具体的自主运行场景

```
[周一 02:00] Scheduler 触发 bug-hunter (Agent 上周自注册的)

[周一 02:45] bug-hunter 完成, 发现 2 个 P2 BUG
             → ArchiveService 自动归档
             → Hermes 推送: "发现 2 个 P2, 已归档, 成本 $2.80"

[周一 09:00] 用户打开 Telegram 看到通知
             → 回复: "修复这两个 BUG"
             → Agent 读取归档数据, 获取 BUG 详情
             → 自动触发 bug-fixer, 注入诊断上下文

[周一 10:30] bug-fixer 完成, 修复 2 个 BUG, 创建 PR
             → ArchiveService 自动归档
             → Hermes 推送: "2 个 BUG 已修复, PR: #5"

[周一 10:31] Agent 分析执行记忆:
             → 推送: "bug-hunter 连续 3 次都在 engine 包发现 BUG,
                      建议对 engine 做一次系统性审查, 要我安排吗?"

[周二 02:00] Scheduler 再次触发 bug-hunter
             → 这次未发现 BUG (上次的已修复)
             → ArchiveService 归档, 记录 "engine 包质量改善"
             → Agent 推送: "本次无 BUG, engine 包质量持续改善 ✅"
```

---

## 8. 架构设计

### 8.1 数据流总览

```
工作流执行完成
  ↓
ArchiveService.archiveExecution()
  │
  ├── Layer 1: DB 聚合 (复用 LogAnalysisService 已有方法, 免费)
  │   ├── execution summary (状态/耗时/节点结果)
  │   ├── token aggregation (按 model 汇总 cost, 来源: DB node_token_usages)
  │   ├── FragilityScore / FailureChain / CostSpike
  │   └── node_profile (从 {exec-id}.json 提取 durationMs + vars_update)
  │
  ├── Layer 2: JSONL 行为解析 (【新建】, 免费, 按需)
  │   ├── Top-3 耗时节点的 logs/{execution-id}/*.jsonl
  │   └── Tool 频率 / Read 重复 / Bash 失败 / vars_update 质量
  │
  └── Layer 3: LLM 反思 (可选, haiku $0.01)
      └── 仅 FragilityScore > 0.5 或 FailureChain > 2 时触发
  │
  ▼
execution_archive 表 (永久保留, 脱离 workspace 生命周期)
  │
  ├──→ Loop Dashboard API (健康度/成本分布)
  ├──→ Agent 编排器 (注入知识文件内容)
  └──→ Hermes 推送 (Telegram 通知)
  │
  ▼
workspace 可安全删除 (磁盘释放, 归档数据不受影响)
```

### 8.2 新增数据表: `execution_archive`

```sql
CREATE TABLE execution_archive (
  rowid         INTEGER PRIMARY KEY AUTOINCREMENT,  -- FTS5 需要 INTEGER PK
  id            TEXT NOT NULL UNIQUE,                -- 外部引用的 UUID

  -- 脱离 workspace 的独立记录
  org             TEXT NOT NULL DEFAULT '',
  workflow_ref    TEXT NOT NULL,
  workflow_name   TEXT NOT NULL,

  -- 执行摘要
  status          TEXT NOT NULL,          -- completed / failed / cancelled
  started_at      TEXT NOT NULL,
  completed_at    TEXT,
  duration_ms     INTEGER,

  -- 节点摘要 (JSON: [{nodeId, type, status, duration}])
  node_summary    TEXT NOT NULL DEFAULT '[]',

  -- 失败信息
  failed_nodes    TEXT,                   -- JSON array of failed node IDs
  error_message   TEXT,

  -- Token / 成本 (聚合)
  total_input_tokens   INTEGER NOT NULL DEFAULT 0,
  total_output_tokens  INTEGER NOT NULL DEFAULT 0,
  total_cost_usd       REAL NOT NULL DEFAULT 0,
  model_breakdown      TEXT,              -- JSON: {opus:{input,output,cost}, sonnet:{...}}

  -- 关键变量快照 (JSON: {requirement, pr_url, confirmed_bug, ...})
  vars_snapshot   TEXT NOT NULL DEFAULT '{}',

  -- LLM 提取的诊断（可选，仅复杂场景触发）
  diagnosis       TEXT,

  -- 关联
  workspace_archive_id TEXT,              -- 所属 workspace 归档
  chain_position      INTEGER,            -- 在链条中的位置 (0-based)
  parent_execution_id TEXT,               -- 父执行 (父子链)
  schedule_id         TEXT,               -- 如果由调度器触发
  clone_name          TEXT,               -- 产生此执行的分身名 (null=主Agent)

  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX idx_archive_org ON execution_archive(org);
CREATE INDEX idx_archive_workflow ON execution_archive(workflow_ref);
CREATE INDEX idx_archive_status ON execution_archive(status);
CREATE INDEX idx_archive_created ON execution_archive(created_at);
CREATE INDEX idx_archive_cost ON execution_archive(total_cost_usd);
```

### 8.3 Workspace 归档聚合层

一个 workspace 可能跑 N 个工作流，需要聚合层来保留链条关系：

```sql
CREATE TABLE workspace_archive (
  rowid         INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  org             TEXT NOT NULL DEFAULT '',

  -- workspace 原始信息 (快照)
  workspace_name  TEXT NOT NULL,
  workspace_path  TEXT,
  created_at      TEXT NOT NULL,
  archived_at     TEXT NOT NULL DEFAULT (datetime('now')),

  -- 聚合统计
  execution_count INTEGER NOT NULL DEFAULT 0,
  total_cost_usd  REAL NOT NULL DEFAULT 0,
  total_duration_ms INTEGER NOT NULL DEFAULT 0,

  -- 工作流链条 (JSON)
  -- [{from: "bug-hunter", to: "bug-fixer", type: "pipeline"},
  --  {from: "prd-forge", to: "prd-impl", type: "parent-child"}]
  execution_chains TEXT NOT NULL DEFAULT '[]',

  -- 工作流清单 (JSON)
  -- [{name: "bug-hunter", count: 2, cost: 6.40},
  --  {name: "bug-fixer", count: 1, cost: 3.20}]
  workflow_manifest TEXT NOT NULL DEFAULT '[]',

  -- LLM 总结 (workspace 级别的经验)
  summary         TEXT
);

CREATE INDEX idx_ws_archive_org ON workspace_archive(org);
CREATE INDEX idx_ws_archive_created ON workspace_archive(archived_at);
```

### 8.4 链条关系：三种场景

**场景 A: 流水线链**
```
workspace "daily-scan-0626":
  bug-hunter → 发现 BUG-001
    → bug-fixer → 修复 BUG-001, 创建 PR #5
      → regression-tester → 验证 PR #5 无回归

链条保留:
  - "PR #5 是哪个 bug-hunter 运行发现的" → 可追溯
  - "从发现 BUG 到修复完成的全链路耗时/成本" → 可统计
  - Agent 理解 "上次扫描→修复→测试的完整效果" → 可决策
```

**场景 B: 父子链**
```
workspace "prd-001":
  prd-forge → 产出 PRD 文档
    → prd-impl → 消费 PRD, 实现代码 ($parent.var_pool.output_dir)
      → prd-impl-e2e → 消费 prd-impl 的输出, 跑 E2E

通过 executions.parent_id 自动检测父子关系。
```

**场景 C: 独立并行**
```
workspace "multi-task":
  bug-hunter (独立) — 扫描 engine 包
  gen-workflow (独立) — 开发新工作流
  mvp-doc (独立) — 生成文档

无链条关系, 但属于同一 workspace, 聚合统计总成本。
```

### 8.5 链条自动检测

```
Layer 1: 程序检测 (免费)
  ├── executions.parent_id != '0' → 父子链
  ├── 工作流 inputs 中引用 $parent.var_pool.* → 数据依赖链
  ├── pipeline_state 表中的 chain 配置 → 流水线链
  └── 同一 workspace 内按 started_at 排序 → 时序链

Layer 2: 写入 workspace_archive 时构建
  ArchiveService.archiveWorkspace():
    1. 读取 workspace 内所有 executions
    2. 按 parent_id 构建父子树
    3. 按 started_at 排序构建时序
    4. 写入 workspace_archive.execution_chains
```

### 8.6 与现有表的关系

```
workspace_archive (独立, 聚合层)
  └── execution_archive[] (独立, 不依赖 workspace, 永久保留)
        ↑ 归档来源                    ↑ 经验同步
      executions (随 workspace 删除)   experiences (已有, 全局, FTS 搜索)
        ├── node_executions (删除)     evolution_log (已有, 全局)
        ├── node_token_usages (删除)
        └── execution_summaries (删除)
```

---

## 9. 功能模块详细设计

### Module 1: ArchiveService（执行归档服务）

**文件**: `packages/server/src/services/archive-service.ts`

```typescript
class ArchiveService {
  /**
   * 归档一次执行。在执行完成或 workspace 删除前调用。
   */
  async archiveExecution(
    executionId: string,
    wsArchiveId?: string  // 由 archiveWorkspace 传入，onComplete 调用时为空
  ): Promise<string> {
    // 1. 读取执行数据
    const execution = await execDAO.findById(executionId)
    const nodeResults = await nodeExecDAO.findByExecution(executionId)
    const tokenUsages = await tokenUsageDAO.findByExecution(executionId)

    // 2. 聚合 token/cost (Layer 1: 程序提取)
    const { totalInput, totalOutput, totalCost, modelBreakdown } =
      this.aggregateTokens(tokenUsages)

    // 3. 构建节点摘要
    const nodeSummary = nodeResults.map(n => ({
      nodeId: n.node_id, type: n.node_type,
      status: n.status, duration: n.duration,
    }))

    // 4. 提取关键变量 (Layer 2: 规则过滤)
    const varsSnapshot = this.extractKeyVars(nodeResults)

    // 5. 写入归档表
    const archiveId = generateId()
    await archiveDAO.insert({
      id: archiveId, org: execution.org,
      workflow_ref: execution.workflow_ref,
      workflow_name: execution.workflow_name,
      status: execution.status,
      started_at: execution.started_at,
      completed_at: execution.completed_at,
      duration_ms: execution.duration_ms,
      node_summary: JSON.stringify(nodeSummary),
      failed_nodes: execution.failed_nodes,
      error_message: execution.error_message,
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      total_cost_usd: totalCost,
      model_breakdown: JSON.stringify(modelBreakdown),
      vars_snapshot: JSON.stringify(varsSnapshot),
      workspace_archive_id: wsArchiveId || null,
      clone_name: execution.clone_name || null,
    })

    return archiveId
  }

  /**
   * 规则提取 + 送入审核队列
   * 
   * 注意: 规则的提取、审核、写入知识文件的完整流程已迁移到
   * docs/research/knowledge-system/ 独立文档。
   * 此方法只负责: 提取规则 → 送入审核队列 (pending_review 表)
   * 审核通过后的写入由 ReviewQueue.approveItem() 完成。
   * 
   * 详见:
   *   - 02-rule-extraction.md (提取逻辑)
   *   - 05-review-queue.md (审核队列)
   *   - 03-knowledge-injection.md (注入逻辑)
   */
  async proposeRulesForReview(archiveId: string): Promise<void> {
    const archive = await archiveDAO.findById(archiveId)
    const execResult = JSON.parse(
      await readFile(path.join(stateDir, `${archive.execution_id}.json`))
    )
    const logDir = path.join(workspacePath, 'logs', archive.execution_id)

    // 1. 提取规则 (02-rule-extraction.md §4)
    const rules = await extractRules(execResult, logDir)
    if (rules.length === 0) return

    // 2. 送入审核队列 (05-review-queue.md)
    for (const rule of rules) {
      const conflicts = await detectConflicts(rule, knowledgeDir)
      await pendingDAO.insert({
        id: generateId(),
        type: 'rule',
        source: 'workspace_archive',
        source_ref: archiveId,
        source_label: `${archive.workflow_name} ${archive.created_at?.slice(0, 10)}`,
        content: rule.text,
        target_file: `${rule.scope === 'workflow' ? 'workflow-' + rule.target : rule.target}.md`,
        scope: rule.scope,
        conflicts: JSON.stringify(conflicts),
        confidence: 0.5,
        auto_approve: 0,
        status: 'pending',
      })
    }

    log.info(`Proposed ${rules.length} rules for review from ${archive.workflow_name}`)
  }

  /**
   * 批量归档: workspace 删除前自动归档所有未归档的执行
   * 同时构建 workspace_archive 聚合层
   */
  async archiveWorkspace(workspaceId: string): Promise<number> {
    const workspace = await wsDAO.findById(workspaceId)
    const executions = await execDAO.findByWorkspace(workspaceId)

    // 构建链条关系
    const chains = this.detectChains(executions)
    const manifest = this.buildManifest(executions)

    // 创建 workspace_archive
    const wsArchiveId = generateId()
    await wsArchiveDAO.insert({
      id: wsArchiveId, org: workspace.org,
      workspace_name: workspace.name,
      workspace_path: workspace.path,
      created_at: workspace.created_at,
      execution_count: executions.length,
      execution_chains: JSON.stringify(chains),
      workflow_manifest: JSON.stringify(manifest),
    })

    // 归档每个执行, 关联到 workspace_archive
    let count = 0
    for (const exec of executions) {
      if (!exec.archived) {
        const archiveId = await this.archiveExecution(exec.id, wsArchiveId)
        // 写入 Agent daily memory
        const archive = await archiveDAO.findById(archiveId)
        await memoryService.appendToDaily(this.formatMemoryEntry(archive))
        count++
      }
    }

    // 聚合统计
    await wsArchiveDAO.updateStats(wsArchiveId)

    // workspace 级总结 (haiku, 异步, 仅 >= 3 个执行时)
    if (count >= 3) {
      this.generateWorkspaceSummary(wsArchiveId).catch(err => {
        log.warn(`Failed to generate workspace summary: ${err.message}`)
      })
    }

    return count
  }

  private async generateWorkspaceSummary(wsArchiveId: string) {
    const archives = await archiveDAO.findByWorkspaceArchive(wsArchiveId)
    const prompt = `用 3 句话总结以下工作流执行记录:
${archives.map(a => `- ${a.workflow_name}: ${a.status}, $${a.total_cost_usd}, ${a.duration_ms}ms`).join('\n')}`
    const summary = await llmCall(prompt, 'haiku')
    await wsArchiveDAO.update(wsArchiveId, { summary })
  }

  /**
   * 自动检测执行链条关系
   */
  private detectChains(executions: Execution[]): Chain[] {
    const chains: Chain[] = []
    for (const exec of executions) {
      // 父子链: parent_id != '0'
      if (exec.parent_id && exec.parent_id !== '0') {
        chains.push({ from: exec.parent_id, to: exec.id, type: 'parent-child' })
      }
      // 数据依赖链: inputs 引用 $parent.var_pool.*
      if (exec.input_values?.includes?.('$parent')) {
        chains.push({ from: 'parent', to: exec.id, type: 'data-dependency' })
      }
    }
    return chains
  }
}
```

### Module 2: Workspace 删除拦截（两阶段提交）

**修改**: `packages/server/src/services/workspace.ts` — `delete()` 方法

```typescript
async delete(id: string) {
  // Phase 1: 标记为 archiving (前端可展示归档中状态)
  await this.dao.update(id, { archive_status: 'archiving' })

  try {
    // Phase 2: 归档所有执行
    const archiveService = new ArchiveService()
    const archived = await archiveService.archiveWorkspace(id)
    log.info(`Archived ${archived} executions`)

    // Phase 3: 标记归档完成
    await this.dao.update(id, { archive_status: 'archived' })

    // Phase 4: 级联删除 (此时归档已完成且持久化)
    await this.dao.cascadeDeleteByWorkspace(id)
    await fs.promises.rm(workspacePath, { recursive: true, force: true })
  } catch (err) {
    // 归档失败 → 保留 workspace, 不删除, 标记失败
    await this.dao.update(id, { archive_status: 'archive_failed' })
    log.error(`Archive failed for workspace ${id}: ${err.message}`)
    throw new Error('Workspace archiving failed, deletion aborted. Data preserved.')
  }
}
```

新增 workspace 归档状态:

```sql
ALTER TABLE workspaces ADD COLUMN archive_status TEXT DEFAULT 'none';
-- none | archiving | archived | archive_failed
```

**恢复机制**: 定时任务扫描 `archive_status = 'archived'` 但文件仍存在的 workspace，重试文件删除。

### Module 3: Loop Dashboard API

**文件**: `packages/server/src/routes/archive.ts`

```
GET  /archive/stats              — 跨 workspace 的全局统计
GET  /archive/executions         — 归档执行列表 (分页/过滤/排序)
GET  /archive/executions/:id     — 归档执行详情
GET  /archive/cost-trends        — 成本趋势 (按天/周/月)
GET  /archive/workflow-stats     — 按工作流聚合的成功率/耗时/成本
GET  /archive/lessons            — 经验搜索 (FTS)
GET  /archive/leaderboard        — 排行榜 (最省钱/最快/最高成功率)
```

#### `/archive/stats` 响应

```json
{
  "total_executions": 156,
  "completed": 120, "failed": 30, "cancelled": 6,
  "total_cost_usd": 42.50,
  "avg_duration_ms": 1800000,
  "top_workflows": [
    { "name": "bug-hunter", "runs": 45, "success_rate": 0.73, "total_cost": 18.20 },
    { "name": "gen-workflow", "runs": 23, "success_rate": 0.87, "total_cost": 12.10 }
  ],
  "cost_today": 2.30, "cost_7d": 15.80, "cost_30d": 42.50
}
```

> **成本单位**: 存储统一用 USD（REAL 类型）。前端根据用户偏好设置 `currency_preference`（CNY/USD）和汇率（1 USD ≈ 7.2 CNY）转换显示。Dashboard 显示示例: `¥16.8 (≈$2.33)`。

### Module 4: Agent 闭环集成

#### 4.1 编排器增强

**修改**: `packages/server/src/services/agent/orchestrator-service.ts`

```typescript
async classifyAndRoute(message: string): Promise<RouteResult> {
  const intent = await this.classify(message)

  // 查知识文件 — 读取项目/工作流规则
  const knowledge = await knowledgeService.search(message)

  // 查 execution_archive — 仅取最近执行摘要 (不含经验文本)
  const recentRuns = await archiveDAO.findRecent({
    workflow_name: intent.matchedWorkflow,
    limit: 3,
    fields: ['status', 'total_cost_usd', 'created_at', 'vars_snapshot'],
  })

  if (experiences.length > 0) {
    intent.experiences = experiences.map(e => ({
      type: e.type, title: e.title, content: e.content,
    }))
  }
  if (recentRuns.length > 0) {
    intent.recentRuns = recentRuns
  }

  return intent
}
```

**职责分离**:
- `知识文件` → 项目/工作流规则（注入 Agent prompt）
- `execution_archive` → 执行记录统计（Dashboard + "上次跑了什么"）

#### 4.2 执行完成自动触发

```typescript
// packages/server/src/engine/execution-engine.ts
async onComplete(execution: Execution) {
  // 🔥 自动归档
  const archiveService = new ArchiveService()
  const archiveId = await archiveService.archiveExecution(execution.id)

  // 异步提取规则并送入审核队列 (不阻塞)
  archiveService.proposeRulesForReview(archiveId).catch(err => {
    log.warn(`Failed to propose rules: ${err.message}`)
  })
}
```

#### 4.3 Agent 自主调度

```typescript
// Agent 发现重复模式, 自注册调度
POST /agent/schedules/register
{
  name: "daily-bug-scan",
  cron: "0 2 * * *",
  timezone: "Asia/Shanghai",
  job_type: "workflow",
  workflow_ref: "bug-hunter",
  input_values: { project_dir: "open-octopus", min_severity: "P2" },
  notify_strategy: { on_success: true, on_failure: true, channel: "telegram:xzf_hermes" }
}
```

### Module 5: Telegram Bot 双向交互

**文件**: `packages/server/src/routes/telegram.ts`

```typescript
app.post('/agent/telegram/webhook', async (c) => {
  const { message } = await c.req.json()

  const response = await agentService.processMessage({
    session_id: `telegram-${message.chat.id}`,
    message: message.text,
    source: 'telegram',
  })

  await hermes.send({
    target: `telegram:${message.chat.id}`,
    message: response.text,
  })
})
```

**Hermes provider 层增加动态路由**（不修改 Hermes CLI 本身）：

```typescript
// packages/server/src/providers/hermes.ts
async send(config: NotifyConfig) {
  const target = config.target

  if (target.match(/^telegram:\d+$/)) {
    // 动态 chat ID → 直接调用 Telegram Bot API
    const chatId = target.split(':')[1]
    await telegramBotAPI.sendMessage(chatId, config.message)
  } else {
    // 命名 target (如 "telegram:xzf_hermes") → 走 Hermes CLI
    await hermesCLI.send(target, config.message)
  }
}
```

Hermes 从"通知工具"升级为"通信桥梁"——支持动态 chat ID 路由 + 命名 target 两种模式。

### Module 6: Agent 记忆/技能/分身系统整合

#### 6.1 现状：四套独立系统

```
系统 1: Agent 记忆 (文件系统 ~/.octopus/agent/memory/)
  ├── daily/2026-06-26.md    ← 对话级记忆
  ├── long-term.md            ← 压缩后的长期记忆
  └── daily/archive/          ← 归档

系统 2: 技能进化 (文件 + DB)
  ~/.octopus/agent/skills/*/SKILL.md + .bak
  DB: evolution_log + experiences

系统 3: 分身系统 (DB)
  DB: clones 表, 每个 clone 有独立 memory scope

系统 4: 执行记忆 (本设计新增)
  DB: execution_archive + workspace_archive + FTS
```

**问题**：四套系统互不知道对方的存在。执行诊断归档了但不进 Agent 记忆，Agent 记住了但不知道执行的 token 消耗，分身合并时不包含诊断数据。

#### 6.2 整合方案：数据流

```
                    execution_archive (原始数据)
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
      Agent 记忆      experiences   技能进化
      (文件系统)      (DB/FTS)     (SKILL.md)
            │            │            │
            ▼            ▼            ▼
      对话时召回     搜索时命中    执行时加载
```

#### 6.3 整合点 1：执行记忆 → Agent 每日记忆

执行归档后自动向 Agent 的 daily memory 写入摘要：

```typescript
// archive-service.ts
async archiveExecution(executionId: string) {
  // ... 归档逻辑 ...

  // 写入 Agent daily memory
  const memoryEntry = this.formatMemoryEntry(archive)
  await memoryService.appendToDaily(memoryEntry)
}

private formatMemoryEntry(archive: Archive): string {
  return `## 执行记录: ${archive.workflow_name}
- 状态: ${archive.status} | 耗时: ${formatDuration(archive.duration_ms)} | 成本: $${archive.total_cost_usd}
- 关键结果: ${archive.vars_snapshot.conclusion || '无'}
${archive.diagnosis ? `- 诊断: ${archive.diagnosis}` : ''}`
}
```

效果：Agent 的 daily memory 自动包含当天所有执行记录摘要。当 Agent 被问"今天做了什么"时能回答。

#### 6.4 整合点 2：执行记忆 → 长期记忆压缩

Agent 已有的 `session-compress-service` 每 7 天压缩 daily memory → long-term.md。执行记忆作为 daily memory 的一部分，自然被压缩进长期记忆：

```
daily/2026-06-26.md 包含:
  - 用户对话: "帮我扫描 engine 包"
  - 执行记录: bug-hunter 发现 P1 BUG, $3.20
  - 执行记录: bug-fixer 修复成功, 创建 PR #5
        │
        ▼ (7天压缩)
long-term.md 新增:
  "engine 包在 6 月 26 日发现并修复了 agent.ts 的 return→continue BUG,
   从发现到修复全链路耗时 2.5 小时, 总成本 $6.40。
   经验: swarm 节点的 host 输出必须兼容 vars_update 协议。"
```

#### 6.5 整合点 3：诊断信号 → 技能进化

当某个工作流反复产生类似的经验，触发技能进化：

```typescript
// evolution-service.ts — 已有 reflect() 方法
async reflect(): Promise<EvolutionSuggestion[]> {
  // 现有: 分析 daily memory 中的重复模式

  // 新增: 分析 execution_archive 中的重复模式
  const recentArchives = await archiveDAO.findRecent({ days: 7 })
  const patterns = this.detectPatterns(recentArchives)

  // 例: bug-hunter 连续 5 次都在 scan 节点失败
  // → 建议进化 octo-bug-investigation 技能
  //   增加 "agent 文件定位策略" 检查步骤
}
```

#### 6.6 整合点 4：分身 → 执行记忆隔离

分身系统感知执行记忆的归属：

```typescript
// clone 创建时 — memory_scope 支持 execution 过滤
{
  name: "bug-hunter-clone",
  memory_scope: ["execution:bug-hunter"],  // 只读 bug-hunter 的执行记忆
}

// clone 合并时 — 诊断数据合并到主 Agent
async mergeClone(cloneName: string) {
  // 现有: 合并记忆文件

  // 新增: 合并诊断数据到主 Agent 的知识文件
  const cloneArchives = await archiveDAO.findByClone(cloneName)
  for (const archive of cloneArchives) {
    if (archive.diagnosis) {
      await evolutionDAO.insertExperience({
        skill_name: archive.workflow_name,
        content: `[from clone:${cloneName}] ${archive.diagnosis}`,
        org: archive.org,
      })
    }
  }
}
```

#### 6.7 整合后的完整数据流

```
用户: "扫描 engine 包的 BUG" (Telegram)
  │
  ▼
Agent Orchestrator
  ├── 查询 execution_archive → "上次发现 P1, $3.20"
  ├── 查询 Agent memory → "上次 engine 扫描的上下文"
  ├── 查询知识文件 → "项目规则 + 工作流规则"
  └── 加载 skills → octo-bug-investigation (进化版)
  │
  ▼
创建 workspace + 执行 bug-hunter
  │
  ▼
执行完成 → ArchiveService
  ├── 写入 execution_archive (永久)
  ├── 写入 workspace_archive (聚合)
  ├── 写入 Agent daily memory (对话级)
  ├── 程序提取诊断信号 (FragilityScore + JSONL 分析)
  └── 写入知识文件 (规则追加, 见 §4.4)
  │
  ▼
7 天后 → session-compress
  ├── daily memory → long-term.md (压缩)
  └── 执行记录自然融入长期记忆
  │
  ▼
30 天后 → evolution reflect
  ├── 分析执行模式
  └── 建议技能进化 (如: 增加检查步骤)
  │
  ▼
下次执行时 → Agent 带着进化后的技能 + 长期记忆 + 诊断信号
  → 更好的决策 → 更好的结果 → 更准确的诊断信号 → Loop
```

#### 6.8 整合总结

| Agent 系统 | 整合方式 | 数据流向 |
|-----------|---------|---------|
| **每日记忆** | 执行归档后自动写入 daily memory | archive → daily/*.md |
| **长期记忆** | 通过 session-compress 自然压缩 | daily → long-term.md |
| **技能进化** | reflect() 分析执行模式, 触发进化 | archive → SKILL.md |
| **诊断搜索** | diagnosis 字段 (归档记录内) + 知识文件 (全文可搜索) | archive 表 + 文件系统 |
| **分身系统** | memory_scope 过滤执行记忆, merge 时合并 | archive ↔ clones |
| **编排器** | 分类时注入执行记忆上下文 | archive → orchestrator |

### Module 7: Knowledge Injection（执行时知识注入）

> 详细设计见 §5（知识怎么用）。此处仅列出与引擎的集成点。

#### 7.1 工作流 YAML 声明

agent 节点通过 `knowledge_scope` 字段声明需要注入哪些知识文件：

```yaml
- id: implement
  type: agent
  knowledge_scope:
    projects: ["$inputs.project_dir"]     # 注入项目知识文件
    workflows: ["$workflow.name"]         # 注入工作流知识文件
  prompt: |
    实现需求...
```

引擎在执行 agent 节点前调用 `injectKnowledge()`（§5.2），将知识文件内容注入 prompt 前面。

#### 7.2 知识文件位置

```
~/.octopus/{org}/knowledge/
├── xzf-dev-octopus.md       ← 项目级（跨工作流共享）
├── workflow-prd-impl.md     ← 工作流级
└── workflow-bug-hunter.md   ← 工作流级
```

### Module 8: Knowledge Compaction（知识文件整理）

知识文件不能无限增长。超过 100 行时用 LLM 整理（§4.5 的 `compactKnowledgeFile()`）：

```typescript
// 触发条件
async onKnowledgeUpdate(filePath: string): Promise<void> {
  const lineCount = (await readFile(filePath, 'utf-8')).split('
').length
  if (lineCount >= 100) {
    await compactKnowledgeFile(filePath)  // §4.5
  }
}
```

整理策略：
1. 合并重复规则
2. 移除已过时的规则（引用已修复的 BUG 或已删除的代码）
3. 按主题分组（构建、测试、安全、已知陷阱）
4. 保留最近的 30 条最重要的规则

### Module 9: ~~ChainTriggerService~~ (已删除)

> **已砍掉**。现有 `ChainEngine`（pipeline.yaml 树结构执行）+ Scheduler 的 `job_type: workflow` 模式已完整覆盖工作流链条触发，无需引入第二套触发机制。

---

## 10. 前端改动

### Dashboard 新增 "执行记忆" 标签页

```
┌─────────────────────────────────────────────────┐
│  Dashboard                                      │
│  [概览] [队列] [最近] [健康度] [执行记忆]        │
│                                                 │
│  ┌─── 成本趋势 (7天) ───────────────────────┐   │
│  │  📈 ~~~~ 折线图 ~~~~                     │   │
│  │  今日: ¥16.8 | 本周: ¥112 | 本月: ¥302  │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  ┌─── 工作流排行 ──────────────────────────┐    │
│  │ 🥇 bug-hunter    45次 73% ¥128         │    │
│  │ 🥈 gen-workflow  23次 87% ¥85          │    │
│  │ 🥉 prd-forge     12次 92% ¥45          │    │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  ┌─── 最近诊断信号 ─────────────────────────┐    │
│  │ 📝 bug-hunter: scan 节点 agent_loop_detected │    │
│  │ 📝 gen-workflow: condition_type_mismatch     │    │
│  │ 📝 bug-hunter: create-pr auth_error           │    │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## 11. 实现路线

| Phase | 内容 | 核心产出 | 优先级 |
|-------|------|---------|--------|
| **Phase 1** | 执行归档 | execution_archive 表 (瘦身: 只存指标) + ArchiveService + 两阶段删除 | 🔴 最高 |
| **Phase 2** | 规则提取 | extractRules() + appendToKnowledgeFile() (§4) — LLM 从执行结果提取规则写入 markdown | 🔴 最高 |
| **Phase 3** | 知识注入 | knowledge_scope 字段 + injectKnowledge() (§5) — 引擎读 markdown 注入 prompt | 🔴 最高 |
| **Phase 4** | 知识整理 | compactKnowledgeFile() (§4.5) — LLM 定期整理超长知识文件 | 🟡 高 |
| **~~Phase 5~~** | ~~链条触发~~ | ~~已砍掉~~ (pipeline 树 + Scheduler 已覆盖) | ❌ 删除 |
| **Phase 6** | Loop Dashboard | /archive/* API + 前端标签页 + 成本趋势 (USD 存储 + 前端汇率转换) | 🟡 高 |
| **Phase 7** | Agent 记忆整合 | 执行归档 → daily memory 同步 + session-compress 联动 | 🟡 高 |
| **Phase 8** | Agent 闭环 | 编排器读知识文件 + 技能进化联动 + Hermes 动态路由 | 🟡 高 |
| **Phase 9** | Telegram 双向 | Telegram Bot webhook + 指令集 + Hermes provider chat ID 路由 | 🟢 中 |
| **Phase 10** | 自主 Loop | Observe 三种触发 + Agent 自注册调度 + 模式识别 + 分身整合 | 🟢 中 |

### Phase 1 详细清单

1. `packages/server/src/db/schema.sql` — 新增 execution_archive 表 (瘦身: 只存指标)
2. `packages/server/src/db/dao/archive-dao.ts` — 新建 ArchiveDAO
3. `packages/server/src/services/archive-service.ts` — 新建 ArchiveService
4. `packages/server/src/services/workspace.ts` — 修改 delete() 为两阶段提交 (archiving → archived → cascade)
5. `packages/server/src/engine/execution-engine.ts` — 修改 onComplete 自动归档

### Phase 2 详细清单

6. `packages/server/src/services/rule-extractor.ts` — 新建 extractRules() (§4.3)
7. `packages/server/src/services/knowledge-writer.ts` — 新建 appendToKnowledgeFile() (§4.4)
8. `packages/server/src/services/archive-service.ts` — 新增 extractAndAppendRules() 方法

### Phase 3 详细清单

9. `packages/shared/src/types/workflow.ts` — NodeSchema 增加 knowledge_scope 字段
10. `packages/core-pack/presets/workflows/doc/workflow-schema.json` — schema 增加 knowledge_scope
11. `packages/engine/src/engine.ts` — 新增 injectKnowledge() 方法 (§5.2)

### Phase 4 详细清单

12. `packages/server/src/services/knowledge-compactor.ts` — 新建 compactKnowledgeFile() (§4.5)
13. Scheduler 内置 job `knowledge-compact` — 每周检查知识文件行数，超过 100 行触发整理

### ~~Phase 5 详细清单~~ (已删除)

~~16. `packages/shared/src/types/workflow.ts` — WorkflowSchema 增加 chain 字段~~
~~17. `packages/engine/src/engine.ts` — onComplete 增加链条触发逻辑~~

---

## 12. 与 Loop Engineering 的对齐

| Loop 构建模块 | 本设计如何补全 |
|---------------|---------------|
| **Memory/State** | execution_archive (指标, SQL) + 知识文件 (规则, Markdown); 执行 → 提取规则 → 注入 prompt → 更好的执行 → Loop |
| Automations | Scheduler 自动创建 workspace + 执行 + 归档 + 清理; Agent 自注册调度; 链条执行通过 pipeline 树 + ChainEngine 覆盖 |
| Skills | 知识文件累积进化 → reflect() 触发技能进化; 过期规则由 compactKnowledgeFile() 自动清理 |
| Connectors | Telegram Bot 双向交互; Hermes provider 支持动态 chat ID 路由 + 命名 target |
| Sub-agents | 编排器读知识文件做决策; agent 节点通过 knowledge_scope 注入项目级规则 |

> **核心转变**: 从 "执行→遗忘→冷启动" 到 "执行→提取规则→写入知识文件→注入 prompt→带规则执行→更少 blocker→更快的循环→Loop"
