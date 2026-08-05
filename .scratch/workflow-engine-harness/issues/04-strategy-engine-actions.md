# 04 — Strategy Engine + 5 种干预 Action

## What to build
StrategyEngine 从 harness.yaml 加载策略表，匹配 DiagnosisReport 并执行干预动作。5 种 action 实现。

## Blocked by
01 (shared types), 03 (detector pipeline produces DiagnosisReport)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: `StrategyEngine` 加载 harness.yaml 策略表，匹配 DiagnosisReport 的 detector 名称
- [ ] AC2: `inject_message` action — 调用 RepairService.intervene() 注入消息
- [ ] AC3: `agent_takeover` action — 创建 harness agent session 直接执行节点逻辑
- [ ] AC4: `modify_varpool` action — 调用 repair/varpool API 修改变量值
- [ ] AC5: `modify_definition` action — 修改 workflow YAML 定义 + reload
- [ ] AC6: `switch_model` action — 通过 onBeforeRetry 的 modelOverride 修改模型
- [ ] AC7: 策略匹配失败时委托给 Agent Delegation (Layer 3)
- [ ] AC8: 每次干预写入 harness_events 表 + 发送 SSE harness_intervention 事件

## Verification Method
**Verification type**: unit test + integration test

**Verification steps**:
1. 单元测试: 输入 DiagnosisReport → 验证策略匹配 → 验证 action 执行
2. 集成测试: 触发 stupid_retry → 验证 inject_message 执行 → 验证节点重试成功
3. 集成测试: 触发 model_mismatch → 验证 switch_model → 验证新模型被使用

**Pass criteria**: 5 种 action 全部可执行 + 策略匹配正确
