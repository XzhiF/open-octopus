# Special Conventions Reference

Special node conventions, hard constraints, and the depends_on completeness check for Octopus workflows.

---

## Hard Constraints (Violations = Validation Errors)

### 1. Workflow Header Required

```yaml
# yaml-language-server: $schema=~/.octopus/workflow-schema.json
apiVersion: octopus/v1
kind: Workflow
name: my-workflow
```

### 2. Node ID Uniqueness

All node `id` values must be unique within the workflow (recursive across loop sub-nodes).

### 3. `goal` and `prompt` are Mutually Exclusive

Agent nodes cannot have both `goal` and `prompt`. Choose one:
- Standard mode: `prompt` (or `agent` + `agents`)
- Goal mode: `goal` + `constraints` + `planning`

### 4. `condition.cases` Default Must Be Last

```yaml
cases:
  - when: '$vars.severity == "critical"'
    then: urgent-fix
  - when: default              # Must be last
    then: standard-fix
```

### 5. Agent Node Must Have Content Source

At least one of: `agent`, `prompt`, `goal`, `agents`.

### 6. Swarm Cross-Constraints

- `expert_pool` and `experts` are mutually exclusive
- `mode: moa` requires `aggregator`
- `mode: moa` requires `experts` ≥ 2
- `mode: debate` requires `experts` ≥ 2
- `dynamic: true` requires `max_experts`
- Expert `depends_on` must reference existing expert roles

### 7. Notify Subsystem — No Hardcoded Notifications

```yaml
# ❌ Wrong — hardcoded hermes in bash
- id: notify
  type: bash
  bash: "hermes send 'Build done'"

# ✅ Correct — use providers + channels + notify hook
providers:
  hermes-cli:
    type: hermes
    timeout: 30
channels:
  default:
    provider: hermes-cli
    target: "telegram:channel"
hooks:
  on_node_success:
    - id: notify-build
      type: notify
      nodes: [build]
      channel: default
      template:
        severity: info
        title: "✅ Build passed"
        body: "$vars.conclusion"
```

### 8. Failure Signaling

Use `__status: "failed"`, not `exit 1`:

```yaml
# Agent last line
{"vars_update":{"__status":"failed","error_detail":"compilation error"}}
```

### 9. String Literals in Outputs

String literals require double-quoting:

```yaml
outputs:
  "$vars.status": '"ok"'           # ✅ Correct
  "$vars.status": "ok"             # ❌ Wrong — treated as expression
```

### 10. `context: continue` Prerequisite

Only valid when the previous node is also an `agent` type.

### 11. Workflow Is Tech-Stack Agnostic

Don't hardcode build tools in YAML:

```yaml
# ❌ Wrong
bash: "npm run build && npm test"

# ✅ Correct — let agent detect
prompt: "Detect the project build system and run tests"
```

---

## Depends_on Completeness Check (Hard Warning)

### The Rule

**Every non-first top-level node should have `depends_on` declared.** Nodes without `depends_on` in `execution_mode: auto` are treated as independent root nodes that execute in parallel with other roots.

### Why This Matters

| Problem | Cause |
|---------|-------|
| Nodes run in unexpected parallel order | No dependency edge → independent root |
| Frontend visualization overlaps nodes | dagre can't infer hierarchy |
| Downstream gets empty variable values | Upstream hasn't completed yet |
| Execution order ≠ array order | Only `depends_on` determines order |

### Validation Behavior

The `validate-workflow.js` script emits a **WARNING** (not error) for non-first top-level nodes without `depends_on`:

```
⚠ WARNING: Node "build" (position 2) has no depends_on — will execute as independent root
```

### Loop Sub-Nodes

Loop sub-nodes **must** have explicit `depends_on` even in `execution_mode: serial`:

```yaml
# ❌ Wrong — sub-nodes overlap in visualization
nodes:
  - id: step-a
  - id: step-b
  - id: step-c

# ✅ Correct — explicit dependency chain
nodes:
  - id: step-a
  - id: step-b
    depends_on: [step-a]
  - id: step-c
    depends_on: [step-b]
```

---

## Sub-Agent Delegation Discipline

### When Node Has `agents`

Parent prompt should **only orchestrate**: decompose tasks → delegate → collect conclusions.

**Heavy lifting (Write, Bash, long text) goes to sub-agents.**

```yaml
- id: design
  type: agent
  agents:
    writer:
      agent_file: "..."
      tools: [Read, Write]
      prompt: "Write design to $vars.output_dir/design.md"
  prompt: |
    Delegate writer to produce the design document.
    After file is in place, generate a 1-line summary.
    Do NOT narrate the document content.
```

### Sub-Agent Rules

1. Parent prompt does NOT re-narrate sub-agent report content
2. Sub-agents use `agent_file` for installed resources (query `registry.json`)
3. Sub-agent `tools` whitelist to minimum needed (`Read`/`Write`/`Grep`/`Bash`)
4. Sub-agent output protocol: 1-line confirmation; long text must Write to disk
5. Visual/screenshot analysis MUST use sub-agent (prevents image data polluting main session)

---

## Skills Loading Discipline

### Prompt vs Skill Separation

| Write in Prompt | Don't Write |
|----------------|-------------|
| "Use {skill-name} to complete X" | Repeat skill's specific steps/rules/templates |
| Orchestration order (skill A then B) | Parameters/formats/constraints already in skill |
| Business goal + input/output conventions | Instructions already in SKILL.md |

> **Principle**: Skill is "capability injection", prompt is "task orchestration". Prompt repeating skill content = token waste + instruction conflict risk.

---

## Hook System

### Event Types

| Event | Trigger | Common Use |
|-------|---------|-----------|
| `on_node_success` | Node completes (including skip) | Stage progress notification |
| `on_node_failure` | Node fails | Failure alert |
| `on_workflow_failure` | Workflow terminates | Failure summary |
| `on_success` | Workflow succeeds | Celebrate / deploy |
| `on_complete` | Regardless of outcome | Statistics |
| `on_cancel` | User cancels | Resource cleanup |
| `on_interrupt` | Process interrupted | Mark interrupt status |
| `on_retry` | Node retries | Retry count logging |
| `on_swarm_start` | Swarm begins | Swarm progress |
| `on_expert_spawn` | Expert starts | Expert allocation tracking |
| `on_expert_complete` | Expert done | Expert output audit |
| `on_swarm_round_end` | Debate round ends | Round progress |
| `on_swarm_consensus` | Consensus evaluated | Consensus score monitoring |
| `on_swarm_complete` | Swarm fully done | Swarm result notification |

### Three Hook Types

```yaml
hooks:
  on_node_success:
    # ① notify — recommended for notifications
    - id: notify-stage
      type: notify
      nodes: [setup]
      channel: default
      template: { severity: info, title: "🔨 Starting", body: "📂 $vars.output_dir" }

    # ② bash — side-effect script
    - id: cleanup-tmp
      type: bash
      nodes: [done]
      timeout: 30
      bash: |
        rm -rf $vars.tmp_dir 2>&1 || true

    # ③ agent — intelligent post-processing
    - id: summarize
      type: agent
      nodes: [output]
      timeout: 120
      prompt: "Read first 200 lines of $vars.final_file, generate release notice."
```

---

## Auto Answers — Unattended Mode

```yaml
auto_answers:                              # Global fallback
  - pattern: ".*"
    answer: "proceed"

nodes:
  - id: deploy
    type: agent
    auto_answers:                          # Node-level, merged with global
      - pattern: "continue?"
        answer: "yes"
```
