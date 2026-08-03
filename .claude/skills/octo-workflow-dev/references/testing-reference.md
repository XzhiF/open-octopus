# Testing Mock Patterns Reference

Detailed mock data examples and patterns extracted from real workflow analysis.
Use as a lookup when generating fixtures for complex workflows.

---

## 1. xzf-dev.yaml Variable Flow (619-line flagship workflow)

### Stage 0: init (agent)

**Node definition**:
```yaml
- id: init
  type: agent
  prompt: "Initialize: detect branch, feature slug, remote type"
```

**Mock data**:
```yaml
init:
  output: "Initialized. Branch: feat/engine-init-sync, feature: engine-init-sync, remote: github"
  update_vars:
    branch: "feat/engine-init-sync"
    feature: "engine-init-sync"
    remote_type: "github"
```

**VarPool writes**: `$vars.branch`, `$vars.feature`, `$vars.remote_type`
**Downstream dependency**: Almost all subsequent nodes reference `$vars.feature` and `$vars.branch`

### Stage 1: idea-research (swarm, debate, dynamic)

**Swarm auto-vars written by engine** (`writeAutoOutputs`):

| Auto-var key | Example value |
|-------------|---------------|
| `idea-research_synthesis` | "Research conclusion: involves engine and shared packages, no major risks. 3 questions pending." |
| `idea-research_consensus_score` | `0.85` |
| `idea-research_rounds_used` | `2` |
| `idea-research_expert_count` | `3` |
| `idea-research_experts` | `["codebase-architect", "external-researcher", "risk-analyst"]` |
| `idea-research_history` | `[{"round":1,"expert":"codebase-architect","output":"..."},...]` |
| `idea-research_expert_outputs` | `[{"role":"codebase-architect","output":"..."},...]` |
| `idea-research_failed_experts` | `[]` |
| `idea-research_task_breakdown` | `null` (debate mode, not dispatch) |
| `idea-research_budget_exhausted` | `false` |
| `idea-research_timeout_exceeded` | `false` |

**User-defined outputs mapping** (in workflow):
```yaml
outputs:
  "$vars.requirements_checklist_status": "$last_output.requirements_checklist_status"
```

**Host extra output via vars_update**:
```yaml
idea-research:
  output: "Research conclusion: involves engine and shared packages, no major risks. 3 questions pending."
  update_vars:
    requirements_checklist_status: "INCOMPLETE: Missing verification strategy"
```

### Stage 2a: requirements-clarify-loop (loop)

**Mock for happy path (1 iteration, immediate proceed)**:
```yaml
requirements-clarify-loop:
  iterations: 1
  nodes:
    requirements-approval:
      choice: "proceed"
      comment: "Requirements clear"
    requirements-clarify:
      output: "Requirements check complete"
      update_vars:
        requirements_checklist_status: "COMPLETE"
```

**Mock for iterative path (2 iterations: continue then proceed)**:
```yaml
requirements-clarify-loop:
  iterations: 2
  nodes:
    requirements-approval:
      - choice: "continue"
        comment: "Need to add verification strategy"
      - choice: "proceed"
        comment: "Supplemented"
    requirements-clarify:
      - output: "Adding verification strategy..."
        update_vars:
          requirements_checklist_status: "INCOMPLETE: Verification strategy pending"
      - output: "Requirements complete"
        update_vars:
          requirements_checklist_status: "COMPLETE"
```

**Convergence constraint**: Final iteration must satisfy BOTH:
- `clarify_decision == "proceed"` (from approval mock)
- `requirements_checklist_status == "COMPLETE"` (from agent update_vars)

### Stage 6: e2e-verify-loop (loop)

**Scenario A — Happy path (e2e passes first try)**:
```yaml
e2e-verify-loop:
  iterations: 1
  nodes:
    e2e-runner:
      output: "E2E tests all passed"
      update_vars:
        e2e_status: "passed"
    e2e-notify:
      output: "Notification sent"
    e2e-approval:
      choice: "retry"
```
Note: e2e-notify and e2e-approval are skipped by `execute_when` but still need mock defs in strict mode.

**Scenario B — Failure + retry then pass**:
```yaml
e2e-verify-loop:
  iterations: 2
  nodes:
    e2e-runner:
      - output: "E2E failed: 3 cases not passing"
        update_vars:
          e2e_status: "failed"
      - output: "E2E all passed"
        update_vars:
          e2e_status: "passed"
    e2e-notify:
      - output: "Notified developer"
      - output: "Notified developer"
    e2e-approval:
      - choice: "retry"
        comment: "Fix case #3, #7, #12"
      - choice: "retry"
        comment: ""
```

**Scenario C — Failure + skip**:
```yaml
e2e-verify-loop:
  iterations: 1
  nodes:
    e2e-runner:
      output: "E2E failed: cannot fix"
      update_vars:
        e2e_status: "failed"
    e2e-notify:
      output: "Notified"
    e2e-approval:
      choice: "skip"
      comment: "Known issue, fix later"
```

---

## 2. Swarm Template Mock Patterns

### tech-decision.yaml (debate, 3 rounds)

**Auto-vars**: `decision_synthesis`, `decision_consensus_score`, `decision_rounds_used`, `decision_expert_count`, `decision_experts`

**User outputs mapping**:
```yaml
outputs:
  "$vars.decision": "$vars.decision_synthesis"
  "$vars.consensus": "$vars.decision_consensus_score"
```

**Mock**:
```yaml
decision:
  output: "Tech selection conclusion: adopt PostgreSQL + Drizzle ORM"
  update_vars:
    decision: "Adopt PostgreSQL + Drizzle ORM"
    consensus: 0.85
```

**Key**: `consensus_score` should be >= `consensus_threshold` (typically 0.75) for consensus to be reached.

### fullstack-dev.yaml (dispatch, DAG)

**Expert depends_on**: `frontend-developer` depends_on `backend-architect`; `code-reviewer` depends_on both.

**Mock**:
```yaml
implement:
  output: "Full-stack development complete. Frontend: React + Next.js; Backend: Hono + SQLite"
  update_vars:
    implement_status: "completed"
```

### code-review.yaml (review, 1 round)

**Simplest pattern**: One round parallel + Host synthesis.

```yaml
review:
  output: "Code review complete. No serious issues, 3 suggestion items."
```

---

## 3. Golden Fixture Examples

### Linear Workflow

```yaml
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
      status: "completed"
      vars:
        greeting: "hello Alice"
      node_trace:
        executed: [agent-greet, condition-check, bash-report]
        skipped: [bash-fallback]
      node_outputs:
        bash-report:
          output: "Report: hello Alice"
```

### Branch + DAG

```yaml
scenarios:
  - name: "high score → approve"
    mocks:
      agent-analyze:
        outputs:
          score: "0.85"
      agent-approve:
        outputs:
          decision: "approved"
      agent-reject:
        outputs:
          decision: "rejected"
      bash-notify:
        output: "Decision: approved"
    assertions:
      status: "completed"
      vars:
        score: "0.85"
        decision: "approved"
      node_trace:
        executed: [agent-analyze, condition-route, agent-approve, bash-notify]
        skipped: [agent-reject]
```

### Loop with Convergence

```yaml
scenarios:
  - name: "loop converges at iteration 3"
    mocks:
      agent-init:
        update_vars:
          counter: "0"
          target: "3"
      loop-retry:
        iterations: 3
        nodes:
          agent-try:
            - update_vars: { counter: "1", attempt_status: "failed" }
            - update_vars: { counter: "2", attempt_status: "failed" }
            - update_vars: { counter: "3", attempt_status: "success" }
          bash-log:
            output: "logged"
      agent-done:
        output: "done"
    assertions:
      status: "completed"
      vars:
        attempt_status: "success"
        counter: "3"
```

### Swarm Node

```yaml
scenarios:
  - name: "swarm review"
    mocks:
      agent-prepare:
        output: "Code snippet prepared"
        update_vars:
          code: "function hello() { return 'world' }"
      swarm-review:
        output: "Review conclusion: code quality good, suggest adding type annotations"
        update_vars:
          review_result: "approved"
      bash-notify:
        output: "Notification sent"
    assertions:
      status: "completed"
      vars:
        review_result: "approved"
      node_trace:
        executed: [agent-prepare, swarm-review, bash-notify]
```

### Failure Path

```yaml
scenarios:
  - name: "build failure halts pipeline"
    mocks:
      agent-setup:
        output: "setup done"
      bash-build:
        status: "failed"
        output: "error: compilation failed"
        exit_code: 1
        error: "compilation failed"
      bash-deploy:
        output: "deployed"
      bash-notify:
        output: "notified"
    assertions:
      status: "failed"
      node_trace:
        executed: [agent-setup, bash-build]
        skipped: [bash-deploy, bash-notify]
      node_outputs:
        bash-build:
          status: "failed"
```

---

## 4. Complex Mock Patterns

### Per-Iteration Loop Mock Array

```yaml
loop-node:
  nodes:
    inner-agent:
      # Iteration 0 (first): fails
      - output: "attempt 1 failed"
        update_vars:
          status: "failed"
          attempt: "1"
      # Iteration 1 (second): succeeds
      - output: "attempt 2 succeeded"
        update_vars:
          status: "success"
          attempt: "2"
    inner-bash:
      # Same mock for all iterations
      output: "logged"
```

### Approval with Comment Chain

When downstream node references `$approval-node.output.comment`:

```yaml
# Approval mock MUST provide comment
requirements-approval:
  choice: "continue"
  comment: "Need to add API security design section"

# Downstream agent receives comment via $requirements-approval.output.comment
requirements-clarify:
  output: "Supplemented API security design"
  update_vars:
    requirements_checklist_status: "INCOMPLETE: Security section pending review"
```

### Swarm Auto-Vars Assertion

```yaml
assertions:
  vars:
    idea-research_synthesis: "Research conclusion..."
    idea-research_expert_count: 3
    idea-research_rounds_used: 2
```

Note: Auto-vars are written by the engine during real execution. In simulation, the swarm mock's `output` becomes the synthesis, and `outputs`/`update_vars` can set specific auto-vars.

### Mixed Real + Mock Execution

```yaml
scenarios:
  - name: "real bash + mocked agents"
    real_execution: [bash-lint]     # Only bash/python can be real
    mocks:
      agent-prepare:
        output: "prepared"
      bash-lint:                    # Still needs mock def even if marked real
        output: "lint passed"
    assertions:
      status: "completed"
```

### __status Control Signal

```yaml
build:
  output: "Compilation failed: 3 type errors"
  update_vars:
    __status: "failed"
    error_detail: "3 type errors"
```

This simulates "agent/bash succeeded at execution level but business logic failed":
- Node execution status: `failed` (overridden by `__status`)
- VarPool: `error_detail` is written, `__status` is NOT written (control signal)
- Downstream: All dependent nodes are skipped

---

## 5. Assertion Patterns

### Comprehensive Happy Path

```yaml
assertions:
  status: "completed"
  vars:
    branch: "feat/my-feature"
    build_status: "success"
    deploy_status: "deployed"
  node_trace:
    executed: [init, build, test, deploy]
    skipped: [rollback, notify-failure]
    order: [init, build, test, deploy]
  node_outputs:
    build:
      output: "Build successful"
      status: "completed"
    deploy:
      outputs:
        deploy_url: "https://staging.example.com"
  logs:
    build:
      contains: ["[mock] bash completed"]
      not_contains: ["error", "failed"]
```

### Minimal Assertion

```yaml
assertions:
  status: "completed"
```

### Failure Path Assertion

```yaml
assertions:
  status: "failed"
  node_trace:
    executed: [init, build]
    skipped: [test, deploy, notify-success]
  node_outputs:
    build:
      status: "failed"
  logs:
    build:
      contains: ["failed"]
```

### Vars Partial Check

Only assert the vars you care about — extra vars in the pool are ignored:

```yaml
assertions:
  vars:
    build_status: "success"     # Only checks this key; other vars ignored
```
