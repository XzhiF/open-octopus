# Node Schema Reference

Field definitions for all 11 Octopus workflow node types. Source of truth: `packages/shared/src/types/workflow.ts`.

---

## Common Fields (All Node Types)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | Unique node identifier within the workflow |
| `type` | enum | ✅ | One of: `bash`, `python`, `agent`, `condition`, `approval`, `loop`, `swarm`, `interaction`, `sub_workflow`, `dynamic_sub_workflow`, `task_dispatch` |
| `depends_on` | string[] | — | IDs of upstream nodes this node depends on |
| `execute_when` | string | — | Expression; falsy → node is skipped |
| `outputs` | Record<string, string> | — | Map VarPool keys to expressions |
| `model` | string | — | Model override: `pro-max`, `pro` (default), `se` |
| `engine` | string | — | AI provider engine override |
| `timeout` | number | — | Execution timeout in seconds |

---

## 1. `bash` — Shell Script

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bash` | string | ✅ | Shell script content |

```yaml
- id: build
  type: bash
  bash: npm run build
  timeout: 60
```

---

## 2. `python` — Python Script

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `python` | string | ✅ | Python script content |
| `inputs` | Record<string, string> | — | Key-value pairs injected as environment variables |

```yaml
- id: parse
  type: python
  inputs:
    threshold: "0.8"
  python: |
    import os
    print(float(os.environ["threshold"]))
```

---

## 3. `agent` — AI Agent

### Standard Mode

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | * | Agent instructions (mutually exclusive with `goal`) |
| `agent` | string | * | Agent identifier |
| `agent_file` | string | — | Path to installed agent (`group/name.md` short path) |
| `agents` | Record<string, SubAgentDef> | * | Sub-agent definitions for delegation |
| `skills` | string[] | — | Skill names to inject into context (plain names, runtime filter) |
| `effort` | EffortLevel | — | Reasoning depth: `low` \| `medium` \| `high` \| `xhigh` \| `max` \| number |
| `context` | `"new"` \| `"continue"` | — | Context mode (continue only if previous node is agent) |
| `resume_from` | string | — | Resume from a specific checkpoint |
| `auto_answers` | AutoAnswer[] | — | Pattern-answer pairs for unattended mode |

*At least one of `prompt`, `agent`, `goal`, or `agents` is required.

### Goal Mode (alternative to prompt) — Claude Code `/goal` adapter

`goal` 字段全文（插值后）即 `/goal <condition>` 的完成判据：worker 迭代干活，**独立 evaluator 逐轮判 met/impossible**；met → 节点 completed，未收敛 → 烧到硬保险丝后节点 **failed**（携 `goal_not_met (<终态>)` 证据，不伪装 completed）。

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `goal` | string | ✅ | 完成判据 condition（与 `prompt` 互斥）。必须**可判伪**：逐条给判据 + 要求证据；ac 等输入经 `$inputs.xxx` 插值进文本 |
| `constraints` | string[] | — | Natural language constraints |
| `max_turns` | number\|string | — | 硬保险丝：turn 上限。string 支持 `$inputs.x` 插值；无效值视为未设置 |
| `max_budget_usd` | number\|string | — | 硬保险丝：美元预算上限 |
| `disallowed_tools` | string[] | — | SDK 硬执行工具黑名单 |
| `tools` | string[] | — | SDK 硬执行工具白名单（可用工具基础集） |

> **Turn semantics (K5)**: 1 turn = 1 次 assistant API 往返；并行 tool_use 计 1 turn，每个 tool_result 回传开新 turn，`/goal` 续跑同样计 turn。
> **claude-only**: `max_turns`/`max_budget_usd`/`tools`/`disallowed_tools` 仅 claude engine 真实执行；其他 engine validate 时 WARNING、运行时静默忽略。这些字段对 prompt 模式 agent 节点同样可用（非 goal 专属）。
> **软退出条款**: condition 内写"同一阻塞点连续多轮无进展 → 停止迭代、输出阻塞清单并以此收束"，教 evaluator 判 impossible 时给出可验收解释。
> Goal mode does NOT support `agents` sub-agents.
>
> **⚠️ 迁移**: 旧 `planning:` 块（`max_turns/tools/disallowed_tools/verify`）已整体废弃——含 `planning:` 的 YAML parse 直接报错。前三者提升为上表节点字段，`verify` 删除（验证要求写进 condition 文本本身）。

```yaml
- id: implement
  type: agent
  goal: |
    完成以下目标，且每条判据均有可复核证据：
    $inputs.goal
    判据：
    $inputs.ac
    若同一阻塞点连续多轮无进展，输出阻塞清单并以此收束退出。
  max_turns: $inputs.max_turns   # number 或 $inputs 插值 string
  max_budget_usd: 5
```

### SubAgentDef

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | ✅ | Sub-agent role description |
| `prompt` | string | — | Sub-agent instructions |
| `agent_file` | string | — | Path to installed agent resource (`group/name.md` short path) |
| `tools` | string[] | — | Allowed tools whitelist |
| `disallowed_tools` | string[] | — | Disallowed tools |
| `model` | string | — | Model override |
| `skills` | string[] | — | Skills to inject |
| `maxTurns` | number | — | Max conversation turns |
| `background` | boolean | — | Run in background |
| `effort` | enum | — | Reasoning effort: `low`, `medium`, `high`, `xhigh`, `max` |

```yaml
- id: design
  type: agent
  model: pro-max
  agents:
    devil-advocate:
      description: "Devil's advocate — reviews solution completeness."
      agent_file: "built-in/devil-advocate.md"
      tools: ["Read", "Grep", "Write"]
      prompt: "Review $vars.solution_file"
  prompt: |
    You are the coordinator. Delegate devil-advocate, then produce a summary index.
```

---

## 4. `condition` — Conditional Routing

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cases` | CaseDef[] | ✅ | Array of condition cases |

### CaseDef

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `when` | string | ✅ | Expression (or `"default"`) |
| `then` | string | ✅ | Target node ID to jump to |

> `when: default` must be the **last** case. First matching case wins.

```yaml
- id: route
  type: condition
  cases:
    - when: '$vars.severity == "critical"'
      then: urgent-fix
    - when: default
      then: standard-fix
```

---

## 5. `approval` — Human Approval Gate

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `options` | ApprovalOption[] | — | Available choices |
| `approval_timeout` | number | — | Timeout in seconds (0 = immediate timeout in unattended mode) |
| `on_reject` | string | — | Node ID to jump to on rejection |
| `comment_label` | string | — | Label for comment field |
| `comment_placeholder` | string | — | Placeholder text for comment field |

### ApprovalOption

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `label` | string | ✅ | Display label |
| `value` | string | ✅ | Selection value |

```yaml
- id: deploy-gate
  type: approval
  options:
    - { label: "Approve", value: "approved" }
    - { label: "Reject", value: "rejected" }
  approval_timeout: 3600
  on_reject: rollback
```

---

## 6. `loop` — Iterative Execution

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `max_iterations` | number | ✅ | Maximum loop iterations |
| `nodes` | NodeDef[] | ✅ | Inner nodes (must have explicit `depends_on`) |
| `while` | string | — | Continue condition |
| `break_when` | string | — | Exit condition |
| `continue_when` | string | — | Continue condition (alternative to while) |

> **Loop sub-nodes MUST declare `depends_on`** — even in `execution_mode: serial`, inner nodes need explicit dependencies for correct DAG visualization and execution ordering.

```yaml
- id: retry-deploy
  type: loop
  while: '$vars.attempt < 5'
  break_when: '$vars.deploy_status == "success"'
  max_iterations: 5
  nodes:
    - id: try
      type: agent
      prompt: "Attempt $iteration: deploy..."
    - id: check
      type: bash
      depends_on: [try]
      bash: "echo checking..."
```

---

## 7. `swarm` — Multi-Expert Collaboration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `topic` | string | ✅ | Discussion topic / prompt |
| `mode` | enum | ✅ | `review`, `debate`, `dispatch`, `swarm`, `moa` |
| `experts` | ExpertDef[] | * | Fixed expert roster (mutually exclusive with `expert_pool`) |
| `expert_pool` | ExpertDef[] | * | Dynamic expert pool (mutually exclusive with `experts`) |
| `dynamic` | boolean | — | Enable dynamic routing |
| `max_experts` | number | — | Max experts (required when `dynamic: true`) |
| `rounds` | number | — | Discussion rounds (debate: ≥1, moa: 0-5) |
| `consensus_threshold` | number | — | Consensus score threshold 0.0-1.0 (debate) |
| `budget` | number | — | Token budget |
| `host` | ExpertDef | — | Custom host configuration |
| `aggregator` | ExpertDef | — | Aggregator definition (moa only, required) |
| `failure_policy` | enum | — | `fail_fast`, `continue_partial`, `retry_failed` |
| `output_format` | enum | — | `summary`, `full`, `structured` |
| `expert_defaults` | object | — | Default values for all experts |
| `context_tier` | enum | — | `"200k"` or `"1m"` |
| `context_window_rounds` | number | — | Sliding window size (debate) |
| `context_token_budget` | number | — | Context token budget |

> See `references/swarm-modes.md` for detailed mode documentation and cross-constraints.

---

## 8. `interaction` — Human-in-the-Loop Interaction

Multi-round interactive conversation between the workflow and a human user, mediated by an AI agent.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `interaction_agent` | InteractionAgentDef | * | AI agent configuration for the interaction |
| `interaction_exit_when` | string | * | Expression to evaluate after each round; truthy → exit |
| `interaction_display` | enum | — | `"modal"` or `"panel"` (UI display mode) |
| `interaction_max_rounds` | number | — | Maximum interaction rounds |
| `interaction_timeout` | number | — | Timeout per round in seconds |

*At least one of `interaction_agent` or `interaction_exit_when` is required.

### InteractionAgentDef

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `skills` | string[] | — | Skills to inject into the interaction agent |
| `prompt` | string | — | Agent instructions for each interaction round |
| `model` | string | — | Model override |
| `context` | `"new"` \| `"continue"` | — | Context mode |
| `goal` | string | — | Interaction goal |
| `constraints` | string[] | — | Constraints for the interaction agent |

```yaml
- id: user-feedback
  type: interaction
  interaction_display: modal
  interaction_max_rounds: 10
  interaction_exit_when: '$vars.user_satisfied == "true"'
  interaction_agent:
    prompt: |
      Present the current design to the user and ask for feedback.
      If the user says "looks good" or "approved", set user_satisfied to true.
    model: pro
    skills: ["superpowers-zh/brainstorming"]
```

---

## 9. `sub_workflow` — Nested Workflow Execution

Execute another workflow as a child process within the current workflow.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `workflow` | string | ✅ | Path or name of the child workflow |
| `execution_mode` | enum | — | `"inline"` (embedded) or `"linked"` (reference) |
| `input_mapping` | Record<string, string> | — | Map parent variables to child workflow inputs |
| `output_mapping` | Record<string, string> | — | Map child outputs to parent VarPool |
| `on_error` | enum | — | `"fail"` (default) or `"continue"` on child error |

### Parent Context Access

Inside a sub_workflow's child workflow, these special variable references are available:

| Syntax | Description |
|--------|-------------|
| `$parent.var_pool.xxx` | Access parent VarPool |
| `$parent.input_values.xxx` | Access parent input parameters |
| `$parent.$nodeId.outputs.xxx` | Access parent node outputs |
| `$ancestor[N].var_pool.xxx` | Access N-level ancestor VarPool (0=parent) |
| `$ancestor[N].$nodeId.outputs.xxx` | Access N-level ancestor node outputs |

```yaml
- id: run-tests
  type: sub_workflow
  workflow: "workflows/e2e-test-suite.yaml"
  execution_mode: linked
  input_mapping:
    test_target: "$vars.build_artifact"
    environment: "$vars.deploy_env"
  output_mapping:
    test_results: "$vars.e2e_results"
    test_status: "$vars.e2e_status"
  on_error: continue
```

---

## 10. `dynamic_sub_workflow` — Dynamic DAG Generation

An LLM agent dynamically generates a DAG of parallel/serial agent nodes at runtime, validates the output through a 3-layer harness, persists as YAML, and executes it.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | ✅ | DAG generation instruction for the agent |
| `model` | string | — | Model override for the generation agent |
| `skills` | string[] | — | Skills to inject into the generation agent |
| `workflow` | string | — | Pre-defined output file name (auto-generated if omitted) |
| `on_error` | enum | — | `"fail"` (default) or `"continue"` |

### How It Works

1. **Generation**: Agent receives the prompt + upstream data, outputs a JSON DAG
2. **Validation**: 3-layer harness (L1 structure → L2 graph → L3 semantics) with up to 3 correction rounds
3. **Persistence**: Generated DAG saved as `{workflow}.yaml` + `{workflow}.meta.json` in `workflows/`
4. **Execution**: Generated DAG executed as a child workflow (same as sub_workflow)

### Constraints

- Generated DAG nodes must ALL be type `agent`
- No circular dependencies in generated DAG
- No nested `sub_workflow` or `dynamic_sub_workflow` in generated DAG

### Agent Output Format (JSON contract)

```json
{
  "nodes": [
    {
      "id": "task-a",
      "type": "agent",
      "prompt": "Implement feature A",
      "skills": ["frontend-dev"],
      "depends_on": []
    },
    {
      "id": "task-b",
      "type": "agent",
      "prompt": "Implement feature B",
      "depends_on": ["task-a"]
    }
  ]
}
```

### Example

```yaml
- id: plan-and-execute
  type: dynamic_sub_workflow
  workflow: ticket-dag
  prompt: |
    Analyze $vars.tickets and plan an execution DAG.
    Each ticket should be a separate agent node.
    Identify dependencies between tickets.
  model: claude-sonnet-4-20250514
  skills: [octo-workflow-dev, octo-workflow-test]
  depends_on: [to-tickets]
```

### Context-Aware Rerun

When re-executing with the same upstream input, the engine compares the input hash against the stored meta.json. If unchanged, the existing DAG is reused without calling the agent. If changed, a new DAG is generated.

### File Naming

- Default: `{parentWorkflow}__{nodeId}.yaml`
- Custom: `{workflow}.yaml` (when `workflow` field is set)
- Inside loop: `{name}-iter{N}.yaml`

---

## 11. `task_dispatch` — Composite Task Child-Schedule Fan-out

Fans out one child schedule for a single subunit of a composite task and pauses the parent composition workflow until the child completes (G1 pause-resume bridge). Used **inside a composition workflow's subunit loop** — each loop iteration runs one `task_dispatch` node whose `subunit` reference resolves to the i-th `SubunitSpec` from `task_spec.subunits`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `subunit` | string | ✅ | String reference resolved at runtime by the `TaskDispatchExecutor` to a `SubunitSpec`. Supports `$iteration.subunit` (composition loop context), `$vars.xxx`, `$nodeId.output.xxx`, or literal JSON. **Not** an inline object. |
| `workflow_ref` | string | — | Override the subunit's workflow_ref (defaults to the resolved subunit's `workflow_ref`) |
| `await` | boolean | — | `true` = pause parent until child schedule completes (G1), child output flows back via `output_mapping`; `false` = fire-and-forget, complete immediately after the child schedule is created |
| `input_mapping` | Record<string, string> | — | Map parent VarPool vars → child schedule inputs (reused from `sub_workflow`) |
| `output_mapping` | Record<string, string> | — | `{ parentVar: childKey }` — child output written to `$vars.parentVar` AND `$<nodeId>.output.parentVar` for downstream aggregation |
| `outputs` | Record<string, string> | — | Standard `outputs` block (`$vars.x = expr`), applied on resume (interaction/approval precedent) |

### How G1 pause-resume works

1. **First call**: `TaskDispatchExecutor.resolveSubunit()` resolves the `subunit` reference → `TaskDispatchPort.dispatchChildSchedule(subunit)` creates a child schedule (own workspace + workflow_ref) → the node returns `pending_task_dispatch` and the engine **pauses** the composition-wf (reuses interaction/approval infra, no in-memory Promise blocking).
2. **Resume**: the server's child-complete callback re-invokes the engine with the child's output snapshot → a new executor instance applies `output_mapping` → `completed`. Child output is now readable as `$<taskDispatchId>.output.<parentVar>` by downstream nodes (e.g. the moa aggregator).

### Variable resolution (`subunit` reference)

The executor resolves the `subunit` string **without** `substituteVars` (object-preserving, mirroring sub-workflow `resolveMappingValue`):

| Reference | Resolves from |
|-----------|---------------|
| `$iteration.subunit` | `config.loopContext.subunit` — the composition loop exposes the current subunit per iteration |
| `$vars.xxx` | Parent VarPool (object-preserving) |
| `$nodeId.output.xxx` | A prior node's output value |
| literal JSON | Parsed as a `SubunitSpec` directly |

> The resolved value must be shaped like a `SubunitSpec` (`name` + `workflow_ref` required) or the node fails deterministically.

### Example (inside a composition workflow)

```yaml
- id: loop-subunits
  type: loop
  max_iterations: 20
  break_when: '$iteration >= $vars.subunit_count'
  nodes:
    - id: dispatch-child
      type: task_dispatch
      subunit: "$iteration.subunit"   # → i-th SubunitSpec from task_spec.subunits
      await: true                      # G1: pause until child schedule completes
      input_mapping:
        goal: "$vars.goal"
      output_mapping:
        result: "last_output"          # child output → $vars.result + $dispatch-child.output.result

- id: integrate
  type: swarm
  depends_on: [loop-subunits]           # moa aggregation reads $dispatch-child.output.result
  mode: moa
  topic: "$vars.goal"
  dynamic: true
  max_experts: 3
  aggregator:
    role: "synthesizer"
    prompt: "合并各 subunit 产出为统一交付物。"
```

### Constraints

- `subunit` is a **string reference**, never an inline object (the schema rejects inline-object subunits).
- A `task_dispatch` node is a leaf — it has no `nodes`/`cases`/inner children.
- The `TaskDispatchPort` is server-injected; a missing port surfaces as a deterministic node failure (not a crash). In `octopus workflow simulate`, a `task_dispatch` node **auto-passes** (no port is injected) — see `octo-workflow-test`.

---

## Workflow-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `apiVersion` | string | ✅ | Must match `octopus/v{N}` (e.g., `octopus/v1`) |
| `kind` | string | ✅ | Must be `"Workflow"` |
| `name` | string | ✅ | Workflow name |
| `description` | string | — | Workflow description |
| `model` | string | — | Default model for all nodes |
| `engine` | string | — | Default engine for all nodes |
| `timeout` | number | — | Global timeout in seconds |
| `execution_mode` | enum | — | `"auto"` (default, DAG) or `"serial"` |
| `max_concurrent` | number | — | Max concurrent same-level nodes |
| `variables` | Record<string, unknown> | — | Initial VarPool values |
| `inputs` | Record<string, WorkflowInput> | — | Workflow input parameters |
| `auto_answers` | AutoAnswer[] | — | Global auto-answer patterns |
| `hooks` | WorkflowHooks | — | Lifecycle hooks |
| `providers` | Record<string, NotifyProviderConfig> | — | Notification providers |
| `channels` | Record<string, ChannelProfile> | — | Notification channels |
| `requires` | RequiresDef | — | Explicit resource dependency declaration (provisioned by `__engine_init__`) |
| `nodes` | NodeDef[] | ✅ | Node definitions |

### RequiresDef

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `skills` | string[] | — | Skill dependencies (`group/name` format, e.g. `superpowers-zh/test-driven-development`) |
| `agent_files` | string[] | — | Agent file dependencies (`group/name.md` format, e.g. `built-in/vision-analyzer.md`) |

> See `references/requires-and-effort.md` for full documentation on `requires` and `effort`.

### WorkflowInput

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | ✅ | Input parameter description |
| `required` | boolean | — | Whether input is required (default: false) |
| `default` | string | — | Default value (default: "") |
