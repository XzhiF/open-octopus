# 06 — Agent 全局闭环

## 1. Agent 是统一大脑

不管从哪个渠道触发执行，Agent 都是同一个大脑。知识系统是这个大脑的"规则手册"。

```
┌── 输入渠道 ──────────────────────────────────────┐
│                                                   │
│  Dashboard Chat ──┐                               │
│  Telegram ────────┤                               │
│  Scheduler ───────┤──→ Octopus Agent ──→ 执行     │
│  CLI ─────────────┤     (统一大脑)                 │
│                                                   │
│  所有渠道共享:                                      │
│  - 同一套记忆 (daily + long-term)                  │
│  - 同一套知识 (knowledge files)                    │
│  - 同一套 SKILL (skill library)                    │
│  - 同一个审核队列 (pending review)                  │
│                                                   │
└───────────────────────────────────────────────────┘
```

## 2. Agent 认知系统全景

```
┌─ Octopus Agent ────────────────────────────────────────────┐
│                                                             │
│  ┌─── 认知层 ──────────────────────────────────────────┐   │
│  │                                                      │   │
│  │  记忆 (Memory) — 发生了什么                          │   │
│  │    daily/*.md ──→ long-term.md                       │   │
│  │    产生: 每次对话自动                                 │   │
│  │    注入: Agent 对话时召回                             │   │
│  │                                                      │   │
│  │  知识 (Knowledge) — 应该怎么做              🆕       │   │
│  │    user_preference.md                                │   │
│  │    {project}.md + workflow-{name}.md                 │   │
│  │    index.md                                          │   │
│  │    产生: extractRules + 人审核                       │   │
│  │    注入: Agent 执行时 (三级加载)                      │   │
│  │                                                      │   │
│  │  SKILL — 怎么完成复杂任务                            │   │
│  │    SKILL.md (策划过的流程)                            │   │
│  │    experiences/ (原始素材)                            │   │
│  │    产生: 策划 + 人审核                               │   │
│  │    注入: Agent 加载 SKILL.md                         │   │
│  │                                                      │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─── 能力层 ──────────────────────────────────────────┐   │
│  │                                                      │   │
│  │  对话 (Chat) — 交互入口                              │   │
│  │    自然语言 → 意图识别 → 调度执行                     │   │
│  │                                                      │   │
│  │  分身 (Clones) — 并行执行                            │   │
│  │    独立 memory scope + 合并回主 Agent                │   │
│  │                                                      │   │
│  │  任务 (Tasks) — 调度执行                             │   │
│  │    手动触发 + Scheduler 自动触发                      │   │
│  │                                                      │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─── 进化层 ──────────────────────────────────────────┐   │
│  │                                                      │   │
│  │  审核队列 (Review Queue)                   🆕       │   │
│  │    待审核规则 + 待纳入 Skill                          │   │
│  │    AI 助手辅助审核                                    │   │
│  │                                                      │   │
│  │  数据流:                                              │   │
│  │    执行完成 → extractRules() → 审核队列 → 知识文件   │   │
│  │    对话完成 → 提议 Skill  → 审核队列 → SKILL 库      │   │
│  │    行为模式 → 检测 Skill  → 审核队列 → SKILL 库      │   │
│  │                                                      │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## 3. 闭环数据流

```
        ┌─────────────────────────────────────────────┐
        │                                             │
        ▼                                             │
   工作流执行                                         │
        │                                             │
        ▼                                             │
   执行完成 → ArchiveService                          │
        │         │                                    │
        │         ├──→ execution_archive (指标, SQL)   │
        │         │                                    │
        │         └──→ extractRules()                  │
        │                   │                          │
        │                   ▼                          │
        │              审核队列                        │
        │                   │                          │
        │          ┌────────┼────────┐                 │
        │          ▼        ▼        ▼                 │
        │       知识文件  SKILL 库   拒绝              │
        │          │        │                          │
        │          ▼        ▼                          │
        │    下次执行时注入 ←┘                          │
        │          │                                    │
        │          ▼                                    │
        │    Agent 带着知识执行                          │
        │          │                                    │
        │          ▼                                    │
        └──── 更好的结果 → 新的记忆 → Loop ────────────┘
```

## 4. 各渠道的行为差异

| 渠道 | 执行 | 规则提取 | 审核 |
|------|------|---------|------|
| Dashboard Chat | 正常执行 | extractRules → 审核队列 | 弹窗 (auto) |
| Telegram | 正常执行 | extractRules → 审核队列 | 积累 (background) |
| Scheduler | 正常执行 | extractRules → 审核队列 | 积累 (background) |
| Agent 对话中 | 正常执行 | extractRules → 对话中提议 | inline |
| CLI | 正常执行 | extractRules → 审核队列 | 积累 (background) |

## 5. 分身与知识的关系

分身（Clone）系统需要感知知识归属：

```typescript
// Clone 创建时 — memory_scope 支持 knowledge 过滤
{
  name: "bug-hunter-clone",
  memory_scope: {
    knowledge: ["project:octopus"],  // 只加载 octopus 项目的知识
    memory: "scoped",                // 独立记忆
  },
}

// Clone 合并时 — 知识规则合并到主 Agent
async function mergeClone(cloneName: string) {
  // 合并记忆（已有）
  await mergeMemory(cloneName)

  // 合并执行产生的新规则
  const cloneRules = await getCloneKnowledge(cloneName)
  for (const rule of cloneRules) {
    // 新规则进入审核队列（不自动合并）
    await pendingDAO.insert({
      type: 'rule',
      source: 'clone_merge',
      source_ref: cloneName,
      content: rule.text,
      target_file: rule.target_file,
      confidence: 0.7,
    })
  }
}
```

## 6. 技能进化与知识的关系

现有 `evolution-service.ts` 的 `reflect()` 方法分析 daily memory 中的重复模式，触发技能进化。

知识系统增加一个新的输入源：

```typescript
// evolution-service.ts — reflect() 增强
async function reflect(): Promise<EvolutionSuggestion[]> {
  // 现有: 分析 daily memory 中的重复模式
  const memoryPatterns = await analyzeMemoryPatterns()

  // 新增: 分析知识文件中的高频规则
  const knowledgePatterns = await analyzeKnowledgePatterns()
  // 例: octopus.md 中有 5 条关于"测试依赖"的规则
  //   → 建议进化 octo-test-setup Skill
  //      增加 "自动检查 DAO 依赖链" 步骤

  return [...memoryPatterns, ...knowledgePatterns]
}
```

## 7. 配置

在 Agent 配置中增加知识系统开关：

```typescript
// Agent config
{
  knowledge: {
    enabled: true,
    auto_extract: true,        // 执行完自动提取规则
    auto_inject: true,         // 执行前自动注入知识
    review_strategy: 'auto',   // auto | background | inline | auto_approve
    compact_threshold: 100,    // 知识文件超过此行数触发整理
  }
}
```

Workspace 级别可以覆盖：

```typescript
// workspace config.json
{
  knowledge_extraction: 'auto' | 'manual' | 'disabled',
}
```
