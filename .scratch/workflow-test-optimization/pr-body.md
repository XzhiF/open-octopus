## Workflow Simulator — 轻量工作流模拟测试框架 (V1 + V2 + Optimization)

无需 LLM 调用即可验证 Octopus 工作流的编排逻辑。V1 交付模拟引擎，V2 补全智能 fixture 生成闭环，Optimization 优化直跑性能与 SSE 可见性。

### Development Iterations
| # | Feature | Date | Tickets | Summary |
|---|---------|------|---------|---------|
| 14 | workflow-simulator (V1) | 07-30 | 10/10 | 模拟器引擎 + CLI `simulate` 命令 |
| 15 | workflow-simulator-v2 | 07-30 | 3/3 | `octo-workflow-test` skill + CLI `test` 命令 |
| 16 | workflow-test-optimization | 07-30 | 2/2 | 直跑优先 (<2s) + SSE 智能过滤 |

### V1: Simulator Engine
- **7 种 Mock Executor**: Agent / Swarm / Bash / Python / Approval
- **真实执行**: Condition / Loop / DAG 编排
- **VarPool 操作**: 变量替换、跨节点引用、`$iteration`
- **4 种断言**: status / vars / node_trace / node_outputs / logs
- **语法预检**: `bash -n` / `python compile()`
- **65 个测试**: 单元 + 5 个黄金工作流集成测试

### V2: Closed-Loop Testing
- `octo-workflow-test` skill — 分析 YAML → 生成 fixture → 运行 → 修复 (3轮)
- `octopus workflow test` CLI — 委托 workspace clone 执行闭环
- `octo-workflow-dev` §10 扩展引用

### Optimization: 直跑优先 + SSE 事件转发
- **直跑模式**: 有 `.test.yaml` 时直接调用 `runTestSuite()`，**<2s 出结果**，无需 Server
- **增强输出**: 📋 Syntax Check → ⚙️ Simulation → ✅ Assertions 三段式
- **`--fix` 参数**: 强制走 agent 路径进行智能修复
- **SSE 智能过滤**: 委托路径转发 `tool_call` + `tool_result` 事件（之前只转发 `text_delta`）
- **`forwardableSSEEvent()` 共享 helper**: 消除两个委托路径的代码重复

### E2E Verification
| AC | Condition | Status |
|----|-----------|--------|
| 直跑 <2s | 0.952s | ✅ |
| Phase 标题 | 三段均显示 | ✅ |
| --fix 提示 | 失败时显示 | ✅ |
| simulate 不变 | 输出格式无变化 | ✅ |
| SSE 单测 | 19/19 pass | ✅ |
| Build | pnpm build 成功 | ✅ |

### Changed Files
28 files changed, 4,882 insertions(+), 22 deletions(-)

| Package | Key Files | Change |
|---------|-----------|--------|
| engine | `simulator/` (7 files) | New: 模拟器引擎核心 |
| engine | `__tests__/simulator/` (6 files) | New: 65 个测试 |
| shared | `simulator/schemas.ts` | New: Zod schemas |
| cli | `commands/workflow.ts` | Modified: simulate + test 命令 |
| server | `routes/agent/main-agent-route.ts` | Modified: SSE 智能过滤 |
| server | `__tests__/should-forward-event.test.ts` | New: 19 tests |
| core-pack | `skills/octo-workflow-test/` | New: skill + reference |
| core-pack | `workflows/xzf-dev.test.yaml` | New: test fixture |

<!-- MANUAL-START -->
<!-- MANUAL-END -->
