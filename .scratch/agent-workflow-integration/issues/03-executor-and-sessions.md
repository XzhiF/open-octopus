# 03 — OctopusAgentExecutor + Delegate Sessions + Task Prompt Builder

## What to build
实现 OctopusAgentExecutor（组合模式包装 AgentExecutor）、delegate session 创建函数、Task Contract prompt 构建器、结构化结果解析器。这是 octopus_agent 节点的核心执行逻辑。

## Blocked by
02 — Shared Types + Version Resolver + octopus_agent Registration (需要类型定义和版本解析器)

## Status
done

## Acceptance Criteria
- [ ] AC1: `packages/engine/src/executors/octopus-agent.ts` 实现 OctopusAgentExecutor，使用组合模式持有 AgentExecutor 实例
- [ ] AC2: execute() 流程: resolveVersion → createDelegateSession → buildTaskPrompt → delegate to AgentExecutor → parseStructuredResult → return NodeExecutionResult
- [ ] AC3: Version resolution 失败时返回 `status: 'failed'` + error message（非 throw）
- [ ] AC4: `createDelegateSession()` 创建 session_type='delegate', clone_name, version, parent_execution_id
- [ ] AC5: `buildTaskPrompt()` 从 TaskContract 生成结构化 markdown prompt (Brief + Context + Constraints + Expected Output + SOP + Budget)
- [ ] AC6: Context 变量解析: `$vars.*` 和 `$nodeId.output.*` 从 VarPool 读取
- [ ] AC7: `parseStructuredResult()` 从 agent 输出文本中提取 JSON StructuredResult
- [ ] AC8: StructuredResult.vars_update 与 outputs mapping 统一处理（合并到 NodeExecutionResult.outputs）
- [ ] AC9: delegate session 执行完成后保留（可审计），不影响 clone 的直接对话 session
- [ ] AC10: 在 workflow YAML 中使用 octopus_agent 节点能正确执行并返回结果

## Verification Method
**Verification type**: integration test + E2E workflow execution

**Verification steps**:
```bash
# 1. Unit test: buildTaskPrompt
pnpm vitest run packages/engine/src/__tests__/octopus-agent/task-prompt.test.ts
# Expect: prompt 包含 Brief/Context/Constraints/Expected Output 各 section

# 2. Unit test: parseStructuredResult
pnpm vitest run packages/engine/src/__tests__/octopus-agent/parse-result.test.ts
# Expect: 正确提取 status/output/artifacts/vars_update/summary

# 3. Integration: delegate session creation
# 通过 API 执行包含 octopus_agent 节点的 workflow
curl -X POST http://localhost:3001/api/workspaces/:id/executions \
  -H 'Content-Type: application/json' \
  -d '{"workflow_ref":"test-octopus-agent","input_values":{}}'
# Expect: execution 成功完成

# 4. Verify delegate session
sqlite3 ~/.octopus/db/octopus.db \
  "SELECT session_type, clone_name FROM sessions WHERE session_type='delegate' ORDER BY created_at DESC LIMIT 1"
# Expect: delegate | workspace

# 5. Verify node result
sqlite3 ~/.octopus/db/octopus.db \
  "SELECT status, outputs FROM node_executions WHERE node_type='octopus_agent' ORDER BY started_at DESC LIMIT 1"
# Expect: completed | {structured output JSON}
```

**Pass criteria**: All 10 ACs pass, workflow execution E2E succeeds
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
