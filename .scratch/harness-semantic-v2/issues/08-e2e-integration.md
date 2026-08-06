# 08 — E2E Integration Tests

## What to build
端到端测试验证完整的 harness 语义修正流程，包括 bash/python 和 agent 节点。

## Blocked by
01 — 07, 09, 10 所有前置票据

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: test-process-conflict 执行后: 节点 blocked + 执行 harness_status = "blocked" + 日志显示阻断
- [ ] AC2: test-stupid-retry 执行后: Harness Agent 介入 + harness_status = "intervened" + 日志显示修复
- [ ] AC3: test-timeout-cascade 执行后: Harness Agent 介入（非 advisory） + 日志显示指导重试
- [ ] AC4: agent 节点危险操作测试: tool interceptor 拦截 → 指导 → resume → 节点 completed
- [ ] AC5: 执行列表 API 返回正确的 harnessStatus 字段
- [ ] AC6: agent_events 包含正确的 decision 字段
- [ ] AC7: Harness Agent session 跨多次干预保持上下文

## Verification Method
**Verification type**: E2E test

**Verification steps**:
1. 启动 `pnpm dev`
2. 通过 API 触发 3 个 bash 测试工作流执行
3. 通过 API 触发 agent 节点测试工作流（包含危险 bash tool call）
4. 等待执行完成
5. 通过 API 查询执行结果 + DB 验证 harness_status
6. 查询 agent-events 验证 decision 字段
7. 验证 Harness Agent session 日志

**Pass criteria**: 4 个测试工作流全部按预期行为执行
