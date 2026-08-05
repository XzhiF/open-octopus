# 09 — Agent Delegation (Layer 3)

## What to build
Agent Delegation 服务: 当策略层无法处理时，委托给 Octopus 内置 Agent 分身进行深度分析和纠正。

## Blocked by
03 (detector pipeline), 04 (strategy engine — delegation is fallback)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: `AgentDelegationService.delegate()` 创建 agent session + 传入 DiagnosisReport + 上下文
- [ ] AC2: Agent 分身分析错误 → 生成干预方案 → 执行干预
- [ ] AC3: 创建虚拟 `node_execution` (type: "harness_agent") 关联 token
- [ ] AC4: Token 记录: `source = "harness"` 写入 `node_token_usages`
- [ ] AC5: 干预完成后通过 `engine.retryFrom()` 恢复 workflow 执行
- [ ] AC6: Agent 分身超时保护 (max 5min) + 失败时标记节点为 failed
- [ ] AC7: SSE 事件: harness_delegation (开始/完成/失败)

## Verification Method
**Verification type**: integration test

**Verification steps**:
1. 创建会触发策略层无法处理的复杂错误的 workflow
2. 验证 Agent Delegation 被触发
3. 验证 agent session 创建 + 分析 + 干预
4. 验证 token 记录 source="harness"
5. 验证 workflow 恢复执行

**Pass criteria**: 完整的 delegate → analyze → intervene → resume 流程工作
