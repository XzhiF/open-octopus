# Testing Reference

Workflow test fixture generation and simulator usage.

---

## Prerequisites

- Workflow YAML created and passes `validate-workflow.js`
- `octopus` CLI available (`pnpm build` executed)
- Simulator engine available (V1 simulator)

---

## Auto-Discovery Convention

Test fixture files live in the **same directory** as the workflow YAML:

```
workflow.yaml      → workflow.test.yaml
my-flow.yaml       → my-flow.test.yaml
xzf-dev.yaml       → xzf-dev.test.yaml
```

CLI `octopus workflow simulate <yaml>` auto-discovers the `.test.yaml` in the same directory.

---

## Workflow Analysis (Step 1)

### Node Inventory

For each node, record:
- `id` / `type` / `depends_on`
- Whether it has `outputs:` mapping
- Whether it has `execute_when`
- Whether it's inside a loop

### Side-Effect Node Identification

These types need mock definitions (strict mode):

| Node Type | Needs Mock | Reason |
|-----------|-----------|--------|
| `agent` | ✅ Required | LLM call, replaced by mock |
| `swarm` | ✅ Required | Multi-expert collaboration, whole mock |
| `bash` | ✅ Required | Shell side-effects, mock stdout |
| `python` | ✅ Required | Python side-effects, mock stdout |
| `approval` | ✅ Required | User approval, mock choice |
| `interaction` | ✅ Required | Multi-round interaction, mock summary |
| `condition` | ❌ Not needed | Actually evaluates based on VarPool |
| `loop` | ✅ Required | Contains inner node mocks |
| `sub_workflow` | ✅ Required | Child workflow execution, mock results |

### Variable Flow Graph

Trace:
- Each node's `outputs:` mapping → which VarPool keys are written
- Each node's `vars_update` → which VarPool keys are written
- Downstream `condition.when` / `execute_when` / `loop.while` / `loop.break_when` → which VarPool keys are read

### Condition Expression Collection

Forward-scan all conditions referencing variables:
- `condition.cases[].when`
- `execute_when`
- `loop.while` / `loop.break_when`

---

## Mock Data Generation Rules (By Node Type)

### Agent Nodes

Infer output semantics from `prompt`. If `outputs:` mapping exists, generate meaningful mock values for each key.

```yaml
agent-node-id:
  status: "completed"               # or "failed"
  output: "Execution complete text"  # → lastOutput + $last_output
  outputs:                          # → extra outputs field
    key: value
  update_vars:                      # → write directly to VarPool
    var_name: var_value
  error: "error message"            # when status=failed
```

**With `__status` control signal:**
```yaml
build:
  output: "Compilation failed: 3 type errors"
  update_vars:
    __status: "failed"
    error_detail: "3 type errors"
```

### Bash Nodes

```yaml
bash-node-id:
  status: "completed"
  output: "script output text"
  exit_code: 0
  update_vars:
    var_name: var_value
```

### Python Nodes

Same structure as bash (stdout + exit_code + vars_update protocol identical).

```yaml
python-node-id:
  status: "completed"
  output: "script output"
  exit_code: 0
```

### Swarm Nodes

Whole mock — infer reasonable consensus results from `topic` and `mode`.

```yaml
swarm-node-id:
  status: "completed"
  output: "Synthesis report text"
  update_vars:
    requirements_checklist_status: "COMPLETE"
```

**Swarm auto-vars constraint solving** (required step):

1. **Scan downstream references**: For each swarm node, find all references to `$vars.{nodeId}_xxx`
2. **Fill referenced auto-vars**: Set each referenced auto-var in the swarm mock's `update_vars`
3. **Set reasonable defaults by mode**:

| Mode | Key auto-vars | Suggested defaults |
|------|--------------|-------------------|
| review | `_synthesis` | Mock output content |
| debate | `_synthesis`, `_consensus_score`, `_rounds_used` | score=0.8+, rounds=2 |
| dispatch | `_synthesis`, `_task_breakdown`, `_expert_outputs` | Breakdown JSON + expert outputs |
| swarm | `_synthesis`, `_expert_count` | Dynamic routing result |
| moa | `_synthesis`, `_expert_outputs` | Aggregator synthesis |

> **Rule: If downstream references an auto-var but mock doesn't set it → simulator produces empty value → assertion fails. Better to set extra auto-vars than miss one.**

### Approval Nodes

Default choice = first option. Generate second scenario for rejection path.

```yaml
approval-node-id:
  choice: "proceed"                 # Must match options[].value
  comment: "Requirements clear"     # Optional
```

**Reject detection**: choice value is `"reject"` / `"no"` / `"deny"` / `"abort"` → status = `"rejected"`

### Loop Nodes

Analyze `while` / `break_when` conditions, generate mock arrays by iteration index. `update_vars` must eventually satisfy termination condition.

```yaml
loop-node-id:
  iterations: 2                     # Expected iterations (optional)
  nodes:                            # Inner node mocks
    inner-node-1:                   # Single mock → all iterations use same mock
      output: "..."
      update_vars:
        counter: 3
    inner-node-2:                   # Array mock → different mock per iteration
      - output: "Round 1"
        update_vars: { status: "pending" }
      - output: "Round 2"
        update_vars: { status: "passed" }
```

**Loop convergence constraint**:
- `break_when` referenced variables must satisfy condition at some iteration
- Inner node mocks must progressively change control variables via `update_vars`

### Interaction Nodes

```yaml
interaction-node-id:
  summary: "Interaction summary text"
  rounds: 3                         # Number of interaction rounds
  vars_update:
    user_approved: "true"
  outputs:
    key: value
```

### Sub-workflow Nodes

```yaml
sub-workflow-node-id:
  status: "completed"
  output: "Child workflow result"
  update_vars:
    child_output_key: "value"
```

### Condition Nodes

**No mock needed.** Condition nodes evaluate based on actual VarPool values. To make condition match a specific case, ensure upstream mocks set the relevant variables to satisfy that case's `when` expression.

---

## Fixture Generation (`.test.yaml`)

### File Structure

```yaml
# yaml-language-server: $schema=~/.octopus/test-fixture-schema.json
scenarios:
  - name: "happy path"
    inputs:                         # Workflow input parameters (optional)
      idea: "Add user authentication"
    mocks:                          # Side-effect node mock definitions
      init:
        output: "Initialized"
        update_vars:
          branch: "feat/auth"
          feature: "auth"
      build:
        output: "Build successful"
        exit_code: 0
    assertions:                     # Assertion definitions
      status: "completed"
      vars:
        branch: "feat/auth"
      node_trace:
        executed: [init, build, deploy]
        skipped: [rollback]
```

### Scenario Generation Strategy

- **At least 1 happy path scenario**: All nodes execute as expected
- **Optional failure path scenario**: If workflow has conditional branches, test failure paths
- **Optional retry scenario**: If workflow has loop + approval, test retry paths

### Assertion Types (5 kinds)

```yaml
assertions:
  # 1. Overall workflow status
  status: "completed"              # completed | failed | completed_with_failures | paused | cancelled

  # 2. VarPool snapshot (key variable values)
  vars:
    branch: "feat/my-feature"
    build_status: "success"

  # 3. Node execution trace
  node_trace:
    executed: [init, build, test]  # Must-execute nodes
    skipped: [rollback, notify-error]  # Must-skip nodes
    order: [init, build, test, deploy]  # Execution order (subsequence match)

  # 4. Node outputs
  node_outputs:
    build:
      output: "Build successful"   # lastOutput
      outputs:                     # named outputs
        exit_code: 0
      status: "completed"

  # 5. Log content
  logs:
    build:
      contains: ["[mock] bash completed"]
      not_contains: ["error"]
```

---

## Execution & Iteration (Closed-Loop Protocol)

### Run Simulator

```bash
pnpm exec octopus workflow simulate {workflow.yaml} --json
```

- `--json` outputs full JSON result (for programmatic parsing)
- Auto-discovers `{name}.test.yaml` in same directory
- `--test <path>` to specify different fixture
- `--scenario <name>` to run single scenario

### Parse JSON Result

```json
{
  "results": [
    {
      "scenarioName": "happy path",
      "passed": true,
      "durationMs": 15,
      "status": "completed",
      "nodeResults": { "init": { "status": "completed" } },
      "poolSnapshot": { "branch": "feat/auth" },
      "executionTrace": [ { "nodeId": "init", "status": "completed", "mocked": true } ],
      "assertionReport": {
        "passed": true,
        "results": [
          { "name": "status", "passed": true, "message": "status = completed" }
        ]
      }
    }
  ],
  "totalDurationMs": 20,
  "passed": true,
  "passedCount": 1,
  "failedCount": 0
}
```

### Iterative Fix Protocol

1. Run `octopus workflow simulate {wf.yaml} --json`
2. If `passed: true` → report success, exit
3. If `passed: false` → analyze `assertionReport.results` for `passed: false` entries:

| Failure Type | Diagnosis | Fix |
|-------------|-----------|-----|
| `status` mismatch | Check mock's `status` field | Modify causing node's mock |
| `vars.xxx` mismatch | Check which node's `update_vars` incorrect | Adjust mock's `update_vars` or `outputs` |
| `node_trace.executed` missing | Condition took wrong branch | Adjust upstream mock to satisfy correct branch |
| `node_trace.skipped` not skipped | `execute_when` condition wrong | Adjust control variable mock value |
| `node_outputs` mismatch | Mock output text wrong | Adjust mock's `output` field |

4. Modify `.test.yaml` → re-run (**max 3 rounds**)
5. After 3 rounds still failing → output diagnostic report

### Diagnostic Report (After 3 Failed Rounds)

```markdown
# Test Diagnostic Report

## Persistent Assertion Failures
- `vars.xxx`: expected "A", got "B" (3 rounds failed)

## Attempted Fixes
- Round 1: Modified init mock update_vars.branch to "feat/xxx"
- Round 2: Added condition-check upstream mock score to 0.9
- Round 3: Adjusted loop mock per-iteration array

## Possible Root Causes
- Variable X write chain incomplete: init → build → condition, but build missing update_vars
- condition when expression references un-mocked variable

## Recommended Investigation
1. Check build node outputs mapping
2. Check condition when expression syntax (strings must be quoted)
3. Run with --verbose for detailed execution logs
```

---

## Mock Constraint Solving

### Constraint 1: outputs Mapping → VarPool Fill

Parse each node's `outputs:` block to determine which VarPool keys get set. Mock `update_vars` should cover these keys.

### Constraint 2: Downstream Conditions → Value Constraints

Forward-scan all condition expressions referencing a variable, ensure mock values satisfy expected path:

```
$vars.e2e_status is referenced in:
  - e2e-notify.execute_when: '$vars.e2e_status == "failed"'
  - e2e-approval.execute_when: '$vars.e2e_status == "failed"'
  - e2e-verify-loop.break_when: '$vars.e2e_status == "passed" || ...'

→ Happy path mock: e2e_status = "passed" (skips e2e-notify + e2e-approval)
→ Failure path mock: e2e_status = "failed" (triggers notification + approval)
```

### Constraint 3: Loop break_when → Iteration Convergence

Ensure loop inner node mock values satisfy break_when at some iteration:

```yaml
# break_when: '$vars.decision == "proceed" && $vars.status == "COMPLETE"'
# → Final iteration:
#   approval mock: { choice: "proceed" }
#   agent mock: { update_vars: { status: "COMPLETE" } }
```

### Constraint 4: Approval options → Valid Choice

Mock choice must match node's `options[].value`.

### Constraint 5: $nodeId.output Reference → Chain Dependency

When node references `$requirements-approval.output.comment`, approval mock MUST provide `comment` field.

---

## Strict Mode

**Enabled by default.** All side-effect nodes must have mock definitions:

```
Strict mode: no mock definition found for side-effect node "build" (type: bash).
Add a mock definition in the test fixture or use --no-strict.
```

- `--no-strict` lets un-mocked nodes auto-pass (empty string output)
- Always provide mock definitions for all side-effect nodes
- Condition nodes never need mock (they evaluate based on VarPool)
