# Node Schema Reference

Field definitions for all 9 Octopus workflow node types. Source of truth: `packages/shared/src/types/workflow.ts`.

---

## Common Fields (All Node Types)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | Unique node identifier within the workflow |
| `type` | enum | ✅ | One of: `bash`, `python`, `agent`, `condition`, `approval`, `loop`, `swarm`, `interaction`, `sub_workflow` |
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
| `agents` | Record<string, SubAgentDef> | * | Sub-agent definitions for delegation |
| `skills` | string[] | — | Skill names to inject into context |
| `context` | `"new"` \| `"continue"` | — | Context mode (continue only if previous node is agent) |
| `resume_from` | string | — | Resume from a specific checkpoint |
| `auto_answers` | AutoAnswer[] | — | Pattern-answer pairs for unattended mode |

*At least one of `prompt`, `agent`, `goal`, or `agents` is required.

### Goal Mode (alternative to prompt)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `goal` | string | ✅ | High-level goal (mutually exclusive with `prompt`) |
| `constraints` | string[] | — | Natural language constraints |
| `planning.verify` | boolean | — | Append verification step |
| `planning.tools` | string[] | — | Allowed tools (soft constraint) |
| `planning.disallowed_tools` | string[] | — | Disallowed tools (soft constraint) |
| `planning.max_turns` | number | — | Max turns (⚠️ not enforced, use `timeout`) |

> Goal mode does NOT support `agents` sub-agents.

### SubAgentDef

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | ✅ | Sub-agent role description |
| `prompt` | string | — | Sub-agent instructions |
| `agent_file` | string | — | Path to installed agent resource |
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
      agent_file: "~/.octopus/resources/installed/agents/built-in/devil-advocate/devil-advocate.md"
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
| `nodes` | NodeDef[] | ✅ | Node definitions |

### WorkflowInput

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | string | ✅ | Input parameter description |
| `required` | boolean | — | Whether input is required (default: false) |
| `default` | string | — | Default value (default: "") |
