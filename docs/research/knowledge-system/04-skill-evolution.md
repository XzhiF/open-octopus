# 04 — Skill 化

## 1. 三个 Skill 产出路径

| 路径 | 触发方式 | 时机 | 复杂度 |
|------|---------|------|--------|
| **4.1 工作流产出** | workspace 完成功能开发后 | 执行完成时 | 低 |
| **4.2 Agent 对话** | 用户与 Agent 完成某个功能后 | 对话结束时 | 低 |
| **4.3 行为模式** | 系统操作日志分析 | 定时分析 (Phase 10) | 高 |

所有路径产出的 Skill 都进入**待纳入列表**，等用户审批后才进入 SKILL 库。

## 2. 路径 4.1：工作流产出 → 功能使用 Skill

workspace 完成一个功能开发后，Agent 分析产出，提议一个"如何使用这个功能"的 Skill。

### 触发条件

- workspace 执行 prd-impl 或 feat-dev 类工作流
- 执行成功且有 PR 产出
- 用户未标记 `knowledge_extraction: disabled`

### 提取过程

```typescript
async function proposeSkillFromWorkspace(
  workspaceId: string,
): Promise<ProposedSkill | null> {
  const execResult = await getLatestExecution(workspaceId)
  if (execResult.status !== 'completed') return null

  // 收集素材
  const materials = {
    prd: await readPRD(workspaceId),
    plan: await readPlan(workspaceId),
    pr_description: await getPRDescription(execResult.pr_url),
    key_outputs: extractKeyOutputs(execResult),
  }

  const prompt = `基于以下功能开发结果，生成一个 Skill 草案。
这个 Skill 应该帮助 Agent 下次开发类似功能时复用经验。

PRD 摘要: ${materials.prd.slice(0, 500)}
实现计划: ${materials.plan.slice(0, 500)}
PR 描述: ${materials.pr_description.slice(0, 500)}
关键产出: ${JSON.stringify(materials.key_outputs)}

输出:
{
  "skill_name": "octopus-xxx",
  "category": "feature-guide | workflow-pattern | troubleshooting",
  "description": "一句话描述这个 Skill 做什么",
  "pattern": "流程步骤摘要",
  "keywords": ["关键词1", "关键词2"],
  "sections": {
    "使用场景": "什么情况下用这个 Skill",
    "流程": "分步骤描述",
    "关键约束": "必须遵守的规则",
    "参考实现": "指向 workspace / PR"
  }
}`

  return await llmCall(prompt, 'haiku')
}
```

### 产出格式

与现有 `~/.my-skill-helper/evolution/experiences/{name}.md` 格式对齐：

```markdown
---
skill_name: octopus-actuator-dev
category: feature-guide
created_at: 2026-06-23
created_from: feat-acturator-enahnce
pattern: 创建 actuator 健康检查端点的完整流程
keywords: [actuator, health-check, HAL, monitoring]
status: pending_review
---

## 使用场景
当需要为 Octopus 项目添加新的 actuator 端点时

## 流程
1. 在 actuator/ 目录创建 Resolver 类
2. 实现 GET 端点，返回 HAL 格式
3. 添加 localhost-only 安全中间件
4. 编写测试（必须导入完整 DAO 依赖链）
5. 更新 actuator 索引页添加新链接

## 关键约束
- Promise.allSettled 必须包 withTimeout
- stale 检测用 updated_at
- 不暴露敏感信息

## 参考实现
- workspace: feat-acturator-enahnce → PR #60
```

## 3. 路径 4.2：Agent 对话 → Skill

用户与 Agent 对话完成某个功能后，Agent 主动提议生成 Skill。

### 触发条件

- 对话中完成了有明确产出的任务（创建文件、修改代码、生成配置）
- Agent 判断这个操作模式有复用价值
- 用户在对话中未标记"不需要 Skill"

### 交互流程

```
用户: "帮我把 engine 包的 executor 都加上 retry 逻辑"
Agent: (经过 20 分钟对话，完成了 7 个 executor 的 retry)

Agent: "✅ 已为 7 个 executor 添加 retry 逻辑。
       
       这个操作模式可以复用——要生成一个 Skill 吗？
       
       📋 提议: 'octopus-executor-retry'
       - 覆盖: 为 executor 添加 retry 策略的标准流程
       - 步骤: 探查 executor → 设计 retry 配置 → 实现 → 测试
       
       [✅ 生成] [❌ 不需要] [✏️ 调整]"

用户: "✏️ 调整"
Agent: "请告诉我你想怎么调整？"
用户: "加上 exponential backoff 的配置说明"
Agent: "好的，已更新 Skill 草案: ..."
```

## 4. 路径 4.3：行为模式 → Skill（Phase 10）

最高级的路径：分析系统操作日志，检测用户的连贯性行为模式。

### 前提

需要系统操作日志收集（Phase 10 基础设施）：
- 用户在 Agent 对话中的操作序列
- 用户在 Dashboard 的操作序列
- 工作流执行的时序关系

### 检测逻辑

```typescript
async function detectBehaviorPatterns(
  org: string,
  days: number = 14,
): Promise<ProposedSkill[]> {
  const operations = await operationLogDAO.findRecent({ org, days })

  // 按用户 session 分组
  const sessions = groupBy(operations, o => o.session_id)

  // 检测重复的操作序列
  const patterns = detectRepeatedSequences(sessions, {
    minLength: 3,      // 至少 3 步
    minOccurrences: 2,  // 至少出现 2 次
  })

  return patterns.map(p => ({
    skill_name: generateSkillName(p),
    category: 'workflow-pattern',
    pattern: p.steps.map(s => s.action).join(' → '),
    confidence: p.occurrences / 5,
    source: 'behavior_detection',
    steps: p.steps,
  }))
}
```

### 示例

```
检测到的模式 (过去 14 天出现 3 次):
  1. "扫描 server 包 BUG" → bug-hunter 执行
  2. "修复发现的 BUG" → bug-fixer 执行
  3. "跑回归测试" → regression-tester 执行

→ 提议 Skill: 'bug-lifecycle'
  流程: scan → fix → test 完整生命周期
  置信度: 0.6 (3/5)
  状态: 待审核
```

## 5. 审批流程（统一入口）

所有路径产出的 Skill 都进入同一个待纳入列表。

```typescript
interface ProposedSkill {
  id: string
  skill_name: string
  category: string
  source: 'workspace_archive' | 'agent_conversation' | 'behavior_pattern'
  source_ref: string          // workspace ID / session ID / pattern ID
  content: string             // Markdown 内容
  confidence: number          // 0-1
  status: 'pending' | 'approved' | 'edited' | 'rejected'
  created_at: string
  reviewed_at?: string
  user_notes?: string
}
```

### 审批 UI

在 Dashboard 知识 Tab 的审核队列中展示（见 [07-ui-ux-design.md](./07-ui-ux-design.md)）。

用户可以：
- **✅ 纳入**：写入 SKILL 库
- **✏️ 编辑**：修改后纳入
- **🤖 讨论**：与 AI 助手讨论修改
- **❌ 拒绝**：不纳入

### 纳入操作

```typescript
async function approveSkill(proposed: ProposedSkill): Promise<void> {
  const skillDir = join(os.homedir(), '.octopus', org, 'skills', proposed.skill_name)
  await mkdir(skillDir, { recursive: true })

  // 写入 SKILL.md
  await writeFile(join(skillDir, 'SKILL.md'), proposed.content)

  // 更新状态
  await proposedSkillDAO.update(proposed.id, {
    status: 'approved',
    reviewed_at: new Date().toISOString(),
  })

  // 通知 Agent
  await agentService.notify(`新 Skill 已纳入: ${proposed.skill_name}`)
}
```

## 6. 与现有 SKILL 系统的整合

| 现有 | 新增 |
|------|------|
| `~/.claude/skills/{name}/SKILL.md` | 不变 |
| `~/.my-skill-helper/evolution/experiences/` | 作为 Skill 原始素材 |
| 手动创建 Skill | + 自动提议 + 审批流程 |
| Agent 加载 SKILL.md | 不变（知识注入时按需加载） |

**Skill 化不替代现有 SKILL 系统**，而是增加了一条自动发现 + 审批的产出路径。
