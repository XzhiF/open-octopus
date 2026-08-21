# Brief: Task Authoring v3 — 两阶段任务编写 + 产出查看器

## Overview

把 TaskModal 重构为「模板页（类型 + Skill 组多选锁定 + 语境）→ 编写页（左 chat / 右产出查看器）」的两阶段流：Skill 组经 per-task plugin 目录获 SDK 原生加载，产物按任务家目录约定收集（登记不搬迁），编写期可运行内置辅助工作流（MoA 专家咨询等）并将结构化产出勾选采纳进 spec。

## Summary

- 19 个关键决策（D1-D14 设计决策 + D15-D19 Story Gap 修复；含 3 个新 ADR：0010 per-task plugin 目录 / 0011 任务家目录+登记不搬迁 / 0012 创建时锁定）→ [spec.md § Key Decisions](./spec.md)
- 14 条用户故事，全部绑定验证方法 → [spec.md § AC Mapping](./spec.md)
- Story Walk-Through 独立走查：16 断点全部合入（2 项经用户确认：辅助工作流宿主=临时 workspace、默认通用组=空标记）→ [story-walkthrough.md](./story-walkthrough.md)
- 验证策略门禁已闭环 → [decisions/01-grilling-verification-strategy.md](./decisions/01-grilling-verification-strategy.md)

## Risks

- R1: Windows symlink 兼容性 — junction 优先，失败降级 copy；materializer 单测覆盖三种路径
- R2: LLM 行为非确定性（agent 绑定/建议时机）— 自动断言只打机制层（API/SSE/FS），对话内容走 manual checklist
- R3: MoA 辅助工作流执行时长 — E2E 用最小专家配置；生产体验可并行
- R4: 第三方 skill 产物登记靠 agent 自觉 — artifacts.json schema 校验 + persona 指令约束
- R5: 创建顺序依赖前端纪律（先会话后任务）— integration 回归锁定（spec D15/R7）

## Full Spec

[spec.md](./spec.md)
