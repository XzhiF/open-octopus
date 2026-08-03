# Swarm Modes Reference

Complete guide for the 5 swarm collaboration modes.

---

## When to Use Swarm

| Scenario | Recommended Mode | Reason |
|----------|-----------------|--------|
| Code review, security audit | **review** | Multi-perspective parallel review, 1 round |
| Tech selection, architecture decisions | **debate** | Multi-round discussion to converge分歧 |
| Full-stack development, multi-step tasks | **dispatch** | Tasks have dependencies, need DAG scheduling |
| Open-ended problems, incident diagnosis | **swarm** | Router auto-selects mode and experts |
| Multi-model analysis, cross-provider | **moa** | Fan-out + Aggregator, supports mixed AI engines |

**Don't use swarm for:**
- Single-expert tasks → use `type: agent`
- Deterministic scripts → use `type: bash` / `type: python`
- Human approval needed → use `type: approval`

---

## Mode 1: Review — Parallel Review

All experts execute 1 round simultaneously. Host synthesizes final report. No rounds, no consensus check.

```yaml
- id: audit
  type: swarm
  topic: "Review this API endpoint security: $vars.api_spec"
  mode: review
  output_format: structured
  experts:
    - role: security-engineer
      perspective: "Focus on injection and auth bypass"
      prompt: "Review code security line by line"
    - role: performance-engineer
      perspective: "Focus on N+1 queries and memory leaks"
      prompt: "Review performance impact"
```

**Use cases**: Code review, document proofreading, security scanning, compliance checking.

### Constraints
- `experts` ≥ 1 (non-dynamic)
- `rounds` is ignored (fixed 1 round)

---

## Mode 2: Debate — Multi-Round Discussion

Multiple rounds of discussion. Host evaluates consensus after each round. Stops when threshold reached or Host judges no further discussion needed.

```yaml
- id: decision
  type: swarm
  topic: "Database migration: Vitess vs Citus vs app-level sharding"
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

**Consensus mechanism:**
```
Each round end → Host evaluates consensus_score (0.0-1.0) + should_continue
  score >= threshold → early termination
  should_continue = false → early termination
  else → next round (experts see all previous rounds)
```

### Constraints
- `experts` ≥ 2 (non-dynamic)
- `rounds` ≥ 1
- `consensus_threshold` recommended: 0.75-0.85 (below 0.5 = no real discussion)

---

## Mode 3: Dispatch — DAG Scheduling

Experts form a DAG based on `depends_on`. Executed by level, parallel within levels. Upstream output injected into downstream prompts.

```yaml
- id: implement
  type: swarm
  topic: "Implement user dashboard: $vars.feature_spec"
  mode: dispatch
  failure_policy: fail_fast
  experts:
    - role: backend-architect
      task: "Design and implement API layer"
      tools: [Read, Write, Edit, Bash, Grep]
    - role: frontend-developer
      task: "Implement frontend components"
      depends_on: [backend-architect]
      tools: [Read, Write, Edit, Grep]
    - role: code-reviewer
      task: "Review all changes"
      depends_on: [backend-architect, frontend-developer]
```

**DAG execution:**
```
Level 0: [backend-architect]           ← No dependencies, executes first
Level 1: [frontend-developer]          ← Waits for L0
Level 2: [code-reviewer]              ← Waits for L0+L1
```

**Context passing:**
- Direct dependency (`depends_on`): Structured summary + first N chars of detail
- Indirect upstream: Structured summary only
- Each expert must append ````summary` JSON block at end of output for downstream consumption

### Constraints
- `experts` ≥ 1 (non-dynamic)
- Expert-level `depends_on` references must exist among expert roles
- Default `failure_policy`: `fail_fast`

---

## Mode 4: Swarm (Dynamic) — Router Auto-Orchestration

Router selects experts and mode from installed agents resource library. Best for open-ended problems.

```yaml
- id: investigate
  type: swarm
  topic: "Production P0 incident diagnosis: $vars.incident_context"
  mode: swarm
  dynamic: true
  max_experts: 5
  budget: 200000
  expert_defaults:
    model: se
```

**Router 2-stage selection:**
1. Keyword pre-filter: topic tokenization → match installed agents name/description → top 30 candidates
2. LLM selection: `se` model selects 2-5 experts + decides mode

### Constraints
- `dynamic: true` recommended
- `max_experts` required when `dynamic: true`
- `budget` recommended to prevent token explosion

---

## Mode 5: MOA — Mixture of Agents

Multi-expert parallel Fan-out, with a dedicated **Aggregator** to synthesize all outputs. Supports Per-Expert Engine (cross-provider).

```yaml
- id: cross-model-analysis
  type: swarm
  topic: "Evaluate microservice split: $vars.arch_spec"
  mode: moa
  rounds: 2
  timeout: 300
  experts:
    - role: architect
      engine: claude
      model: pro-max
      prompt: "Architecture assessment"
    - role: cost-analyst
      engine: pi
      model: pro-max
      prompt: "Cost and ROI analysis"
    - role: devops
      engine: claude
      model: pro
      prompt: "Operational and deployment assessment"
  aggregator:
    role: moa-aggregator
    model: pro-max
    prompt: |
      Synthesize all expert outputs into a unified report.
      Mark consensus points and disagreements, provide final recommendation.
```

**MOA execution flow:**
```
Fan-out: All experts execute in parallel (possibly cross-provider)
  ↓
Aggregator: Collects all expert outputs, synthesizes unified report
  ↓
(Optional) Multi-round: rounds > 0 → experts see Aggregator feedback and execute again
```

### MOA vs Review

| Aspect | review | moa |
|--------|--------|-----|
| Synthesizer | Host (built-in) | Aggregator (explicitly defined) |
| Cross-provider | ❌ | ✅ Per-Expert Engine |
| Rounds | Fixed 1 | 0-5 |
| Use case | Same model, multi-perspective | Multi-model cross-validation |

### Constraints
- `experts` ≥ 2 (non-dynamic)
- `aggregator` is **required**
- `rounds` range: 0-5

---

## ExpertDef — Expert Definition

```yaml
experts:
  - role: expert-name              # Required — role identifier
    agent_file: "~/.octopus/resources/installed/agents/{group}/{name}/{name}.md"
    prompt: "inline instructions"  # Inline prompt (at least one of agent_file/prompt)
    perspective: "viewpoint"       # Perspective injected into prompt
    task: "specific task"          # [dispatch] task description
    depends_on: [other-expert]     # [dispatch] dependency on other expert roles
    tools: [Read, Write, Bash]     # Allowed tools
    disallowed_tools: [Edit]       # Disallowed tools
    model: pro                     # Model override
    engine: claude                 # AI provider engine
    skills: ["octo-x"]             # Skills to inject
```

### Cross-Provider Experts (Per-Expert Engine)

```yaml
experts:
  - role: architect
    engine: claude        # Claude engine
    model: pro-max
  - role: cost-analyst
    engine: pi            # Pi provider (Qwen/GLM)
    model: pro-max
```

**Engine priority**: `expert.engine` → `node.engine` → `workflow.engine` → `"claude"`

### Reusing Installed Resources

```yaml
experts:
  - role: product-manager
    agent_file: "~/.octopus/resources/installed/agents/agency-agents-zh/product-manager/product-manager.md"
    perspective: "Focus on user retention and monetization"
```

---

## Host — Synthesizer

Host is swarm's built-in synthesis role, generates final report after all experts complete.

```yaml
host:
  role: host-moderator
  model: pro
  prompt: |
    You are the discussion host.
    Extract consensus and disagreements from all perspectives.
    Synthesize into a feature list.
  perspective: "Balance technical feasibility with business value"
```

**Degradation chain**: `host.model ?? pro-max → pro → concatenation fallback (degraded: true)`

**No host declaration** → engine uses built-in default prompt:
- review: "Provide a comprehensive synthesis"
- debate: "Assess consensus (score 0-1) + should_continue"
- dispatch: "Integrate all expert outputs"
- moa: Uses `aggregator.prompt` (aggregator replaces host for synthesis)

---

## Context Management

### Context Tier

```yaml
context_tier: "200k"    # Default — standard models
context_tier: "1m"      # Large context — 4× parameter scaling
```

| Parameter | 200k | 1m |
|-----------|-------|------|
| Discussion token budget | 60K | 240K |
| Compression input limit | 20K chars | 80K chars |
| Upstream detail limit | 3K chars | 12K chars |
| head+tail trigger | 2.5K chars | 10K chars |

### Sliding Window + Progressive Compression (debate)

```yaml
context_window_rounds: 2      # Keep last 2 rounds full text (default)
context_token_budget: 60000   # Token budget (default, scales by tier)
```

- Recent N rounds: full text retained
- Older rounds: LLM (se) compressed to summary
- Over budget: emergency truncation, keep only last 1 round + all summaries

---

## Swarm Lifecycle Hooks

| Event | Trigger | Hook Context Variables |
|-------|---------|----------------------|
| `on_swarm_start` | Swarm node begins | `$hook.node_id`, `$hook.mode`, `$hook.expert_count`, `$hook.topic` |
| `on_expert_spawn` | Expert instance starts | `$hook.node_id`, `$hook.expert_role` |
| `on_expert_complete` | Expert execution done | `$hook.node_id`, `$hook.expert_role`, `$hook.status`, `$hook.duration_ms` |
| `on_swarm_round_end` | Debate round ends | `$hook.node_id`, `$hook.round`, `$hook.expert_count` |
| `on_swarm_consensus` | Consensus evaluation done | `$hook.node_id`, `$hook.consensus_score`, `$hook.should_continue` |
| `on_swarm_complete` | Swarm fully complete | `$hook.node_id`, `$hook.status`, `$hook.synthesis_preview`, `$hook.rounds_used` |

---

## Cross-Constraints Summary

| Mode | experts | aggregator | rounds | Expert depends_on | dynamic |
|------|---------|-----------|--------|-------------------|---------|
| review | ≥ 1 | ignored | ignored | ignored | optional |
| debate | ≥ 2 | ignored | ≥ 1 | ignored | optional |
| dispatch | ≥ 1 | ignored | ignored | ✅ | optional |
| swarm | optional | ignored | ignored | per Router | ✅ recommended |
| moa | ≥ 2 | ✅ required | 0-5 | ignored | optional |

### Hard Constraints
- `expert_pool` and `experts` are **mutually exclusive**
- `dynamic: true` requires `max_experts`
- `expert_pool` requires ≥ 2 experts
- `max_experts` cannot exceed `expert_pool` size
- Expert `depends_on` must reference existing expert roles
