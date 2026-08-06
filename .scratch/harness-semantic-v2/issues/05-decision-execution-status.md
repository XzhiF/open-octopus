# 05 — DetectorPipeline Decision Execution + Harness Status Update

## What to build
DetectorPipeline 根据 Harness Agent 决策类型和节点类型执行对应操作：存储 pendingActions / pendingBlockActions，更新 harness_status。按节点类型分流：bash/python 用异步域/暂停域，agent 用 Tool 拦截域。

## Blocked by
01 — Shared Types + DB Migration
03 — Strategy Engine Routing Refactor
04 — AgentDelegationService Core-Pack Integration

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: fix_and_retry → varPoolPatches + harnessHint 存入 pendingActions
- [ ] AC2: guide_and_retry → harnessHint 存入 pendingActions
- [ ] AC3: reconfigure_and_retry → modelOverride 存入 pendingActions
- [ ] AC4: agent_takeover → pendingFailureAction: { action: "delegate" } + overrideResult 写入 DB
- [ ] AC5: block_node (同步域) → 保持现有 pendingBlockAction 逻辑
- [ ] AC6: 决策执行后更新 node_executions.harness_status（harness_modified / harness_executed / harness_blocked）
- [ ] AC7: 决策执行后更新 executions.harness_status（intervened / blocked / delegated）
- [ ] AC8: agent_events 记录包含 decision 字段（用于日志渲染）
- [ ] AC9: bash/python 节点走异步域/暂停域路径
- [ ] AC10: agent 节点的 Tool Interceptor 触发后走 Tool 拦截域路径（block → pause → guide → resume）

## Verification Method
**Verification type**: unit test + integration test

**Verification steps**:
1. `pnpm --filter @octopus/server test -- detector-pipeline` — 单元测试通过
2. 验证每种决策类型正确存储到对应的 pending map
3. 验证 harness_status 在 DB 中正确更新
4. 验证 agent_events 包含 decision 信息
5. 验证 bash/python 和 agent 节点走不同的处理路径

**Pass criteria**: 所有 5 种决策类型的存储和状态更新正确 + 按节点类型正确分流
