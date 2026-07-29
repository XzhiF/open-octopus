# Requirement Brief: Workflow Simulator

## Overview
A lightweight workflow simulation and testing framework for Octopus that allows developers to verify workflow correctness without real LLM calls or side effects — agent/swarm/approval/bash/python nodes are mocked while VarPool operations, condition evaluation, loop control, and DAG orchestration run for real.

## Projects Involved
- [x] @octopus/engine (core — new `simulator/` module)
- [x] @octopus/shared (test fixture Zod schemas)
- [x] octopus CLI (`workflow simulate` command)
- [ ] @octopus/server (future — REST API endpoint for web UI)
- [ ] @octopus/web-app (future — visual test runner UI)

## Feature Scope

**Do:**
- Full simulation default: ALL side-effect nodes mocked (agent, swarm, approval, bash, python)
- Real execution of logic nodes: condition (evaluateExpression), loop (while/break_when/max_iterations), DAG (depends_on, execute_when)
- VarPool operations are real: variable substitution, cross-node references (`$node-id.output.xxx`), `$vars.xxx`, `$last_output`, `$iteration`
- Paired YAML test fixtures (`workflow.test.yaml`) with multi-scenario support
- **Layer 1 — Syntax pre-check** (independent step): `bash -n` / `python compile()` on all script nodes before simulation. Static only, doesn't affect simulation.
- **Layer 2 — Optional real execution** (opt-in upgrade): specific bash/python nodes can be marked for real sandbox execution while all other nodes stay mocked
- 4 assertion types: status+vars, node execution trace, node outputs, log patterns
- Per-iteration mock data for loop inner nodes (array index = iteration)
- Swarm as whole mock (no per-expert mocking)
- Strict mode: all side-effect nodes must have explicit mock definitions
- CLI command: `octopus workflow simulate <yaml> [options]`
- Detailed test report with per-node pass/fail and timing

**Don't:**
- Real LLM calls during simulation
- Per-expert swarm mocking (future enhancement)
- Web UI test runner (future phase)
- Server REST API endpoint (future phase)
- CI/CD integration helpers (future — but JSON output format supports this)

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | Verification depth | Full simulation default (all side-effects mocked) | Zero side effects, completes in seconds. Closest to Temporal's TestWorkflowEnvironment. Orthogonal upgrades below. |
| 2 | Script validation | Independent syntax pre-check step (bash -n / python compile) | Runs BEFORE simulation as a static check. Does not affect simulation execution. Catches syntax errors for free. |
| 2b | Optional real execution | Mark specific bash/python nodes for real sandbox execution | Opt-in upgrade from full-sim baseline. Real execution in sandbox (5s timeout). All other nodes stay mocked. |
| 3 | Test fixture format | Paired YAML file (`*.test.yaml`) | Clean separation from workflow definition, multi-scenario support, consistent with Octopus YAML-first approach |
| 4 | Assertion types | All 4: status+vars, execution trace, node outputs, log patterns | Complete verification coverage for workflow development |
| 5 | Architecture location | `@octopus/engine/src/simulator/` module | Direct access to ExecutorFactory, WorkflowEngine internals; no extra package dependency |
| 6 | Default mock behavior | Strict — require explicit mock for all side-effect nodes | Forces deliberate thinking about each node; prevents silent gaps |
| 7 | Loop mock strategy | Per-iteration index (array = per-iter, object = all-iters) | Precise control over multi-iteration scenarios |
| 8 | Swarm mock strategy | Whole-node mock | Swarm internal orchestration is complex; testing final result is sufficient for most cases |
| 9 | CLI command | `octopus workflow simulate` | Consistent with existing `workflow run` / `workflow validate` naming |

## Architecture

### Module Structure

```
packages/engine/src/
├── simulator/
│   ├── index.ts              ← Public exports
│   ├── simulator-engine.ts   ← Core: wraps WorkflowEngine with mock factory
│   ├── mock-factory.ts       ← SimulatorExecutorFactory (extends ExecutorFactory)
│   ├── mock-executors.ts     ← MockAgentExecutor, MockSwarmExecutor, MockBashExecutor, MockPythonExecutor, MockApprovalExecutor
│   ├── test-runner.ts        ← Scenario executor (load fixture → run → assert)
│   ├── assertions.ts         ← Assertion engine (status, vars, trace, outputs, logs)
│   ├── syntax-checker.ts     ← bash -n / python compile() pre-check
│   └── types.ts              ← TestFixture, TestScenario, MockDef, AssertionDef, SimResult
├── engine.ts                 ← Unchanged
├── executor-factory.ts       ← Unchanged (simulator creates its own factory)
└── executors/                ← Unchanged
```

### Core Design: Three-Layer Execution Model

```
Phase 0: Parse workflow.yaml + workflow.test.yaml
         ↓
Phase 1: Syntax Pre-check (独立步骤, 不影响模拟)
         ├── 所有 bash 节点 → bash -n "$script"
         ├── 所有 python 节点 → python -c "compile(...)"
         └── 语法错误 → 立即报告, 不进入 Phase 2
         ↓
Phase 2: Simulation (默认全量 mock, 可选升级)
         ┌──────────────────────────────────────────┐
         │  SimulatorExecutorFactory                 │
         │                                           │
         │  默认 (全量模拟):                          │
         │    agent   → MockAgentExecutor             │
         │    swarm   → MockSwarmExecutor             │
         │    bash    → MockBashExecutor              │
         │    python  → MockPythonExecutor            │
         │    approval → MockApprovalExecutor         │
         │    condition → ConditionExecutor (真实)    │
         │    loop      → LoopExecutor (真实)         │
         │                                           │
         │  可选升级 (real_execution 列表):            │
         │    bash-1  → BashExecutor (沙箱真实执行)   │
         │    python-1 → PythonExecutor (沙箱真实执行)│
         └──────────────────────────────────────────┘
         ↓
Phase 3: Assertions (状态, 变量, 轨迹, 输出, 日志)
```

### Mock Executor Behavior

Each mock executor:
1. Reads mock definition from fixture
2. Performs variable substitution on mock output values (supports `$vars.xxx` in mock data)
3. Writes `outputs` to VarPool (via `pool.set()` / `pool.update()`)
4. Returns `NodeExecutionResult` with configured status, outputs, lastOutput
5. Logs mock execution details for log-pattern assertions

### Test Fixture Schema (TypeScript → Zod)

```typescript
interface TestFixture {
  scenarios: TestScenario[]
}

interface TestScenario {
  name: string
  inputs?: Record<string, string>     // Workflow inputs
  mocks: Record<string, MockDef>      // Per-node mock definitions
  real_execution?: string[]           // Node IDs to execute for real (bash/python only)
  assertions: AssertionDef            // What to verify after simulation
}

// Mock definition varies by node type
type MockDef = AgentMockDef | SwarmMockDef | BashMockDef | PythonMockDef | ApprovalMockDef | LoopMockDef

interface AgentMockDef {
  status?: "completed" | "failed"     // Default: completed
  output?: string                     // lastOutput
  outputs?: Record<string, any>       // Named outputs
  update_vars?: Record<string, any>   // Direct VarPool updates
  error?: string                      // Error message (when status=failed)
}

interface SwarmMockDef {
  status?: "completed" | "failed"
  output?: string
  outputs?: Record<string, any>
  update_vars?: Record<string, any>
  error?: string
}

interface BashMockDef {
  status?: "completed" | "failed"
  output?: string
  outputs?: Record<string, any>
  update_vars?: Record<string, any>
  exit_code?: number
  error?: string
}

interface PythonMockDef {
  status?: "completed" | "failed"
  output?: string
  outputs?: Record<string, any>
  update_vars?: Record<string, any>
  exit_code?: number
  error?: string
}

interface ApprovalMockDef {
  choice: string                      // Which option to select
  comment?: string                    // Optional comment
}

// Loop mock: contains inner node mocks, supports per-iteration arrays
interface LoopMockDef {
  iterations?: number                 // Expected iteration count
  nodes: Record<string, MockDef | MockDef[]>  // Inner node mocks
  // Array value = per-iteration (index = iteration number)
  // Object value = same for all iterations
}

interface AssertionDef {
  status?: "completed" | "failed" | "completed_with_failures" | "paused" | "cancelled"
  vars?: Record<string, any>          // Expected VarPool values
  node_trace?: {
    executed?: string[]               // Nodes that must have executed
    skipped?: string[]                // Nodes that must have been skipped
    order?: string[]                  // Expected execution order
  }
  node_outputs?: Record<string, {     // Per-node output assertions
    output?: string                   // lastOutput
    outputs?: Record<string, any>     // Named outputs
    status?: string                   // Node status
  }>
  logs?: Record<string, {             // Per-node log assertions
    contains?: string[]               // Log must contain these strings
    not_contains?: string[]           // Log must NOT contain these strings
  }>
}
```

## API Contracts

### CLI Command

```
octopus workflow simulate <workflow-yaml> [options]

Options:
  --test <path>         Path to test fixture (default: auto-discover <name>.test.yaml)
  --scenario <name>     Run a specific scenario (default: all scenarios)
  --strict              Fail if any side-effect node lacks a mock (default: true)
  --no-strict           Auto-pass nodes without mocks
  --verbose             Show detailed per-node execution log
  --json                Output results as JSON (for CI/CD integration)
  --real <node-ids...>  Override: execute these bash/python nodes for real
```

### Auto-Discovery

```
# Given workflow path, auto-discover test fixture:
workflow.yaml         → workflow.test.yaml
my-flow.yaml          → my-flow.test.yaml
path/to/workflow.yaml → path/to/workflow.test.yaml
```

### Output Format

```
Simulating: my-workflow.yaml
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✔ Scenario "happy path" (12ms)
  ✔ agent-1: completed [mocked, 1ms]
  ✔ condition-1: completed [real, case 0 → "process"]
  ✔ bash-1: completed [mocked, syntax OK]
  ✔ loop-1: completed [3 iterations, mocked inner nodes]
    ✔ iter 0: agent-analyze → completed [mocked]
    ✔ iter 1: agent-analyze → completed [mocked]
    ✔ iter 2: agent-analyze → completed [mocked]
  ✔ swarm-1: completed [mocked]
  ✔ Assertions:
    ✔ status = completed
    ✔ vars.final_result = "expected value"
    ✔ node_trace: [agent-1, condition-1, bash-1, loop-1, swarm-1]
    ✔ node_outputs.agent-1.output = "Generated response"

✖ Scenario "failure path" (8ms)
  ✔ agent-1: failed [mocked, error: "LLM timeout"]
  ✖ Assertions:
    ✔ status = failed
    ✖ vars.error_code = 500
      Expected: 500, Got: undefined

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Results: 1 passed, 1 failed (2 scenarios, 20ms total)
```

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| 1 | As a workflow developer, I can simulate a workflow without any LLM calls | Running `octopus workflow simulate wf.yaml` completes in <1s with zero API calls | Unit test: verify no provider calls during simulation |
| 2 | I can define mock outputs for agent/swarm nodes | Mock outputs appear in VarPool and are accessible via `$node-id.output.xxx` to downstream nodes | Integration test: verify VarPool contains mock data after node execution |
| 3 | I can verify workflow status after simulation | Assertion `status: completed` passes when all nodes succeed | Unit test: assertion engine validates status correctly |
| 4 | I can verify VarPool values after simulation | Assertion `vars.key: value` checks VarPool snapshot | Unit test: assertion engine validates var values |
| 5 | I can verify node execution order | Assertion `node_trace.order: [a, b, c]` validates execution sequence | Unit test: assertion engine validates trace order |
| 6 | I can verify node outputs | Assertion `node_outputs.node-id.output: "text"` checks lastOutput | Unit test: assertion engine validates node outputs |
| 7 | I can verify log patterns | Assertion `logs.node-id.contains: ["pattern"]` checks log lines | Unit test: assertion engine validates log patterns |
| 8 | Bash/python scripts are syntax-checked before simulation | `bash -n` / `python compile()` runs for all script nodes; errors are reported | Unit test: syntax checker catches known bad scripts |
| 9 | I can mark specific bash/python nodes for real execution | Nodes in `real_execution` list run in sandbox (5s timeout, no network) | Integration test: real bash node executes and produces output |
| 10 | Loop inner nodes can have per-iteration mock data | Array mock definitions map to iteration indices | Integration test: loop with 3 iterations uses correct mock per iteration |
| 11 | Condition nodes evaluate real expressions | `evaluateExpression()` runs for real with VarPool data | Integration test: condition with `$vars.score > 0.5` matches correctly |
| 12 | DAG dependencies are enforced | `depends_on` and `execute_when` are evaluated for real | Integration test: node with failed dependency is skipped |
| 13 | Missing mock definitions cause failure in strict mode | Undefined mock for side-effect node → error with clear message | Unit test: strict mode detects missing mocks |
| 14 | Test fixtures auto-discover from workflow path | `workflow.yaml` → `workflow.test.yaml` | Unit test: auto-discovery finds correct file |
| 15 | Multiple scenarios run independently | Each scenario gets fresh VarPool and node results | Integration test: scenario B not affected by scenario A |

## Verification Strategy — Simulator 自身的验证

### 验证哲学

我们在构建一个**测试工具**。验证工具自身的正确性需要三个层次：

```
Layer 1: 单元测试 — 每个组件的行为正确性（mock executor、断言引擎、语法检查器）
Layer 2: 黄金工作流 — 端到端集成测试，手算预期值，验证模拟=预期
Layer 3: Dogfooding — 用 simulator 验证 core-pack 中的真实工作流
```

### Layer 1: 单元测试 (目标覆盖率 ≥ 90%)

#### `assertions.test.ts` — 断言引擎

| 用例 | 输入 | 预期 |
|------|------|------|
| status 匹配 | actual=completed, expected=completed | PASS |
| status 不匹配 | actual=failed, expected=completed | FAIL, message 含实际值 |
| vars 匹配 | actual={a:1}, expected={a:1} | PASS |
| vars 缺失 | actual={}, expected={a:1} | FAIL, 报告缺失 key |
| vars 值错误 | actual={a:2}, expected={a:1} | FAIL, 报告期望 vs 实际 |
| node_trace.executed 全命中 | trace=[a,b,c], expected=[a,b] | PASS |
| node_trace.executed 缺失 | trace=[a,c], expected=[a,b] | FAIL, 报告缺失节点 b |
| node_trace.skipped 命中 | trace 中 b=skipped, expected_skipped=[b] | PASS |
| node_trace.order 正确 | trace=[a,b,c], expected_order=[a,b,c] | PASS |
| node_trace.order 乱序 | trace=[a,c,b], expected_order=[a,b,c] | FAIL, 报告顺序偏差 |
| node_outputs.output 匹配 | node-a.lastOutput="hi", expected="hi" | PASS |
| node_outputs.outputs 匹配 | node-a.outputs={x:1}, expected={x:1} | PASS |
| node_outputs 节点不存在 | expected node "z" 但无此结果 | FAIL, 报告节点未执行 |
| logs.contains 命中 | logLines=["hello world"], contains=["hello"] | PASS |
| logs.contains 未命中 | logLines=["hello"], contains=["bye"] | FAIL |
| logs.not_contains 命中 | logLines=["hello"], not_contains=["error"] | PASS |
| logs.not_contains 违规 | logLines=["error occurred"], not_contains=["error"] | FAIL |
| 多断言组合 | status+vars+trace 同时验证 | 全部 PASS 才整体 PASS |
| 空断言 | assertions: {} | PASS (无约束 = 通过) |

#### `mock-executors.test.ts` — Mock Executor 行为

| 用例 | Mock 类型 | 输入 | 预期 |
|------|----------|------|------|
| MockAgent 基本输出 | agent | output="hi", outputs={x:1} | NodeExecutionResult.status=completed, lastOutput="hi", outputs={x:1, output:"hi"} |
| MockAgent 变量写入 | agent | update_vars={score:0.9} | VarPool.get("score")=0.9 |
| MockAgent 失败状态 | agent | status=failed, error="timeout" | status=failed, error="timeout" |
| MockSwarm 整体输出 | swarm | output="consensus", outputs={agreed:true} | lastOutput="consensus", outputs 正确 |
| MockBash 输出 + exit_code | bash | output="result", exit_code=0 | status=completed, lastOutput="result" |
| MockBash 失败 | bash | status=failed, exit_code=1 | status=failed, exitCode=1 |
| MockPython 输出 | python | output="42" | lastOutput="42", status=completed |
| MockApproval 选择 | approval | choice="approve" | status=completed, outputs={choice:"approve"} |
| MockApproval 拒绝 | approval | choice="reject" | status=rejected |
| Mock 变量替换 | agent | output="$vars.name said hi", vars.name="Alice" | lastOutput="Alice said hi" |
| Mock 无前序依赖 | agent | 空 mock | 返回 status=completed, output="" |

#### `syntax-checker.test.ts` — 语法检查器

| 用例 | 语言 | 脚本内容 | 预期 |
|------|------|---------|------|
| 合法 bash | bash | `echo "hello"` | PASS |
| bash 语法错误 | bash | `if [ ; then fi` | FAIL, 含错误行号 |
| bash 未闭合引号 | bash | `echo "unclosed` | FAIL |
| 合法 python | python | `x = 1 + 2\nprint(x)` | PASS |
| python 语法错误 | python | `def foo(\n  pass` | FAIL, 含 SyntaxError |
| python 缩进错误 | python | `if True:\nprint("bad")` | FAIL |
| 空脚本 | bash | `` | PASS (空脚本合法) |
| 多行 bash | bash | `for i in 1 2 3; do\necho $i\ndone` | PASS |

#### `mock-factory.test.ts` — 工厂选择逻辑

| 用例 | 节点类型 | real_execution 列表 | 预期 Executor |
|------|---------|-------------------|--------------|
| agent 默认 | agent | [] | MockAgentExecutor |
| bash 默认 | bash | [] | MockBashExecutor |
| bash 真实执行 | bash | ["bash-1"] | BashExecutor |
| python 真实执行 | python | ["py-1"] | PythonExecutor |
| condition 始终真实 | condition | [] | ConditionExecutor |
| loop 始终真实 | loop | [] | LoopExecutor |
| approval 默认 | approval | [] | MockApprovalExecutor |
| swarm 默认 | swarm | [] | MockSwarmExecutor |

#### `test-runner.test.ts` — 场景加载与执行

| 用例 | 预期 |
|------|------|
| 加载合法 fixture YAML | scenarios 数组正确解析 |
| fixture 文件不存在 | 报错，提示创建 |
| fixture YAML 格式错误 | Zod 验证失败，含路径和行号 |
| 多场景独立执行 | scenario B 的 VarPool 不受 A 影响 |
| 场景执行返回完整 SimResult | 包含 nodeResults + poolSnapshot + assertions |

### Layer 2: 黄金工作流集成测试

准备 5 个**内联工作流**（不依赖外部文件），每个配 test fixture + 手算预期值。

#### Golden WF-1: 线性流程 (Linear)

```yaml
# 工作流定义
name: golden-linear
nodes:
  - id: agent-greet
    type: agent
    prompt: "Say hello to $vars.user_name"
    outputs:
      greeting: "$last_output"
  - id: condition-check
    type: condition
    cases:
      - when: "$vars.greeting contains 'hello'"
        then: "bash-report"
      - when: "default"
        then: "bash-fallback"
  - id: bash-report
    type: bash
    bash: "echo 'Report: $vars.greeting'"
    depends_on: [condition-check]
  - id: bash-fallback
    type: bash
    bash: "echo 'No greeting'"
    depends_on: [condition-check]
```

```yaml
# 测试 fixture
scenarios:
  - name: "happy path"
    inputs:
      user_name: "Alice"
    mocks:
      agent-greet:
        output: "hello Alice"
        outputs:
          greeting: "hello Alice"
      bash-report:
        output: "Report: hello Alice"
      bash-fallback:
        output: "No greeting"
    assertions:
      status: completed
      vars:
        greeting: "hello Alice"
      node_trace:
        executed: [agent-greet, condition-check, bash-report]
        skipped: [bash-fallback]
      node_outputs:
        bash-report:
          output: "Report: hello Alice"
```

**手算预期**: agent mock → greeting="hello Alice" → condition 匹配 case 0 → 跳到 bash-report → bash-fallback skipped

#### Golden WF-2: 分支 + DAG (Branch)

```yaml
name: golden-branch
nodes:
  - id: agent-analyze
    type: agent
    outputs:
      score: "0.85"
  - id: condition-route
    type: condition
    depends_on: [agent-analyze]
    cases:
      - when: "$vars.score > 0.5"
        then: "agent-approve"
      - when: "default"
        then: "agent-reject"
  - id: agent-approve
    type: agent
    depends_on: [condition-route]
    outputs:
      decision: "approved"
  - id: agent-reject
    type: agent
    depends_on: [condition-route]
    outputs:
      decision: "rejected"
  - id: bash-notify
    type: bash
    bash: "echo 'Decision: $vars.decision'"
    depends_on: [agent-approve, agent-reject]
```

**手算预期**: score=0.85 > 0.5 → agent-approve 执行 → agent-reject skipped → bash-notify 收到 decision="approved"

#### Golden WF-3: 循环 (Loop)

```yaml
name: golden-loop
nodes:
  - id: loop-retry
    type: loop
    while: "$vars.attempts < 3"
    max_iterations: 5
    nodes:
      - id: agent-try
        type: agent
        outputs:
          result: "attempt-output"
      - id: bash-check
        type: bash
        bash: "echo checking"
        depends_on: [agent-try]
```

```yaml
scenarios:
  - name: "3 iterations then done"
    inputs:
      attempts: "0"
    mocks:
      loop-retry:
        iterations: 3
        nodes:
          agent-try:
            - output: "attempt 1"
              update_vars:
                attempts: "1"
            - output: "attempt 2"
              update_vars:
                attempts: "2"
            - output: "attempt 3"
              update_vars:
                attempts: "3"
          bash-check:
            output: "checking"
    assertions:
      status: completed
      vars:
        attempts: "3"
```

**手算预期**: iter 0: attempts=0<3 → mock sets attempts=1; iter 1: 1<3 → sets 2; iter 2: 2<3 → sets 3; 循环结束

#### Golden WF-4: Swarm 整体

```yaml
name: golden-swarm
nodes:
  - id: agent-prep
    type: agent
    outputs:
      topic: "security review"
  - id: swarm-review
    type: swarm
    depends_on: [agent-prep]
    mode: review
    topic: "$vars.topic"
  - id: bash-summary
    type: bash
    bash: "echo '$vars.review_result'"
    depends_on: [swarm-review]
```

**手算预期**: agent-prep → topic="security review" → swarm-review mocked → review_result 写入 VarPool → bash-summary 输出

#### Golden WF-5: 失败路径 (Failure)

```yaml
name: golden-failure
nodes:
  - id: agent-risky
    type: agent
  - id: bash-after
    type: bash
    bash: "echo should not run"
    depends_on: [agent-risky]
```

```yaml
scenarios:
  - name: "agent fails, workflow fails"
    mocks:
      agent-risky:
        status: failed
        error: "LLM rate limited"
      bash-after:
        output: "should not run"
    assertions:
      status: failed
      node_trace:
        executed: [agent-risky]
        skipped: [bash-after]
      node_outputs:
        agent-risky:
          status: failed
```

**手算预期**: agent mock 返回 failed → bash-after 因依赖失败被 skip → 整体 status=failed

### Layer 3: Dogfooding — 验证真实工作流

用 simulator 验证仓库中已有的工作流 YAML。已发现以下目标：

#### 优先级排序

| 优先级 | 文件 | 节点类型覆盖 | 价值 |
|--------|------|------------|------|
| 🥇 | `packages/core-pack/workflows/xzf-dev.yaml` | agent, swarm(debate+dynamic), loop, approval, bash, hooks, notify, execute_when, sub-agents | 旗舰工作流，覆盖几乎所有 DSL 特性 |
| 🥈 | `packages/core-pack/templates/swarm/tech-decision.yaml` | swarm(debate), 3 experts, consensus | 最小 debate 示例 |
| 🥈 | `packages/core-pack/templates/swarm/fullstack-dev.yaml` | swarm(dispatch), expert DAG, fail_fast | dispatch 模式 + 专家间依赖 |
| 🥈 | `packages/core-pack/templates/swarm/code-review.yaml` | swarm(review), structured output | review 模式 |
| 🥉 | `octo-swarm-dev/SKILL.md` §6.1–6.5 内联 YAML | 5 种 swarm 模式全覆盖 | 需提取为独立文件 |
| 🥉 | `octo-workflow-dev/SKILL.md` 内联示例 | condition, python, auto_answers, goal mode, execute_when | 补全 edge case 覆盖 |

#### Dogfooding 流程

```
Step 1: 提取 — 从 skill 文件中提取内联 YAML → test-fixtures/ 目录
Step 2: 生成骨架 — 为每个工作流自动生成 mock 骨架 fixture
         (扫描节点类型, 为每个副作用节点生成空 mock 模板)
Step 3: 填充 — 人工填入合理的 mock 输出值
Step 4: 运行 — octopus workflow simulate <yaml>
Step 5: 验证 — 结构验证通过 = 编排逻辑无错误
```

#### Dogfooding 验证标准

| 检查项 | 方法 |
|--------|------|
| 工作流 YAML 能被 simulator 正确解析 | fixture loader 无报错 |
| 所有副作用节点都有 mock 定义 | strict mode 通过 |
| DAG 依赖链无断裂 | depends_on 引用的节点都存在 |
| 变量引用链完整 | `$node-id.output.xxx` 的源节点已定义 |
| 条件表达式合法 | evaluateExpression 不抛异常 |
| 循环终止条件可达 | max_iterations 或 break_when 保证终止 |

Dogfooding 的价值：
- **发现工作流定义中的隐藏 bug**（依赖缺失、变量名拼错、条件不可达）
- **验证 simulator 对复杂真实工作流的兼容性**（xzf-dev.yaml 619行，覆盖几乎所有特性）
- **建立 baseline**：每次 simulator 迭代后重新跑 dogfooding 测试
- **填补覆盖空白**：xzf-dev 缺少 python 节点和 moa 模式，skill 内联示例可补充

### Per-layer Summary

| 层次 | 覆盖范围 | 工具 | 通过标准 |
|------|---------|------|---------|
| 单元测试 | mock executor × 5 类, 断言 × 18 例, 语法检查 × 8 例, 工厂 × 8 例, runner × 5 例 | Vitest | 全部 PASS, 覆盖率 ≥ 90% |
| 黄金工作流 | 5 个内联工作流 × 多场景 | Vitest + 自定义 fixture | 全部 PASS, 模拟结果=手算预期 |
| Dogfooding | core-pack 中所有工作流 YAML | CLI `workflow simulate` | 结构验证通过 (编排逻辑无错误) |

### Prerequisites
- [ ] `@octopus/engine` builds successfully
- [ ] `@octopus/shared` has test fixture Zod schemas
- [ ] CLI package imports simulator module
- [ ] core-pack 中至少 3 个工作流 YAML 可用于 dogfooding

## Risks & Notes

- **R1: VarPool state leakage between scenarios** — Each scenario must get a fresh WorkflowEngine instance. Mitigation: `TestRunner` creates new engine per scenario.
- **R2: Loop mock array index out of bounds** — If workflow iterates more times than mock array length, need clear error. Mitigation: use last element as fallback + warning.
- **R3: Variable substitution in mock outputs** — Mock output values may contain `$vars.xxx` references. Must resolve at execution time, not load time. Mitigation: substitute in mock executor, not in test runner.
- **R4: Condition evaluation depends on mock data** — If mock data doesn't set the right vars, conditions won't match. Mitigation: clear error messages showing VarPool state at condition evaluation.
- **R5: Sandbox real execution portability** — `bash -n` and `python compile()` may behave differently across OS. Mitigation: document supported environments, test on macOS + Linux.

## Glossary (new domain terms)

| Term | Meaning |
|------|---------|
| **SimulatorExecutorFactory** | A specialized ExecutorFactory that returns mock executors for side-effect nodes and real executors for logic nodes |
| **MockDef** | A test fixture definition specifying how a node should behave during simulation (output, status, vars) |
| **TestScenario** | A complete test case: inputs + mocks + assertions for one execution path |
| **TestFixture** | A `.test.yaml` file containing one or more TestScenarios for a workflow |
| **Auto-pass** | (Rejected) Automatically passing nodes without mock definitions. Current design uses strict mode instead |
| **Syntax pre-check** | Running `bash -n` or `python compile()` on script content before simulation to catch syntax errors without execution |
| **Per-iteration mock** | Array-based mock data for loop inner nodes where index = iteration number |
