# Variables Reference

Variable system, expression syntax, and cross-execution references for Octopus workflows.

---

## Reference Syntax

| Syntax | Meaning | Available In |
|--------|---------|-------------|
| `$vars.xxx` | Global variable pool | All nodes |
| `$node_id.output` | Previous node's stdout | Downstream nodes |
| `$node_id.output.xxx` | Previous node's output sub-field | Downstream nodes |
| `$inputs.xxx` | Workflow input parameters | Any node |
| `$last_output` | Current node's own output | `outputs` block only |
| `$iteration` | Loop current iteration (1-based) | Loop sub-nodes |
| `$ref:flow.yaml.node.key` | Cross-execution reference | All nodes |
| `$parent.var_pool.xxx` | Parent execution VarPool | Sub-workflow child nodes |
| `$parent.input_values.xxx` | Parent execution input params | Sub-workflow child nodes |
| `$parent.$nodeId.outputs.xxx` | Parent execution specific node output | Sub-workflow child nodes |
| `$ancestor[N].var_pool.xxx` | N-level ancestor VarPool (0=parent) | Nested sub-workflows |
| `$ancestor[N].$nodeId.outputs.xxx` | N-level ancestor node output | Nested sub-workflows |

---

## Writing to VarPool — `outputs` Block

```yaml
outputs:
  "$vars.result": "$last_output"           # Reference own stdout
  "$vars.status": "$last_output.status"    # Reference output sub-field
  "$vars.choice": "$last_output"           # Write to VarPool
  "$vars.count": "$vars.count + 1"         # Arithmetic expression
  "$vars.data": '"literal_string"'         # String literal (double-quoted)
```

### 5 Expression Types

1. **Self-reference**: `"$vars.result": "$last_output"`
2. **Sub-field**: `"$vars.status": "$last_output.status"`
3. **VarPool write**: `"$vars.key": "$last_output"`
4. **Arithmetic**: `"$vars.count": "$vars.count + 1"`
5. **String literal**: `"$vars.data": '"hello"'` — requires double-quoting

> The `$vars.` prefix is automatically stripped before writing to the pool. Both `"$vars.my_key"` and `"my_key"` work as output keys.

---

## Expression Evaluator

### Supported Operators

| Operator | Syntax | Example |
|----------|--------|---------|
| Equality | `==`, `!=` | `$vars.status == "passed"` |
| Numeric comparison | `<`, `>`, `<=`, `>=` | `$vars.attempt < 5` |
| Logical AND | `&&` | `$vars.a == "x" && $vars.b == "y"` |
| Logical OR | `\|\|` | `$vars.a == "x" \|\| $vars.b == "y"` |
| Logical NOT | `!` | `!$vars.done` |
| Set membership | `in` | `$vars.env in ['prod', 'uat']` |

### Rules

- **Strings MUST be quoted**: `$vars.status == "passed"` ✅ / `$vars.status == passed` ❌
- **`"default"` is special**: `condition` node's `when: default` always returns true, must be last case

---

## Cross-Execution References (`$ref:`)

```yaml
prompt: "Last scan results: $ref:security-scan.yaml.scan.vulnerabilities"
```

**Syntax**: `$ref:{workflow}.{node}.{key}`

**Resolution**:
- Searches the same workspace for the most recent `completed` execution of the referenced workflow
- Resolves the specified node's output key
- On resolution failure, keeps the original text (does not block execution)

---

## Agent Output Protocol

### vars_update (last line JSON)

Agent responds with pure JSON on the **last line** (no code block wrapper):

```json
{"vars_update":{"build_passed":"true","conclusion":"<2-3 sentences>"}}
```

### __status Control Signal

`__status` is a control signal (not written to VarPool):

| Value | Effect |
|-------|--------|
| `"failed"` | Node marked failed → engine stops downstream nodes |
| Not set | Node completes normally |

`__status` takes priority over exit code. Works for bash/agent/python nodes.

> **Don't use `exit 1` to mark business failure.** Use `__status: "failed"`.

---

## Variable Flow in Workflows

### Typical flow pattern

```
Node A (writes $vars.x via outputs or vars_update)
    ↓
Node B (reads $vars.x in prompt/bash/condition)
    ↓
Node C (reads $vars.x, writes $vars.y)
```

### DAG variable dependencies

```yaml
nodes:
  - id: analyze
    outputs:
      "$vars.severity": '"high"'

  - id: review-code
    depends_on: [analyze]
    prompt: "Review code with severity: $vars.severity"

  - id: review-security
    depends_on: [analyze]       # Parallel with review-code
    prompt: "Security review for severity: $vars.severity"

  - id: summary
    depends_on: [review-code, review-security]
    prompt: "Summarize both reviews"
```

### Loop variable progression

```yaml
- id: retry-loop
  type: loop
  break_when: '$vars.status == "passed"'
  max_iterations: 3
  nodes:
    - id: attempt
      type: agent
      prompt: "Attempt $iteration..."
      # vars_update progressively changes $vars.status
      # Final iteration must satisfy break_when
```

---

## Notify Template Variables

Templates in `hooks.*.template` support:

| Variable | Source |
|----------|--------|
| `$vars.*` | VarPool |
| `$inputs.*` | Workflow inputs |
| `$hook.*` | Hook context |
| `$nodeId.output.*` | Node output |
| `$notify.*` | Notify context |

### Filters

- Default value: `${vars.x | default:unknown}`
- Duration format: `${hook.total_duration_ms | duration}`
- Conditionals (max 3 levels): `{{#if challenge_count}}😈 $vars.challenge_count items{{/if}}`

### Hook Context Variables

| Variable | Description |
|----------|-------------|
| `$hook.failed_node_id` | Failed node ID (on_*_failure) |
| `$hook.error` | Error message |
| `$hook.final_status` | Final status (on_complete) |
| `$hook.completed_count` | Completed node count |
| `$hook.skipped_count` | Skipped node count |
| `$hook.failed_count` | Failed node count |
| `$hook.total_count` | Total node count |
| `$hook.total_duration_ms` | Total workflow duration |
| `$hook.interrupt_reason` | Interrupt reason (on_interrupt) |

---

## Swarm Auto-Variables

After a swarm node completes, the engine automatically writes these variables (`{id}` = node ID):

| Variable | Type | Description |
|----------|------|-------------|
| `{id}_synthesis` | string | Host synthesis report |
| `{id}_consensus_score` | number/null | Consensus score (debate) |
| `{id}_rounds_used` | number | Rounds actually used |
| `{id}_expert_count` | number | Number of experts |
| `{id}_experts` | string(JSON) | Expert roles JSON array |
| `{id}_history` | string(JSON) | Complete message history |
| `{id}_task_breakdown` | string(JSON) | Task breakdown (dispatch/swarm) |
| `{id}_budget_exhausted` | boolean | Budget exhausted? |
| `{id}_timeout_exceeded` | boolean | Timed out? |

```yaml
- id: report
  type: bash
  depends_on: [audit]
  bash: |
    echo "Synthesis: $vars.audit_synthesis"
    echo "Consensus: $vars.audit_consensus_score"
```
