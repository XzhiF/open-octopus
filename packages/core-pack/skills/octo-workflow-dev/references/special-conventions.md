# Special Conventions Reference

Special node conventions, hard constraints, and the depends_on completeness check for Octopus workflows.

---

## Hard Constraints (Violations = Validation Errors)

### 1. Workflow Header Required

```yaml
apiVersion: octopus/v1
kind: Workflow
name: my-workflow
```

> YAML 头部不需要任何编辑器 schema 指令注释（旧 `schema` 头注释路线已废弃，K9）——权威 = shared Zod parser（`packages/shared/src/types/workflow.ts` + `packages/shared/src/yaml/parser.ts`）。

### 2. Node ID Uniqueness

All node `id` values must be unique within the workflow (recursive across loop sub-nodes).

### 3. `goal` and `prompt` are Mutually Exclusive

Agent nodes cannot have both `goal` and `prompt`. Choose one:
- Standard mode: `prompt` (or `agent` + `agents`)
- Goal mode: `goal` (+ optional `constraints` / `max_turns` / `max_budget_usd` / `tools` / `disallowed_tools`)

> 旧 `planning:` 块已废弃：parse 直接报迁移错误（`planning 已废弃: max_turns/max_budget_usd/disallowed_tools 提升为节点字段, verify 删除`）。见下方「Goal Mode 写作约定」。

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

## Goal Mode 写作约定（`/goal` 原生适配器）

goal 节点 = Claude Code `/goal` 语义：goal 文本全文（插值后）作为 condition，worker 干活 + **独立 evaluator 逐轮判 met/impossible**；收敛 → completed；未收敛烧到 `max_turns`/`max_budget_usd` 硬保险丝 → 节点 **failed**（error 携 `goal_not_met (<终态>)` + iterations 证据），无人值守里不响不算过。

写 condition 的四条硬约定：

1. **可判伪**：evaluator 只能对具体事实判真伪。"代码质量高" ❌ → "每条 AC 有命令输出/文件内容证据且验证通过" ✅。判伪是作者责任，goal 写得模糊的表现为烧满 max_turns 后 failed。
2. **ac 经插值进 condition**：引擎无 ac 概念，验收标准用 `$inputs.ac` / `$vars.xxx` 插值写进 goal 文本逐条列出（`goal` 字段身兼二职）。
3. **软退出条款**：condition 内写"同一阻塞点连续多轮无进展 → 停止迭代，把阻塞清单（现象/已尝试/需谁决策）落盘并以此收束"——教 evaluator 判 impossible 时给出可验收解释，而不是干烧。
4. **保险丝必配**：自治节点建议显式 `max_turns`（看板无人值守默认 200；审查/修正类 50 量级）；成本敏感再加 `max_budget_usd`。

**Turn 语义（K5）**：1 turn = 1 次 assistant API 往返；一轮内并行 tool_use 计 1 turn，每个 tool_result 回传开新 turn，`/goal` 续跑同样计 turn。`max_turns` 是 SDK 确定性终态，与 evaluator 软判定正交。

**上下文注入**：goal 模式全量注入上游结果与变量池（无任何截断），condition 文本本身应保持精炼。

```yaml
- id: develop
  type: agent
  goal: |
    完成以下开发目标并逐条满足验收判据：
    $inputs.goal
    验收判据（每条需可复核证据）：
    $inputs.ac
    若同一阻塞点连续多轮无进展，停止并输出阻塞清单文件，以此收束退出。
  max_turns: $inputs.max_turns   # string 插值 → 数值化；无效值视为未设置（不限制）
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
