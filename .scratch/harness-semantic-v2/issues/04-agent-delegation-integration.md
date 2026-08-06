# 04 — AgentDelegationService Core-Pack Integration

## What to build
改造 AgentDelegationService 从内联 LLM 调用改为通过 core-pack harness-agent 执行。

## Blocked by
01 — Shared Types + DB Migration
02 — Harness Agent Core-Pack Definition

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: AgentDelegationService 通过 AgentService.createSession('harness-agent') 创建 agent 会话
- [ ] AC2: 使用 DelegationContext 构建 prompt 传递给 agent session
- [ ] AC3: 解析 agent 输出为新版 DelegationResult（5 种决策类型）
- [ ] AC4: parseDelegationResponse() 验证 decision 字段在有效枚举内
- [ ] AC5: 5 分钟超时保护仍然有效
- [ ] AC6: Token 使用量记录到 node_token_usages (source='harness')
- [ ] AC7: 旧 interventionType 映射到新 decision 类型的兼容逻辑

## Verification Method
**Verification type**: unit test + integration test

**Verification steps**:
1. `pnpm --filter @octopus/server test -- agent-delegation` — 单元测试通过
2. Mock AgentService 验证 createSession 调用参数正确
3. 验证 5 种决策类型的 JSON 解析正确

**Pass criteria**: 所有测试通过 + agent session 创建成功
