# 01 — Engine: swarm-in-loop support

**What to build:** Loop 节点内部支持 swarm 类型子节点。当前 loop.ts 的 createExecutor() 遇到 type="swarm" 直接 throw error。改为创建 SwarmExecutor 实例并执行。需要将 SwarmExecutor 所需的 4 个额外依赖（checkpointStore, executionId, hookExecutor, agentResolver）从 engine.ts 传递到 LoopExecutor，再传递到内部 SwarmExecutor。嵌套 LoopExecutor 时同步传递这些参数。

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] loop.ts: 删除 `throw new Error("swarm 节点不支持嵌套在 loop 内部")` 守卫
- [ ] loop.ts: constructor 增加 checkpointStore, executionId, hookExecutor, agentResolver 参数
- [ ] loop.ts: createExecutor() 增加 `case "swarm"` 分支，创建 SwarmExecutor 并传入所有参数
- [ ] loop.ts: 嵌套 LoopExecutor 时传递新增的 4 个参数
- [ ] engine.ts: 创建 LoopExecutor 时传入 checkpointStore, executionId, hookExecutor, agentResolver
- [ ] 测试: loop 内 swarm 节点能正常创建 SwarmExecutor（不 throw）
- [ ] 测试: 嵌套 loop 内 swarm 节点参数正确传递
- [ ] pnpm tsc --noEmit 无新增类型错误
- [ ] pnpm test 全量测试通过（现有测试不回归）
