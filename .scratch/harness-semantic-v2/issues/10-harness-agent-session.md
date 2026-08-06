# 10 — Harness Agent Session Lifecycle

## What to build
实现 Harness Agent 的 session 生命周期管理：执行开始时创建 session，干预时追加上下文，执行结束时关闭。

## Blocked by
02 — Harness Agent Core-Pack Definition
04 — AgentDelegationService Core-Pack Integration

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: HarnessController.onExecutionStart() 创建 Harness Agent session（clone harness-agent）
- [ ] AC2: session 初始化上下文包含: workflow YAML + 节点列表 + 依赖图 + 变量池快照
- [ ] AC3: 每次干预时，DiagnosisReport + 当前状态作为 user message 追加到 session 对话
- [ ] AC4: session 跨多次干预保持上下文连贯（对话历史积累）
- [ ] AC5: HarnessController.onExecutionEnd() 关闭 session + 记录总结到 executions.harness_summary
- [ ] AC6: session 有 5 分钟单次超时保护
- [ ] AC7: 单元测试验证 session 创建/追加/关闭流程

## Verification Method
**Verification type**: unit test + integration test

**Verification steps**:
1. `pnpm --filter @octopus/server test -- agent-session` — 单元测试通过
2. Mock AgentService 验证 createSession 调用参数（包含 workflow YAML 等上下文）
3. 模拟多次干预 → 验证对话历史正确积累
4. 验证 onExecutionEnd 关闭 session + harness_summary 写入

**Pass criteria**: session 生命周期正确管理，上下文跨干预连贯
