# 06 — Harness Evolution Integration

Type: grilling
Status: resolved
Blocked by: 01, 05

## Answer

**复用 EvolutionService.reflect()，加 scope 过滤参数**：
- Harness 经验与 agent/workflow 经验用同一套反思逻辑
- 定期 reflect 时按 scope 分组分析
- 不加独立的 HarnessEvolutionService
- reflect() 增加 scope 参数，可按 scope=harness 单独分析决策成功率

## Question

如何将 Harness 干预经验接入 EvolutionService 的反思和进化流程？

- harness 经验是否应该触发 SKILL.md 进化？
- reflect() 是否需要 harness 专用的分析逻辑？
- 经验提炼的频率和触发时机？
