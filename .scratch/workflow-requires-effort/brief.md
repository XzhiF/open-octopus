# Requirement Brief

## Overview

Workflow 新增顶层 `requires` 声明 skills/agent_files 依赖，`_engine_init_` 优先使用声明、扫描兜底；agent 节点（顶层+子代理）打通 `effort` 传递到两个 SDK。

## Projects Involved

- [ ] @octopus/shared (schema + types)
- [ ] @octopus/engine (engine-init + executors)
- [ ] @octopus/providers (SDK 适配层)

## Feature Scope

**Do:**

- Workflow YAML 顶层新增 `requires` 块声明 skills 和 agent_files
- `_engine_init_` 优先 provision `requires` 中的资源，扫描作为兜底
- NodeDef 顶层 agent 节点新增 `effort` 字段
- SubAgentDef 的 `effort` 真正传递给 SDK
- 两个 provider (Claude SDK / Pi SDK) 都接收 effort 参数

**Don't:**

- 不改 workflow 级别的 effort 默认值
- 不改 skill 的运行时过滤逻辑
- 不改 hooks/extensions 注入系统

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | requires 结构 | `{ skills: string[], agent_files: string[] }` | 与 agent_files（非 agents）对齐，因为 agent_files 是资源文件 |
| 2 | _engine_init_ 策略 | requires 优先 + 扫描兜底 | 显式声明优先，扫描补漏 |
| 3 | effort 范围 | NodeDef 顶层 + SubAgentDef 都打通 | 两层都需要运行时推理深度控制 |
| 4 | effort 值类型 | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| number` | 与 SubAgentDef 现有定义保持一致 |

## Data Model Changes

| Table | Operation | Details |
|-------|-----------|---------|
| WorkflowSchema | 新增字段 | `requires: { skills?: string[], agent_files?: string[] }` |
| NodeDef | 新增字段 | `effort?: "low" \| "medium" \| "high" \| "xhigh" \| "max" \| number` |
| SendQueryOptions | 新增字段 | `effort?: EffortLevel` |
| ResourceManifest | 不变 | 保持 `{ agents: string[], skills: string[] }` |

## API Contracts

无外部 API 变更，仅内部 SDK 传递链路。

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| 1 | 工作流声明依赖 | YAML 可写 `requires.skills` 和 `requires.agent_files`，schema 验证通过 | Unit test: WorkflowSchema.parse() |
| 2 | init 优先声明 | `_engine_init_` 先 provision requires 中的资源，再扫描兜底 | Unit test: EngineInitPhase.run() 日志顺序断言 |
| 3 | 扫描兜底 | 未声明在 requires 中的资源仍会被扫描发现并 provision | Integration test: 缺资源 workflow 执行后资源存在 |
| 4 | agent effort 生效 | NodeDef.effort 值传递到 Claude SDK Options.effort | Unit test: ClaudeSDKProvider.sendQuery options 断言 |
| 5 | sub-agent effort 生效 | SubAgentDef.effort 传递到 AgentDefinition.effort | Unit test: toClaudeAgentDef 映射断言 |
| 6 | Pi SDK effort 生效 | effort 转换为 thinkingLevel 传递到 Pi SDK | Unit test: PiAgentProvider session options 断言 |

## Verification Strategy

### Global Config

- Environment: local dev
- Test user: N/A (engine-level change)
- Data prefix: N/A

### Per-layer Methods

#### Unit Tests

- `shared/__tests__/requires-schema.test.ts` — requires 字段 schema 验证
- `shared/__tests__/resource.test.ts` — ResourcePreFlight.analyze() 合并 requires + 扫描
- `engine/__tests__/engine-init.test.ts` — init 阶段优先声明 + 扫描兜底
- `providers/__tests__/effort-passthrough.test.ts` — effort 值传递到两个 SDK

#### Integration Tests

- 完整 workflow 执行：requires 声明 + 缺失资源 provision
- agent 节点带 effort 执行，验证 SDK 收到正确值

#### Manual Checklist

- [ ] 现有 workflow 不声明 requires 时仍正常工作（向后兼容）
- [ ] effort 未设置时 SDK 使用默认值（不传 effort 参数）

### Prerequisites

- [ ] `pnpm build` 成功
- [ ] 现有测试全绿

## Risks & Notes

- R1: requires 声明错误的资源名会导致 init 阶段报错（可接受，fail-fast）
- R2: effort 值在两个 SDK 间语义可能不完全对齐（Claude: effort, Pi: thinkingLevel），需做映射
- R3: 向后兼容 — requires 为可选字段，effort 为可选字段，不影响现有 workflow

## Glossary

| Term | Meaning |
|------|---------|
| requires | Workflow 顶层资源依赖声明（skills + agent_files） |
| effort | LLM 推理深度控制参数，值域 low/medium/high/xhigh/max |
| agent_files | .claude/agents/ 下的 .md 文件引用（资源级别） |
| skills | .claude/skills/ 下的目录引用，运行时作为过滤白名单 |
