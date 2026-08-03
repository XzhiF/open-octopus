# Node Patterns Reference

Typical usage patterns and working YAML examples for each of the 9 node types.

---

## Design Philosophy

1. **Agent is first citizen** — prefer agent nodes; bash/python for deterministic tasks only
2. **Coordinator + executor separation** — parent agent orchestrates, sub-agents do the heavy lifting
3. **Reuse installed resources** — query `registry.json` before hardcoding agent names
4. **Use Notify subsystem** — don't hardcode `hermes send` in bash nodes
5. **Workflow is tech-stack agnostic** — don't hardcode npm/mvn/gradle, let agent detect

---

## 1. bash — Side-Effect Scripts

### Simple cleanup
```yaml
- id: cleanup
  type: bash
  bash: rm -rf $vars.tmp_dir
  timeout: 15
```

### Status reporting
```yaml
- id: report
  type: bash
  depends_on: [build]
  bash: |
    echo "Build status: $vars.build_status"
    echo "Artifacts: $(ls $vars.output_dir)"
```

### Heredoc for large content (avoid shell injection)
```yaml
- id: output-synthesis
  type: bash
  depends_on: [review]
  bash: |
    cat << 'SWARM_EOF'
    $vars.review_synthesis
    SWARM_EOF
```

> ⚠️ Never `echo $vars.xxx_synthesis` directly — variable content may contain shell special characters. Use heredoc.

---

## 2. python — Data Processing

### Simple computation
```yaml
- id: parse
  type: python
  inputs:
    threshold: "0.8"
  python: |
    import os
    threshold = float(os.environ["threshold"])
    result = threshold * 100
    print(f"{result:.1f}")
```

### Data transformation
```yaml
- id: transform
  type: python
  inputs:
    data: "$vars.raw_data"
  python: |
    import os, json
    data = json.loads(os.environ["data"])
    transformed = [{"id": d["id"], "score": d["value"] * 2} for d in data]
    print(json.dumps(transformed))
```

---

## 3. agent — AI Agent Patterns

### Minimal agent
```yaml
- id: greet
  type: agent
  prompt: |
    Check current git status, list files, report briefly.
```

### Coordinator + sub-agents (core pattern)
```yaml
- id: design
  type: agent
  model: pro-max
  agents:
    devil-advocate:
      description: "Devil's advocate — review solution completeness."
      agent_file: "~/.octopus/resources/installed/agents/built-in/devil-advocate/devil-advocate.md"
      model: pro-max
      tools: ["Read", "Grep", "Write"]
      prompt: |
        Review $vars.solution_file, write challenges to
        $vars.output_dir/03-solution.challenges.devil.md.
        After Write, return 1 line confirmation.
  prompt: |
    You are the coordinator. Delegate devil-advocate.
    After file is in place, generate a lightweight index (don't re-narrate content).

    ## Output JSON (last line)
    {"vars_update":{"challenge_file":"$vars.output_dir/03-solution.challenges.index.md","conclusion":"<2-3 sentences>"}}
```

**Sub-agent discipline:**
- Parent prompt does NOT narrate sub-agent content; sub-agent Writes to disk, parent reads summary
- Sub-agents use `agent_file` for installed resources
- Sub-agent `tools` whitelist to minimum needed
- Sub-agent output protocol: 1-line confirmation; long text must Write to disk
- Visual/screenshot analysis MUST use sub-agent (prevents image data polluting main session)

### Goal mode
```yaml
- id: analyze
  type: agent
  goal: "Analyze root cause of issue #$vars.issue_id, output JSON {root_cause, severity}"
  constraints:
    - "Only read src/ and tests/ directories"
    - "Do not modify any files"
  planning:
    tools: [Read, Grep, Glob, Bash]
    disallowed_tools: [Write, Edit]
    verify: true
  outputs:
    severity: "$last_output.severity"
```

### Skills loading
```yaml
- id: create-skill
  type: agent
  skills: ["octo-skill-creator"]
  prompt: |
    Use octo-skill-creator to create a new skill for the user.
    Requirement: $vars.skill_requirement
```

### Agent output protocol (vars_update / __status)
```yaml
# Last line of agent response — pure JSON (no code block)
{"vars_update":{"build_passed":"true","conclusion":"<2-3 sentences>"}}

# __status control signal (not written to VarPool)
{"vars_update":{"__status":"failed","error_detail":"compilation error"}}
```

| `__status` | Effect |
|------------|--------|
| `"failed"` | Node marked failed → engine stops downstream nodes |
| Not set | Node completes normally |

---

## 4. condition — Routing

### Basic routing
```yaml
- id: route
  type: condition
  cases:
    - when: '$vars.severity == "critical"'
      then: urgent-fix
    - when: '$vars.severity == "high"'
      then: priority-fix
    - when: default
      then: standard-fix
```

### String comparison (quotes required)
```yaml
# ✅ Correct
- when: '$vars.status == "passed"'

# ❌ Wrong — missing quotes
- when: '$vars.status == passed'
```

---

## 5. approval — Human Gate

### Standard approval
```yaml
- id: deploy-gate
  type: approval
  depends_on: [build]
  options:
    - { label: "Approve", value: "approved" }
    - { label: "Reject", value: "rejected" }
  approval_timeout: 3600
  on_reject: rollback
```

### Unattended mode (auto_answers)
```yaml
auto_answers:
  - pattern: ".*"
    answer: "proceed"

nodes:
  - id: deploy-gate
    type: approval
    options:
      - { label: "Proceed", value: "proceed" }
      - { label: "Cancel", value: "cancel" }
    approval_timeout: 0  # Immediately times out → auto_answers kicks in
```

---

## 6. loop — Iterative Execution

### Retry with break_when
```yaml
- id: fix-loop
  type: loop
  max_iterations: 3
  break_when: '$vars.all_passed == "true"'
  nodes:
    - id: verify-and-fix
      type: agent
      timeout: 3600
      prompt: |
        Round $iteration: detect lint/build/test failures, fix them.
        Last line:
        {"vars_update":{"all_passed":"<true|false>","failure_summary":"<summary>"}}
```

### Loop with per-iteration progression
```yaml
- id: requirements-loop
  type: loop
  break_when: '$vars.checklist_status == "COMPLETE"'
  max_iterations: 5
  nodes:
    - id: review
      type: approval
      options:
        - { label: "Continue", value: "continue" }
        - { label: "Done", value: "proceed" }
      outputs:
        "$vars.decision": "$last_output"
    - id: clarify
      type: agent
      depends_on: [review]
      execute_when: '$vars.decision != "proceed"'
      prompt: "Clarify based on $review.output.comment"
      outputs:
        "$vars.checklist_status": '"COMPLETE"'
```

---

## 7. swarm — Multi-Expert Collaboration

### Review (1 round, parallel)
```yaml
- id: audit
  type: swarm
  topic: "Review this code: $vars.code"
  mode: review
  output_format: structured
  experts:
    - role: security-engineer
      perspective: "Focus on injection and auth bypass"
      prompt: "Review security line by line"
    - role: performance-engineer
      perspective: "Focus on N+1 queries and memory leaks"
      prompt: "Review performance impact"
```

### Debate (multi-round)
```yaml
- id: decision
  type: swarm
  topic: "Database strategy: Vitess vs Citus vs app-level sharding"
  mode: debate
  rounds: 5
  consensus_threshold: 0.85
  experts:
    - role: dba-architect
      perspective: "Data consistency and sharding strategy"
      prompt: "Evaluate sharding key design"
    - role: backend-engineer
      perspective: "Application change scope"
      prompt: "Evaluate ORM compatibility"
    - role: sre-engineer
      perspective: "Operational complexity"
      prompt: "Evaluate K8s operator maturity"
```

### MOA (cross-provider)
```yaml
- id: cross-model
  type: swarm
  topic: "Evaluate microservice split: $vars.arch_spec"
  mode: moa
  rounds: 2
  experts:
    - role: architect
      engine: claude
      model: pro-max
      prompt: "Architecture assessment"
    - role: cost-analyst
      engine: pi
      model: pro-max
      prompt: "Cost and ROI analysis"
  aggregator:
    role: moa-aggregator
    model: pro-max
    prompt: "Synthesize all expert outputs into unified report."
```

> See `references/swarm-modes.md` for complete swarm documentation.

---

## 8. interaction — Human-in-the-Loop

### Basic user feedback loop
```yaml
- id: design-review
  type: interaction
  interaction_display: modal
  interaction_max_rounds: 10
  interaction_exit_when: '$vars.user_approved == "true"'
  interaction_agent:
    prompt: |
      Present the current design draft to the user.
      Ask for specific feedback on each section.
      If user says "approved" or "looks good", set user_approved=true.
    model: pro
```

### Panel interaction with skills
```yaml
- id: requirements-gathering
  type: interaction
  interaction_display: panel
  interaction_max_rounds: 20
  interaction_exit_when: '$vars.requirements_complete == "true"'
  interaction_timeout: 300
  interaction_agent:
    skills: ["superpowers-zh/brainstorming"]
    goal: "Gather complete requirements from the user"
    constraints:
      - "Ask one question at a time"
      - "Summarize after each answer"
    prompt: |
      Interview the user about their requirements.
      Cover: scope, constraints, acceptance criteria, edge cases.
      When all areas are covered, ask if requirements are complete.
```

---

## 9. sub_workflow — Nested Workflows

### Linked execution
```yaml
- id: run-tests
  type: sub_workflow
  depends_on: [build]
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

### Error handling
```yaml
- id: optional-analysis
  type: sub_workflow
  workflow: "workflows/deep-analysis.yaml"
  on_error: continue  # Don't fail parent if child fails
  input_mapping:
    target: "$vars.analysis_target"
  output_mapping:
    report: "$vars.analysis_report"
```

### Parent context access (inside child workflow)
```yaml
# Inside the child workflow's nodes:
- id: child-task
  type: agent
  prompt: |
    Parent variable: $parent.var_pool.build_status
    Parent input: $parent.input_values.project_name
    Parent node output: $parent.build.outputs.artifact_path
    Grandparent var: $ancestor[1].var_pool.root_dir
```

---

## Common Patterns

### Agent-driven verify-fix loop
```yaml
- id: fix-loop
  type: loop
  max_iterations: 3
  break_when: '$vars.all_passed == "true"'
  nodes:
    - id: verify
      type: agent
      prompt: |
        Round $iteration: check lint/build/test. Fix failures.
        Last line: {"vars_update":{"all_passed":"<true|false>"}}
```

### Multi-reviewer parallel + index convergence
```yaml
- id: challenge
  type: agent
  agents:
    devil-advocate:
      agent_file: "~/.octopus/resources/installed/agents/built-in/devil-advocate/devil-advocate.md"
      tools: [Read, Write]
      prompt: "Write challenges to $vars.output_dir/challenges.devil.md"
    feasibility-reviewer:
      agent_file: "~/.octopus/resources/installed/agents/agency-agents-zh/engineering-software-architect/engineering-software-architect.md"
      tools: [Read, Write]
      prompt: "Write feasibility to $vars.output_dir/challenges.feasibility.md"
  prompt: |
    Delegate both sub-agents. After both files are written,
    generate a lightweight index file pointing to both reports.
    Do NOT re-narrate their content.
```

### Visual isolation (screenshot analysis)
```yaml
- id: e2e-test
  type: agent
  agents:
    vision-analyzer:
      description: "Analyze screenshots. Delegate when visual inspection needed."
      agent_file: "~/.octopus/resources/installed/agents/built-in/vision-analyzer/vision-analyzer.md"
      model: pro
      tools: ["Bash", "Read"]
  prompt: |
    Run E2E tests. When screenshot analysis needed, delegate vision-analyzer.
    Only take text conclusions from it.
```
