# 02 — 规则提取

## 1. 核心原则

**Agent 需要规则（imperative），不需要指标（descriptive）。**

| ❌ 没营养（一次性修复记录） | ✅ 有营养（决策捷径） |
|---|---|
| "ScheduleRunDAO 必须在 actuator 测试中导入" | "测试新建 DAO 相关代码时，先查 barrel export 确认依赖链完整" |
| "HealthResolver 包 withTimeout" | "所有 Promise.allSettled 聚合调用必须设全局超时" |
| "RecoveryResolver 用 updated_at" | "stale 检测一律用 updated_at，不用 started_at" |

左列是"修了一个 BUG"，右列是"以后遇到同类问题的通用策略"。

## 2. 触发条件

不是每次执行都值得提取规则。

| 条件 | 原因 | 提取策略 |
|------|------|---------|
| review 发现 blocker ≥ 1 | blocker 说明实现有遗漏 | 提取为规则 |
| E2E 修复轮次 ≥ 2 | 多轮修复说明系统性问题 | 提取为规则 |
| 安全警告 ≥ 1 | 安全问题必须成为硬规则 | 提取为规则 |
| 节点失败后重试成功 | 失败原因可能成为预防规则 | 提取为规则 |
| **全部成功且无异常** | 没有新的教训 | **跳过** |
| 同一 file_pattern + failure_type ≥ 2 次 | 重复踩坑 | **自动升级为规则**（不等审核） |

## 3. 提取素材来源

```
执行完成
  ↓
收集素材:
  ├── review 节点的 lastOutput
  │   → 提取 blockers 列表 (B1, B2, ...)
  │   → 提取 security warnings
  │
  ├── e2e-fix-round.jsonl
  │   → 修复轮次数 (≥ 2 轮 = 系统性问题)
  │   → 修复的具体 TC 列表
  │
  ├── 失败节点的 JSONL 日志
  │   → exit code + stderr 最后 N 行
  │   → agent 重试模式 (同一文件读取 ≥ 3 次)
  │
  └── vars_update 中的 conclusion
      → 关键输出 (pr_url, completeness_score)
```

## 4. LLM 提取实现

```typescript
async function extractRules(
  execResult: ExecutionResult,
  logDir: string,
): Promise<ProposedRule[]> {

  // 1. 收集素材
  const materials: string[] = []

  // Review blockers
  const reviewNode = execResult.nodes['review']
  if (reviewNode?.lastOutput) {
    const blockers = extractBlockers(reviewNode.lastOutput)
    // blockers: ["B1: Tests missing DAO deps", "B4: Missing timeout"]
    if (blockers.length > 0) {
      materials.push(`Review blockers:\n${blockers.join('\n')}`)
    }
  }

  // E2E 修复轮次
  const e2eFixLog = join(logDir, 'e2e-fix-round.jsonl')
  if (existsSync(e2eFixLog)) {
    const events = readJSONL(e2eFixLog)
    const fixRounds = countFixRounds(events)
    if (fixRounds >= 2) {
      materials.push(`E2E 修复用了 ${fixRounds} 轮`)
    }
  }

  // 安全警告
  if (reviewNode?.lastOutput?.includes('Security Review')) {
    const warnings = extractSecurityWarnings(reviewNode.lastOutput)
    if (warnings.length > 0) {
      materials.push(`Security warnings:\n${warnings.join('\n')}`)
    }
  }

  if (materials.length === 0) return []

  // 2. LLM 提取规则
  const prompt = `从以下执行结果中，提取 1-3 条可复用的规则。

规则要求:
- 必须是祈使句（"做X" 或 "不做Y"），不是描述句（"发生了X"）
- 必须足够通用：下次遇到类似情况时 agent 能直接遵守
- 不要写项目特定的修复（"ScheduleRunDAO 必须导入"）
- 要写通用策略（"测试 DAO 相关代码时先查 barrel export"）

执行结果:
${materials.join('\n\n')}

输出 JSON:
{
  "rules": [
    {
      "text": "规则文本（祈使句）",
      "scope": "project | workflow | global",
      "target": "项目名或工作流名",
      "source": "来源说明（哪个 blocker / 哪次 E2E 修复）"
    }
  ]
}`

  const result = await llmCall(prompt, 'haiku')
  return result.rules
}
```

## 5. 写入知识文件

注意：此函数**不在执行完成后直接调用**，而是在审核队列 approveItem() 时调用。
详见 [05-review-queue.md](./05-review-queue.md)。

```typescript
async function appendToKnowledgeFile(
  org: string,
  rules: ProposedRule[],
): Promise<void> {
  const knowledgeDir = join(os.homedir(), '.octopus', org, 'knowledge')
  await mkdir(knowledgeDir, { recursive: true })

  const date = new Date().toISOString().slice(0, 10)

  for (const rule of rules) {
    const fileName = rule.scope === 'workflow'
      ? `workflow-${rule.target}.md`
      : `${rule.target}.md`

    const filePath = join(knowledgeDir, fileName)

    // 确保文件存在并有标题
    if (!existsSync(filePath)) {
      const title = rule.scope === 'workflow'
        ? `# 工作流知识: ${rule.target}`
        : `# 项目知识: ${rule.target}`
      await writeFile(filePath, `${title}\n\n`)
    }

    // 生成规则 ID: {项目缩写}-{序号}
    const ruleId = await generateRuleId(filePath, rule.target)

    // 追加规则（统一格式：规则文本 + HTML 注释元数据）
    const entry = `\n- ${rule.text} <!-- id:${ruleId} | ${date} | ${rule.source} -->\n`
    await appendFile(filePath, entry)
  }

  // 更新 index.md
  await rebuildIndex(org)
}
```
```

## 6. 重复踩坑自动升级

Scheduler 场景下，同样的问题反复出现时，不等人工审核直接升级为规则：

```typescript
async function detectRecurringPitfalls(org: string): Promise<AutoRule[]> {
  const archives = await archiveDAO.findRecent({ org, days: 30 })
  const failures = archives.flatMap(a => a.review_blockers ?? [])

  // 按 file_pattern + failure_type 分组
  const groups = groupBy(failures, f => `${f.file_pattern}::${f.type}`)

  return Object.entries(groups)
    .filter(([, items]) => items.length >= 2)
    .map(([key, items]) => ({
      rule: `${items[0].file_pattern} 反复出现 ${items[0].type} 问题（共 ${items.length} 次）`,
      confidence: Math.min(items.length / 5, 1.0),
      autoApprove: items.length >= 3,  // 3 次以上自动通过
      source: 'recurring_pitfall',
    }))
}
```

## 7. 成本控制

| 场景 | 频率 | 成本 |
|------|------|------|
| LLM 规则提取 (haiku) | 有 blocker/安全警告时 | ~$0.01/次 |
| 重复踩坑检测 | 每周一次 (Scheduler) | $0（SQL 聚合） |
| index.md 重建 | 每次规则写入后 | $0（程序生成） |
| 知识整理 compact | 超 100 行时 | ~$0.01/次 |
