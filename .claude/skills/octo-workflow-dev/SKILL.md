---
name: octo-workflow-dev
description: "When using this skill, AI agents create, edit, and debug Octopus YAML workflows — including 10 node types, sub-agent delegation, skills loading, Notify/Hook configuration, variable system, DAG orchestration, and auto-testing."
category: coding-assistant
tags: [octopus, workflow, YAML, agent, subagent, notify, hooks, swarm, interaction, sub_workflow, testing, simulator]
---

# Octopus Workflow Development Assistant

Wizard-style orchestrator for creating, editing, and debugging Octopus YAML workflows.

> **Schema authority**: `~/.octopus/workflow-schema.json` (source: `packages/core-pack/workflows/workflow-schema.json`)
> When unsure about any field, consult the schema first — don't write from memory.

---

## Step 1: Resource Discovery (Always Execute)

Before writing any workflow, query installed agents/skills to reuse existing resources:

```bash
# List installed agents (name + group + installPath)
node -e "
const d=JSON.parse(require('fs').readFileSync(
  require('os').homedir()+'/.octopus/resources/registry.json','utf8'));
d.resources.filter(r=>r.installed&&r.type==='agent')
  .forEach(r=>console.log(r.group+'/'+r.name+' → '+r.installPath+'/'+r.name+'.md'))
"

# List installed skills
node -e "
const d=JSON.parse(require('fs').readFileSync(
  require('os').homedir()+'/.octopus/resources/registry.json','utf8'));
d.resources.filter(r=>r.installed&&r.type==='skill')
  .forEach(r=>console.log(r.group+'/'+r.name+' → '+r.installPath+'/SKILL.md'))
"
```

- `agent_file` = role card → use `group/name.md` short path (e.g. `built-in/vision-analyzer.md`)
- `skills` = capability injection → plain name at node level, `group/name` in `requires`
- → See `references/requires-and-effort.md` for `requires` block and `effort` field details

---

## Step 2: Complexity Assessment

| Criteria | Path |
|----------|------|
| ≤ 3 nodes, types only `bash`/`python`/`agent` | **Quick Path** → Step 3 (light) → Step 5 → Step 6 |
| ≥ 4 nodes, OR includes `swarm`/`loop`/`sub_workflow`/`interaction`/`condition`/`approval` | **Full Wizard** → all steps |

---

## Step 3: Node Design

→ `references/node-schema.md` for field definitions
→ `references/node-patterns.md` for usage examples
→ `references/requires-and-effort.md` for `requires` block + `effort` field
→ If swarm: `references/swarm-modes.md`

**Principles**:
1. **Agent-first** — prefer `agent` nodes; `bash`/`python` for deterministic tasks only
2. **Coordinator + executor split** — parent prompt orchestrates, `agents` sub-agents do heavy work
3. **Skills loading** — use `skills` field, don't repeat skill content in prompt

---

## Step 4: DAG Composition (Full Wizard Only)

### ⚠️ depends_on — 铁律，不可违反

> **每一个非入口节点必须有 `depends_on`。没有例外。**
>
> 遗漏 `depends_on` = DAG 断裂。后果：
> - 节点意外并行执行（引擎视为独立根节点）
> - 前端可视化节点重叠（dagre 无法布局）
> - 下游节点拿到空变量（上游还没跑完就被调度）
> - 执行顺序与预期不符（数组顺序 ≠ 执行顺序，**只有 `depends_on` 决定顺序**）

```yaml
# ❌ 断裂 — setup 和 build 没有依赖关系，会并行跑
nodes:
  - id: setup
  - id: build          # 缺 depends_on: [setup]  ← 严重错误！
  - id: test
    depends_on: [build]

# ✅ 完整链 — 每个非入口节点都有明确上游
nodes:
  - id: setup
  - id: build
    depends_on: [setup]
  - id: test
    depends_on: [build]
```

**自检**：从最后一个节点反向追溯 `depends_on`，每条路径必须能追溯到某个入口节点。

> **Loop 子节点同样必须声明 `depends_on`** — 即使 `execution_mode: serial`，loop 内节点也需要明确依赖关系。

→ See `references/composition-rules.md` for DAG patterns and execution modes

---

## Step 5: Generate + Validate

```bash
node .claude/skills/octo-workflow-dev/scripts/validate-workflow.js ./my-workflow.yaml
```

**Validation levels**: L1 (Structure) → L2 (Cross-constraints) → L3 (Semantic) → Hard checks (depends_on completeness)

Auto-fix loop: errors → fix → re-validate → 0 errors → address warnings

---

## Step 6: Test Generation

→ See `references/testing.md` + `references/testing-reference.md`

---

## Quick Reference

### Key Constraints
- `apiVersion: octopus/v1` + `kind: Workflow` required
- ⚠️ **非入口节点必须有 `depends_on`** — 无例外，遗漏 = DAG 断裂
- ⚠️ **Loop 子节点必须有 `depends_on`** — 即使 serial 模式
- Node `id` must be unique (recursive)
- `goal` and `prompt` mutually exclusive
- Notify via providers+channels+hook, not bash
- `__status: "failed"` not `exit 1`
- String literals in outputs: `'"value"'`
- `agent_file` → `group/name.md` 短路径
- `requires.skills` → `group/name`; 节点 `skills` → 纯名称
- `effort` → `low` | `medium` | `high` | `xhigh` | `max` | number

### Reference Documents
| Document | Content |
|----------|---------|
| `references/node-schema.md` | All 10 node types field reference |
| `references/node-patterns.md` | Usage patterns + YAML examples |
| `references/requires-and-effort.md` | **`requires` 资源声明 + `effort` 推理深度** |
| `references/swarm-modes.md` | 5 swarm modes + ExpertDef + Host |
| `references/composition-rules.md` | DAG topology + execution modes |
| `references/special-conventions.md` | Hard constraints + conventions |
| `references/variables.md` | Variable system + expressions |
| `references/testing.md` | Test fixture generation + simulator |
| `references/testing-reference.md` | Mock patterns reference |
