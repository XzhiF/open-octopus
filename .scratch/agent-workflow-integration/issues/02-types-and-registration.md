# 02 — Shared Types + Version Resolver + octopus_agent Registration

## What to build
创建 octopus_agent 所需的全部共享类型定义、版本解析器、以及在 4 个注册点添加 octopus_agent 支持。这是 executor 和 UI 的前置条件。

## Blocked by
01 — Version Management Foundation (需要 VersionResolver 依赖 agent_versions 表)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: `packages/shared/src/types/octopus-agent.ts` 定义: OctopusAgentNodeDef, TaskContract, StructuredResult, AgentHeartbeat, HarnessDirective, BudgetConfig, HarnessConfig, OutputSchema, Artifact, VersionStage
- [ ] AC2: `packages/shared/src/types/workflow.ts` NodeDef.type 联合类型增加 `'octopus_agent'`
- [ ] AC3: `packages/shared/src/types/workflow.ts` NodeSchema Zod enum 增加 `'octopus_agent'`，含字段验证 (agent, version, min_stage, task{brief,context,constraints,expected_output,sop,budget}, harness{heartbeat_interval,heartbeat_timeout,auto_abort_on_budget})
- [ ] AC4: `packages/shared/src/version/version-resolver.ts` 实现 VersionResolver.resolve(agentName, versionSpec, minStage), compareVersions(), stageRank()
- [ ] AC5: `packages/engine/src/executor-factory.ts` switch 增加 `case "octopus_agent"`
- [ ] AC6: `packages/web-app/components/workspace/workflow-nodes/node-icon-config.ts` 增加 octopus_agent 的 icon/color/label 配置
- [ ] AC7: `packages/engine/src/executors/agent-types.ts` AgentEvent 联合类型增加 `{ type: 'heartbeat'; data: AgentHeartbeat }` 变体
- [ ] AC8: VersionResolver 对不存在的版本抛出 VersionNotFoundError，对 archived 版本跳过（除非精确指定）
- [ ] AC9: compareVersions 正确排序: 1.0.0-alpha.1 < 1.0.0-beta.1 < 1.0.0-rc.1 < 1.0.0

## Verification Method
**Verification type**: unit test + type check

**Verification steps**:
```bash
# 1. Type check
cd packages/shared && pnpm tsc --noEmit
# Expect: no errors

# 2. Unit test: version resolver
pnpm vitest run packages/shared/src/__tests__/version-resolver.test.ts
# Expect: latest/pinned/min_stage/archived 解析测试全部 PASS

# 3. Unit test: version comparison
pnpm vitest run packages/shared/src/__tests__/compare-versions.test.ts
# Expect: Maven-style comparison tests PASS

# 4. Zod schema validation
pnpm vitest run packages/shared/src/__tests__/octopus-agent-schema.test.ts
# Expect: valid/invalid YAML 验证测试 PASS

# 5. Executor factory registration
grep -n "octopus_agent" packages/engine/src/executor-factory.ts
# Expect: case statement present

# 6. Node icon config
grep -n "octopus_agent" packages/web-app/components/workspace/workflow-nodes/node-icon-config.ts
# Expect: entry present
```

**Pass criteria**: All 9 ACs pass, type check clean, unit tests green
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
