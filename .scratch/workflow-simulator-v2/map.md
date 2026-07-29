## Destination

A developer writes a workflow YAML and, in one step, gets it fully tested — an agent generates intelligent test fixtures (mock data + assertions), runs the simulator, interprets results, and iterates until all tests pass. The entire workflow testing lifecycle is closed-loop.

## Notes

- V1 delivered the simulator engine (mock executors, assertions, syntax checker, CLI command)
- V1 did NOT deliver: fixture generation, agent integration, closed-loop testing
- Workspace clone has `skills: []` (uses ALL global skills) — natural host for a new skill
- octo-workflow-dev skill covers workflow authoring but NOT testing
- CLI currently has no agent invocation — it's a pure local tool
- Server has clone-runtime with dual-path architecture (CLI → Main Agent → Clone delegation)

## Decisions so far

- [01-skill-design](./decisions/01-skill-design.md) — 独立 skill `octo-workflow-test`，workspace clone 自动继承
- [02-invocation-path](./decisions/02-invocation-path.md) — Workspace clone + skill，`@@workspace "测试工作流"`
- [03-mock-intelligence](./decisions/03-mock-intelligence.md) — 完整变量流图 + 7 种约束求解规则 + 11 个 swarm auto-vars + 6 个 gaps 识别
- [04-cli-agent-bridge](./decisions/04-cli-agent-bridge.md) — 复用现有 `POST /api/agent/chat { delegate_to: "workspace" }`
- [05-closed-loop-protocol](./decisions/05-closed-loop-protocol.md) — 全自动修复，最多 3 轮迭代，超出则交开发者

## Not yet specified

_(clear — all fog graduated to tickets and resolved)_

- Does the server need a dedicated "test workflow" API endpoint?
- How does the agent validate generated fixtures before running simulation?
- Should the agent also generate negative test scenarios (failure paths)?
- What's the iteration protocol when tests fail? Auto-fix or ask developer?
- Should the skill cover debugging simulation failures (interpreting assertion reports)?

## Out of scope

- Web UI test runner (future phase)
- CI/CD integration helpers (future)
- Parallel execution simulation (future)
- Swarm expert-level mocking (future)
