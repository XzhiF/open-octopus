# 03 — Harness Controller + Detector Pipeline

## What to build
在 `packages/server/src/services/harness/` 创建 HarnessController 和 DetectorPipeline。4 个 P0 检测器。回调装饰器包装现有 EngineCallbacks。

## Blocked by
01 (shared types), 02 (engine callbacks)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: `HarnessController` 编排三层: DetectorPipeline → StrategyEngine → AgentDelegation
- [ ] AC2: `DetectorPipeline` 用 Proxy 包装 EngineCallbacks，拦截 onNodeEnd/onNodeRetry/onAgentEvent/onError
- [ ] AC3: `StupidRetryDetector` — 检测同节点重试 N 次且 errorHash 相同
- [ ] AC4: `ModelMismatchDetector` — 检测 400 错误匹配 vision/tool 不支持模式
- [ ] AC5: `ProcessConflictDetector` — onBeforeNode 时静态扫描 + 运行时 Wrapper 拦截
- [ ] AC6: `TimeoutCascadeDetector` — 有状态检测器，连续 N 个节点超时触发
- [ ] AC7: 检测器生命周期: per-execution 实例化，execution 结束时 destroy
- [ ] AC8: 每次检测产出 DiagnosisReport → 写入 harness_events 表 → 发送 SSE harness_diagnosis 事件

## Verification Method
**Verification type**: unit test + integration test

**Verification steps**:
1. 单元测试: 每个 Detector 输入模拟事件 → 验证 DiagnosisReport 输出
2. 集成测试: 创建会触发傻重试的 workflow → 验证 harness_events 表有 diagnosis 记录
3. SSE 测试: 验证 harness_diagnosis 事件通过 SSE 推送到客户端

**Pass criteria**: 4 个检测器全部正确触发 + SSE 事件正确推送
