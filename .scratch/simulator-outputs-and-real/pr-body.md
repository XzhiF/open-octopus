## Workflow Simulator — 轻量工作流模拟测试框架 (V1 + V2 + Optimization + Outputs Fix)

无需 LLM 调用即可验证 Octopus 工作流的编排逻辑。

### Development Iterations
| # | Feature | Date | Tickets | Summary |
|---|---------|------|---------|---------|
| 14 | workflow-simulator (V1) | 07-30 | 10/10 | 模拟器引擎 + CLI `simulate` 命令 |
| 15 | workflow-simulator-v2 | 07-30 | 3/3 | `octo-workflow-test` skill + CLI `test` 命令 |
| 16 | workflow-test-optimization | 07-30 | 2/2 | 直跑优先 (<2s) + SSE 智能过滤 |
| 17 | simulator-outputs-and-real | 07-30 | 5/5 | outputs 共享函数 + --real + fixture 修复 |

### V1: Simulator Engine
- 7 种 Mock Executor, 真实 Condition/Loop/DAG, VarPool 操作
- 4 种断言, 语法预检, 65 个测试, 5 个黄金工作流

### V2: Closed-Loop Testing
- `octo-workflow-test` skill — AI 生成 fixture + 自动修复闭环

### Optimization: 直跑优先 + SSE 事件转发
- 有 fixture → 直跑模拟器 (<2s), 无 fixture → agent 路径
- `forwardableSSEEvent()` 共享 helper, `tool_call`/`tool_result` 不再被吞

### Outputs Fix + --real
- **共享 `applyOutputsMapping()`** — 消除模拟器 vs 真实引擎行为差异
- 修复: `$last_output.field` (JSON.parse), `$exit_code`, `$vars.x = expr` (evaluateExpression)
- **`--real` 实现** — mock-factory 返回真实 BashExecutor/PythonExecutor (超时保护)
- **xzf-dev.test.yaml** — 2/2 scenario, 33/33 断言全绿

### E2E Verification (latest)
| AC | Condition | Status |
|----|-----------|--------|
| outputs 共享函数 | 22/22 单测 | ✅ |
| executor 行为不变 | 87/87 测试 | ✅ |
| xzf-dev 全通过 | 2/2, 33/33 | ✅ |
| 直跑 <2s | 0.952s | ✅ |
| simulate 不变 | 无回归 | ✅ |

### Changed Files
38 files changed, 5,825 insertions(+), 317 deletions(-)

| Package | Key Changes |
|---------|-------------|
| engine | simulator/ (7 files) + outputs-resolver integration |
| shared | outputs-resolver.ts + simulator schemas |
| cli | workflow.ts (simulate + test + direct run) |
| server | main-agent-route.ts (SSE smart filter) |
| core-pack | octo-workflow-test skill + xzf-dev.test.yaml |

<!-- MANUAL-START -->
<!-- MANUAL-END -->
