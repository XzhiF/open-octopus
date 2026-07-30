## Workflow Simulator — 轻量工作流模拟测试框架

无需 LLM 调用即可验证 Octopus 工作流的编排逻辑。4 次迭代：引擎 → 闭环 → 性能优化 → 行为一致性。

### Development Iterations
| # | Feature | Date | Tickets | Summary |
|---|---------|------|---------|---------|
| 14 | workflow-simulator (V1) | 07-30 | 10/10 | 模拟器引擎 + CLI `simulate` |
| 15 | workflow-simulator-v2 | 07-30 | 3/3 | `octo-workflow-test` skill + CLI `test` |
| 16 | workflow-test-optimization | 07-30 | 2/2 | 直跑优先 (<2s) + SSE 智能过滤 |
| 17 | simulator-outputs-and-real | 07-30 | 5/5 | outputs 共享函数 + `--real` + fixture 修复 |

### V1: Simulator Engine
- **7 种执行器**: MockAgent / MockSwarm / MockBash / MockPython / MockApproval + 真实 Condition / Loop
- **VarPool 真实运转**: `$vars.xxx` / `$node-id.output.xxx` / `$last_output` / `$iteration`
- **4 种断言**: status / vars / node_trace / node_outputs / logs
- **语法预检**: `bash -n` / `python compile()` (Windows 兼容 resolveBashPath)
- **87 个测试**: 单元 + 5 个黄金工作流集成测试

### V2: Closed-Loop Testing
- `octo-workflow-test` skill — AI 生成 fixture + 运行 + 自动修复 (3 轮闭环)
- Swarm auto-var 约束求解 — 扫描下游引用自动填充 mock

### Optimization: 直跑优先 + SSE 事件转发
- 有 fixture → 直跑模拟器 (**0.952s**, 无需 Server)
- 无 fixture → agent 路径 (workspace clone + skill)
- `--fix` 参数强制走 agent 智能修复
- `forwardableSSEEvent()` 共享 helper — `tool_call`/`tool_result` 不再被吞
- 消除 50+ 行重复代码

### Outputs Fix + --real
- **共享 `applyOutputsMapping()`** — 消除模拟器 vs 真实引擎 5 种表达式行为差异
- 修复: `$last_output.field` (JSON.parse), `$exit_code`, `$vars.x = expr` (evaluateExpression)
- 统一 4 个真实 executor 的 outputs 处理 (bash/agent/python/approval)
- **`--real` 实现** — mock-factory 返回真实 BashExecutor/PythonExecutor (超时保护)
- **xzf-dev.test.yaml** — 2/2 scenario, **33/33 断言全绿**

### E2E Verification (latest)
| AC | Condition | Status |
|----|-----------|--------|
| outputs 共享函数 | 22/22 单测 | ✅ |
| executor 行为统一 | 87/87 测试 | ✅ |
| xzf-dev 全通过 | 2/2, 33/33 | ✅ |
| 直跑 <2s | 0.952s | ✅ |
| simulate 不变 | 无回归 | ✅ |
| 语法检查 Windows | resolveBashPath | ✅ |

### Changed Files (全分支)
40+ files changed, ~6,000 insertions

| Package | Key Changes |
|---------|-------------|
| engine | `simulator/` 核心模块 (7 files) + outputs-resolver 集成 |
| shared | `outputs-resolver.ts` + simulator schemas |
| cli | `workflow.ts` (simulate + test + direct run + --fix) |
| server | `main-agent-route.ts` (SSE smart filter + forwardableSSEEvent) |
| core-pack | `octo-workflow-test` skill + `xzf-dev.test.yaml` |

<!-- MANUAL-START -->
<!-- MANUAL-END -->
