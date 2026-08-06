# Brief: Harness Semantic V2 — 统一智能裁决与状态语义修正

## Overview
将 Harness 系统从"确定性规则执行"升级为"统一智能裁决"：所有检测到的问题统一路由到 Harness Agent（注册为 core-pack agent），由它决定修复/阻断/接管/继续，并在执行级补充双状态模型以清晰标记干预结果。

## Summary
- 6 个关键决策 → [spec.md § Key Decisions](./spec.md)
- 10 个验收标准 → [spec.md § Acceptance Criteria](./spec.md)
- 4 个核心故事验证 → [spec.md § Appendix](./spec.md)

## Risks
- R1: Harness Agent 调用增加 LLM 延迟（2-10s），对 critical 阻断场景可能有性能影响
- R2: agent_takeover 需要 Harness Agent 能执行实际工作（bash/python），安全边界需仔细设计
- R3: 策略层简化为路由层后，确定性快速路径（如 model_mismatch 直接切模型）的零延迟优势丢失

## Full Spec
[spec.md](./spec.md)
