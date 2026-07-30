# octo-workflow-test — REFERENCE.md

Detailed mock data examples and patterns extracted from real workflow analysis.
Use as a lookup when generating fixtures for complex workflows.

---

## 1. xzf-dev.yaml Variable Flow (619-line flagship workflow)

### Stage 0: init (agent)

**Node definition**:
```yaml
- id: init
  type: agent
  prompt: "初始化: 检测分支、feature slug、remote 类型"
```

**Mock data**:
```yaml
init:
  output: "初始化完成。分支: feat/engine-init-sync, feature: engine-init-sync, remote: github"
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
| `idea-research_synthesis` | "研究结论: 涉及 engine 和 shared 两个包，无重大风险。3 个待澄清问题。" |
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
  output: "研究结论: 涉及 engine 和 shared 两个包，无重大风险。3 个待澄清问题。"
  update_vars:
    requirements_checklist_status: "INCOMPLETE: 缺少验证策略"
```

### Stage 2a: requirements-clarify-loop (loop)

**Loop definition**:
```yaml
- id: requirements-clarify-loop
  type: loop
  break_when: '$vars.clarify_decision == "proceed" && $vars.requirements_checklist_status == "COMPLETE"'
  max_iterations: 5
  nodes:
    - id: requirements-approval
      type: approval
      options:
        - { label: "继续", value: "continue" }
        - { label: "完成", value: "proceed" }
      outputs:
        "$vars.clarify_decision": "$last_output"
    - id: requirements-clarify
      type: agent
      depends_on: [requirements-approval]
      execute_when: '$vars.clarify_decision != "proceed" || $vars.requirements_checklist_status != "COMPLETE"'
      prompt: "根据 $requirements-approval.output.comment 补充需求..."
```

**Mock for happy path (1 iteration, immediate proceed)**:
```yaml
requirements-clarify-loop:
  iterations: 1
  nodes:
    requirements-approval:
      choice: "proceed"
      comment: "需求已明确"
    requirements-clarify:
      output: "需求检查完成"
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
        comment: "需要补充验证策略"
      - choice: "proceed"
        comment: "已补充完成"
    requirements-clarify:
      - output: "补充验证策略中..."
        update_vars:
          requirements_checklist_status: "INCOMPLETE: 验证策略待完善"
      - output: "需求全部完成"
        update_vars:
          requirements_checklist_status: "COMPLETE"
```

**Convergence constraint**: Final iteration must satisfy BOTH:
- `clarify_decision == "proceed"` (from approval mock)
- `requirements_checklist_status == "COMPLETE"` (from agent update_vars)

### Stage 2b: verification-clarify-loop (loop)

Same structure as 2a, different variable names:
- `$vars.verify_decision` (approval choice)
- `$vars.env_checklist_status` (agent vars_update)
- `break_when: '$vars.verify_decision == "proceed" && $vars.env_checklist_status == "COMPLETE"'`

### Stage 5: execution (agent with sub-agents)

```yaml
- id: execution
  type: agent
  outputs:
    "$vars.spec_status": "$last_output"
```

**Mock data**:
```yaml
execution:
  output: "所有 spec 执行完毕: 3/3 passed"
  update_vars:
    spec_status: "passed"
```

### Stage 6: e2e-verify-loop (loop)

**Loop definition**:
```yaml
- id: e2e-verify-loop
  type: loop
  break_when: '$vars.e2e_status == "passed" || $vars.e2e_decision == "skip"'
  max_iterations: 3
  nodes:
    - id: e2e-runner
      type: agent
      # sets $vars.e2e_status
    - id: e2e-notify
      type: bash
      depends_on: [e2e-runner]
      execute_when: '$vars.e2e_status == "failed"'
    - id: e2e-approval
      type: approval
      depends_on: [e2e-notify]
      execute_when: '$vars.e2e_status == "failed"'
      options:
        - { label: "重试", value: "retry" }
        - { label: "跳过", value: "skip" }
      outputs:
        "$vars.e2e_decision": "$last_output"
        "$vars.user_guidance": "$last_output.comment"
```

**Scenario A — Happy path (e2e passes first try)**:
```yaml
e2e-verify-loop:
  iterations: 1
  nodes:
    e2e-runner:
      output: "E2E 测试全部通过"
      update_vars:
        e2e_status: "passed"
    e2e-notify:
      output: "通知已发送"
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
      - output: "E2E 失败: 3 个 case 不通过"
        update_vars:
          e2e_status: "failed"
      - output: "E2E 全部通过"
        update_vars:
          e2e_status: "passed"
    e2e-notify:
      - output: "已通知开发者"
      - output: "已通知开发者"
    e2e-approval:
      - choice: "retry"
        comment: "请修复 case #3, #7, #12"
      - choice: "retry"
        comment: ""
```

**Scenario C — Failure + skip**:
```yaml
e2e-verify-loop:
  iterations: 1
  nodes:
    e2e-runner:
      output: "E2E 失败: 无法修复"
      update_vars:
        e2e_status: "failed"
    e2e-notify:
      output: "已通知"
    e2e-approval:
      choice: "skip"
      comment: "已知问题，后续修复"
```

### Stage 7: ship (agent)

```yaml
ship:
  output: "PR 已创建: https://github.com/XzhiF/octopus/pull/42"
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
  output: "技术选型结论: 采用 PostgreSQL + Drizzle ORM"
  update_vars:
    decision: "采用 PostgreSQL + Drizzle ORM"
    consensus: 0.85
```

**Key**: `consensus_score` should be >= `consensus_threshold` (typically 0.75) for consensus to be reached.

### fullstack-dev.yaml (dispatch, DAG)

**Expert depends_on**: `frontend-developer` depends_on `backend-architect`; `code-reviewer` depends_on both.

**Mock**:
```yaml
implement:
  output: "全栈开发完成。Frontend: React + Next.js; Backend: Hono + SQLite"
  update_vars:
    implement_status: "completed"
```

### code-review.yaml (review, 1 round)

**Simplest pattern**: One round parallel + Host synthesis.

```yaml
review:
  output: "代码审查完成。无严重问题，3 个建议项。"
```

---

## 3. Golden Fixture Examples (from V1 test suite)

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
        output: "代码片段已准备"
        update_vars:
          code: "function hello() { return 'world' }"
      swarm-review:
        output: "审查结论: 代码质量良好，建议添加类型注解"
        update_vars:
          review_result: "approved"
      bash-notify:
        output: "通知已发送"
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
  comment: "需要补充 API 安全设计章节"

# Downstream agent receives comment via $requirements-approval.output.comment
requirements-clarify:
  output: "已补充 API 安全设计"
  update_vars:
    requirements_checklist_status: "INCOMPLETE: 安全章节待审"
```

### Swarm Auto-Vars Assertion

```yaml
assertions:
  vars:
    idea-research_synthesis: "研究结论..."
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
  output: "编译失败: 3 个类型错误"
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
