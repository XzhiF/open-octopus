# 03 — Harness Clone Runtime Integration

Type: grilling
Status: resolved
Blocked by: 01

## Answer

**混合集成方案**：
- **Context 组装（统一层）**：加载 persona.md + clone long-term memory + FTS5 检索相似历史案例(≤5) + 当前诊断报告
- **对话管理（Harness 专用）**：保留 HarnessAgentSession 的多轮干预上下文累积 + 结构化 JSON 响应解析 + 5 种决策类型
- **经验持久化（统一层）**：干预结束后写 experiences 表(scope=harness) + clone daily memory + 触发 EvolutionService.reflect()

## Question

Harness Agent 已注册为内置 Clone（memoryScope: isolated），但运行时完全旁路 Clone 基础设施：
- 不加载 persona.md（用硬编码 prompt）
- 不写 clone memory
- 不用 CloneRuntime 或 SystemPromptAssembler

如何让它变成真正的 Clone？
- 干预结束时如何持久化经验到 clone memory？
- 干预开始时如何检索历史经验注入 prompt？
- HarnessAgentSession 和 CloneRuntime 的关系？
