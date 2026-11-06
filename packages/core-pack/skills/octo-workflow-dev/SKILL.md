---
name: octo-workflow-dev
description: "Create, edit, validate, simulate, run, debug, and release Octopus YAML workflows — 11 node types, DAG orchestration, variables, swarm modes, simulator fixtures, execution control, and the release/snapshot mechanism."
category: coding-assistant
tags: [octopus, workflow, YAML, agent, subagent, notify, hooks, swarm, interaction, sub_workflow, testing, simulator, release, snapshot]
---

# Octopus Workflow Development Assistant

Wizard-style orchestrator for creating, editing, validating, simulating, running, and releasing Octopus YAML workflows.

> **Schema authority**: the shared Zod parser — `packages/shared/src/types/workflow.ts` (NodeSchema/WorkflowSchema) + `packages/shared/src/yaml/parser.ts` (semantic pre-checks).
> When unsure about any field, consult `references/node-schema.md` first, then the parser source — don't write from memory. (The JSON-schema route `~/.octopus/workflow-schema.json` is retired; do not reference it in YAML headers.)

---

## Mandatory flow (workflow-dev tasks)

When you are the `workflow-author` in a workflow-dev task, follow this order. Do not skip a step, and do not start a second workflow until the current one is complete.

1. **Inventory** — list and read existing workflows before writing anything (see §1).
2. **Clarify** — one question at a time: new or modify, trigger, inputs/outputs, failure policy, resources, target project(s).
3. **Design + confirm** — present the node breakdown, `depends_on` edges, orchestration mode, risks, and a recommended direction. **Wait for explicit user confirmation before writing YAML.**
4. **Generate** — write `workflows/<name>.yaml` in the task home.
5. **Validate** — run the validator until 0 errors.
6. **Simulate** — write/complete `<name>.test.yaml`, run the simulator until it passes.
7. **Real run** — explain the parameters to the user; only run after they agree. The run gate requires validation + simulation.
8. **Debug** — diagnose first, explain the root cause, then fix the YAML and rerun.
9. **Complete one workflow** — ask **release or snapshot**; only after the user chooses, mark it complete.
10. **Wrap up** — ask whether to develop another workflow; when finished, finish the development and then ask whether to archive.

Real runs, releases, and archives always require the user's explicit words in this chat.

---

## Step 0: Workflow inventory (always do first)

Before designing, know what already exists.

- Task tools (workflow-dev sessions): `list_workflows` (includes snapshots + authored YAMLs + descriptions), `get_workflow { workflow_ref }` (full YAML + description / stage / version / inputs / node list).
- REST:
  - `GET /api/workspaces/:id/workflows` — workspace + installed built-ins; each item has `ref`, `name`, `description`, `stage`, `version`, `inputs`, `group`.
  - `GET /api/workflows/built-in` — installed built-ins only.
  - `GET /api/workspaces/:id/workflows/:ref` — full content + parsed definition.
- How to answer “what does this workflow do / when should I use it”: read `description`, `execution_mode`, `inputs`, and the node list; summarize the trigger, the main steps, and the expected output. Never invent behavior — if the YAML is unclear, say so.

Resource discovery (reuse existing agents/skills):

```bash
# Installed agents
node -e "
const d=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.octopus/resources/registry.json','utf8'));
d.resources.filter(r=>r.installed&&r.type==='agent').forEach(r=>console.log(r.group+'/'+r.name+' → '+r.installPath+'/'+r.name+'.md'))
"
# Installed skills
node -e "
const d=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.octopus/resources/registry.json','utf8'));
d.resources.filter(r=>r.installed&&r.type==='skill').forEach(r=>console.log(r.group+'/'+r.name+' → '+r.installPath+'/SKILL.md'))
"
```

- `agent_file` = role card → `group/name.md` short path (e.g. `built-in/architecture-explorer.md`)
- `skills` = capability injection → plain name at node level, `group/name` in `requires`
- → See `references/requires-and-effort.md` for `requires` blocks and `effort`.

---

## Step 1: Complexity assessment

| Criteria | Path |
|----------|------|
| ≤ 3 nodes, types only `bash`/`python`/`agent` | **Quick Path** → Step 2 (light) → Step 4 → Step 5 |
| ≥ 4 nodes, OR includes `swarm`/`loop`/`sub_workflow`/`interaction`/`condition`/`approval`/`octopus_agent` | **Full Wizard** → all steps |

---

## Step 2: Node design

→ `references/node-schema.md` for field definitions
→ `references/node-patterns.md` for usage examples
→ `references/requires-and-effort.md` for `requires` + `effort`
→ If swarm: `references/swarm-modes.md`

**Principles**:
1. **Agent-first** — prefer `agent` nodes; `bash`/`python` for deterministic tasks only.
2. **Coordinator + executor split** — a parent prompt orchestrates; `agents` sub-agents do heavy work.
3. **Skills loading** — use the `skills` field; don't repeat skill content in prompts.
4. **One workflow at a time** — do not interleave two designs.

---

## Step 3: DAG composition (Full Wizard only)

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

> **Loop 子节点同样必须声明 `depends_on`** — 即使 `execution_mode: serial`。

→ See `references/composition-rules.md` for DAG patterns and execution modes.

---

## Step 4: Generate + validate

Write the YAML to `workflows/<name>.yaml` in the task home. Then validate — all of these paths run the **same shared parser**:

```bash
# Primary (task-scoped; also records the result for the run gate)
# body: {"yaml": "<optional raw YAML>"} — omit yaml to validate the active file
curl -s -X POST "http://localhost:3001/api/tasks/<TASK_ID>/workflow-dev/validate" \
  -H "Content-Type: application/json" -d '{}'
```

```bash
# Workspace-scoped
curl -s -X POST "http://localhost:3001/api/workspaces/<WS_ID>/workflows/validate" \
  -H "Content-Type: application/json" -d '{"yaml":"..."}'
```

```bash
# Local script (fallback; locate it under this skill directory)
node <skill-dir>/scripts/validate-workflow.js ./workflows/<name>.yaml
```

**Validation levels**: L1 structure → L2 cross-constraints → L3 semantic → hard `depends_on` checks.

Auto-fix loop: errors → fix → re-validate → 0 errors → address warnings.

---

## Step 5: Simulate (required before a real run)

Fixture convention: a sibling `<name>.test.yaml` next to the workflow.

- Task tool: `simulate_workflow { scenario?, strict?, real_execution? }`.
- REST: `POST /api/tasks/<TASK_ID>/workflow-dev/simulate` with `{ scenario?, strict?, real_execution? }`.
- CLI: `octopus workflow simulate <workflow.yaml> [--test <fixture>] [--scenario name] [--no-strict] [--real node-ids]`.

Rules:
- `strict` defaults to true — every side-effecting node must have a mock.
- `real_execution` only accepts `bash` / `python` node ids.
- If there is no fixture, write one first: scenarios with mocks + assertions (`status`, `vars`, `node_trace`, `node_outputs`, `logs`).
- A failed simulation invalidates the run gate; fix and rerun.

→ See `references/testing.md` + `references/testing-reference.md`.

---

## Step 6: Real run

- Tool: `run_workflow { workflow_ref, input_values?, waiver? }`.
- The main chat normally runs **released** workflows only; a workflow-dev task may run snapshots too.
- **Hard gate**: an authored workflow must pass validation + simulation for its current content hash. Editing the YAML invalidates both.
- `waiver` is only for an explicit human request (“这次别仿真了”); pass the reason — it is recorded.
- Execution uses the normal `ExecutionService`, so the chat run card, DAG window, SSE, harness, and cost accounting are identical to any other chat run.
- Before running, tell the user which inputs you will pass.

---

## Step 7: Debug / correct / stop / retry

Tools (all in `octopus-workflow`):
- Inspect: `list_executions`, `get_execution`, `diagnose_execution`.
- Stop: `cancel_execution`.
- Pause / resume: `pause_execution`, `resume_execution { intervention? }`.
- Retry: `retry_node { node_id }`, `rerun_execution { reset_var_pool? }`.
- Surgical repair: `reset_execution_node`, `reload_execution_workflow { content? }`, `respond_approval`.
- REST equivalents live under `POST /api/workspaces/:id/executions/:executionId/{cancel,pause,resume,retry}` and `/repair/*`.

Rhythm:
1. `diagnose_execution` → explain the root cause to the user in plain language.
2. Decide: transient (retry) vs definition bug (fix YAML) vs environment (pause/cancel).
3. Fix the YAML → re-validate → re-simulate → rerun.
4. Never claim success without reading the execution result.

---

## Step 8: Release vs snapshot (must ask)

A workflow's discoverability is YAML metadata, not a separate registry record:

```yaml
name: my-workflow
version: 1.0.0        # required for release
stage: release        # release | snapshot; absent = snapshot (fail-closed)
```

- `stage: snapshot` (or absent): development only. Visible in the workspace/task, **hidden from the main chat's `list_workflows`**, and cannot be run from a normal main chat.
- `stage: release`: discoverable and runnable from ordinary chats.
- There is no publish endpoint and no version history: release = edit the YAML fields, then mark the workflow complete.
- `complete_workflow { ref, stage, confirmed }` records the choice. `stage: release` also copies the YAML to the main-agent workspace (`~/.octopus/agent/workflows/`) so default chats can see and run it; snapshot stays task-side only.
- **Always ask the user which one they want. Never default to release.**

---

## Step 9: Bring projects in (optional)

When a workflow needs to read/build/test a real repository, call `add_workspace_projects { projects: [...] }`. It binds the project names to the task and materialises their worktrees in the task workspace. The archive step later cleans these up exactly like a dev task.

---

## Step 10: Wrap up

1. Ask whether the user wants to develop another workflow.
2. When all planned workflows are complete: `finish_workflow_dev { confirmed: true }` → the task parks at `awaiting_archive`.
3. Ask whether to archive. Only after the user explicitly says “归档” call `start_archive { confirmed: true }`.
4. Archiving performs git sync / ADR + glossary merge / commit + push + PR / knowledge ingest / project cleanup. `done` is written by the server — never claim it yourself.

---

## Quick Reference

### Key Constraints
- `apiVersion: octopus/v1` + `kind: Workflow` required
- ⚠️ **非入口节点必须有 `depends_on`** — 无例外，遗漏 = DAG 断裂
- ⚠️ **Loop 子节点必须有 `depends_on`** — 即使 serial 模式
- Node `id` must be unique (recursive)
- `goal` and `prompt` mutually exclusive — `goal` = `/goal` 原生收敛语义（见 `references/node-schema.md` Goal Mode）；旧 `planning:` 块已废弃
- Notify via providers+channels+hook, not bash
- `__status: "failed"` not `exit 1`
- String literals in outputs: `'"value"'`
- `agent_file` → `group/name.md` 短路径
- `requires.skills` → `group/name`; 节点 `skills` → 纯名称
- `effort` → `low` | `medium` | `high` | `xhigh` | `max` | number
- `stage: release` requires `version`; absent `stage` = snapshot (fail-closed)
- Validate + simulate before a real run; editing invalidates both

### Reference Documents
| Document | Content |
|----------|---------|
| `references/node-schema.md` | All node types field reference |
| `references/node-patterns.md` | Usage patterns + YAML examples |
| `references/requires-and-effort.md` | **`requires` 资源声明 + `effort` 推理深度** |
| `references/swarm-modes.md` | 5 swarm modes + ExpertDef + Host |
| `references/composition-rules.md` | DAG topology + execution modes |
| `references/special-conventions.md` | Hard constraints + conventions |
| `references/variables.md` | Variable system + expressions |
| `references/testing.md` | Test fixture generation + simulator |
| `references/testing-reference.md` | Mock patterns reference |
