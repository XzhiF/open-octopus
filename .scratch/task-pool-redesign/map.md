# Decision Map — Task Pool Redesign (v3, inheritance-revised)

> Wayfinder map. Living registry of decisions, fog, and decision tickets.
> PR #50 (`test-task-board`) is the seed; this redesign may overturn parts of it.
> Companion: `research-findings.md` (verified current-state gaps, file:line cited).

## Destination

A redesigned task pool where a requirement is **authored in a project-bound chatbot clone** (per-task skills/codebase context) producing a **spec (WHAT)**; on confirm, the scheduler dispatches — materializing **one workspace** (simple) or **orchestrating N workspaces** (composite, each own projects/workflow/vars/skills) with integration. Full kanban lifecycle, real-time SSE, complete UI/UX. xzf-dev becomes an opt-in pinnable spec-workflow, not the default.

## Notes (inherited from prior efforts — do NOT re-derive)

### From `research-findings.md` (verified current state of PR #50)
- /tasks chat uses `/api/chat/global` → scheduler clone + `octo-scheduler` SKILL (curl REST). Context-free. (gap #1,#4)
- `task-pool-system-prompt.ts` (WorkflowConfig-JSON producer) wired ONLY into `chat.ts` (`purpose:'requirement'`), a route /tasks never calls. (gap #5)
- `workflow-config-preview.tsx` is display-only — no enqueue button, no `createJob` call. (gap #2,#3)
- `source_chat_session_id` is the only chat↔schedule link; chat_session.workspace_id = sentinel `'taskpool-draft'` (FK risk). (gap #6,#7)
- Clone selection hardcoded (`chat.ts`→'workspace', `global-chat.ts`→'scheduler'); no project→clone mapping. (gap #8)
- xzf-dev fully disjoint from scheduler/routes (0 refs); emits no `workflow_ref`-consumable artifact. (gap #10)

### From `chatbot-workflow-design` (done)
- **Interaction (HITL) is workflow-native**: `interaction` node + `interaction_messages` table + `/api/workspaces/:id/interactions/:execId/:nodeId/*`. Chatbot is a **peer system** that controls workflows via `octo-workflow-ops` skill (natural language → workflow API). ChatBridge deleted. LangGraph interrupt/resume model.
- ⇒ Authoring chat ≠ execution-time interaction. Two separate concerns. Do not conflate.

### From `workspace-scheduler-clone-chat` (done) = current state
- Two-layer skill model: shared `~/.octopus/agent/skills/` + clone-专属 `built-in/{name}/skills/` (same-name clone wins). `loadSkills()` filters by `CloneDef.skills`.
- CWD: clone's own dir; workspace page overrides to `workspace.path`.
- Workspace clone `skills: []` (deferred "分身技能安装"). Scheduler clone `skills: ['octo-scheduler']`.
- ⇒ Per-task skills scoping is feasible via the two-layer model + CloneDef.skills filter — the deferred install feature is the build item.

### From `sub-workflow-node` (done)
- `sub_workflow` = by-name ref to **same-workspace** workflow. inline/linked. Input/output mapping. `parent_execution_id`.
- **Explicitly: no cross-workspace.** ⇒ Cannot be the N-workspace composition vehicle.

### From `dynamic-sub-workflow` (done)
- `dynamic_sub_workflow` = agent generates runtime DAG of **agent-type-only** nodes, persisted to `workspace/workflows/`, 3-layer validation harness, input-hash reuse.
- ⇒ Cannot dynamically compose sub_workflows/multi-workspace. xzf-dev's `spec-to-tasks`/`execution` uses this.

### From `agent-clone-system-refactor` (done)
- 4 built-in clones (workspace/scheduler/archive/resource). `CloneDef { persona, skills, memoryScope, workspaceRef?, config.tools? }`. Dual-path (Main Agent CLI + page-direct). Session unified via `scope_id` + `provider_session_id`.

### ADR-006 (plugin-skill-discovery)
- Skills injected via SDK plugin scan of `skills/` dirs; `CloneDef.skills` whitelist is the filter (not dead — `loadSkills` honors it). Node-level `skills: string[]` is a runtime filter (glossary: Skill Filter).

## Decisions so far (tentative — to survive grilling)

- **D1** Task binds to **project(s)** at authoring; workspace materialized at dispatch (`createFromSpec`). [ours]
- **D2** spec = WHAT, workflow_ref = HOW. Decoupled. [ours]
- **D3 (strengthened by 03)** Authoring chatbot = **new task-author clone** (own CloneDef + task-author SKILL.md), follows the scheduler-clone curl pattern exactly (reads SKILL.md → Bash+curl to `POST /jobs` + `/jobs/:id/enqueue`). NOT draft-workspace reuse, NOT workspace clone. Resolves F5.
- **D4 — RESOLVED (05=B, ADR-0008)** Composite (N workspaces) orchestrated at **workflow layer**: task pins a composition workflow (lightweight coordinator ws, no projects); new `task_dispatch` node fans out N child schedules (each `createFromSpec` own ws); orchestration reuses engine DAG/Loop/Swarm; integration reuses swarm/moa. Task model unchanged (spec+workflow_ref).
- **D5** subunits declarative in spec; executor consumes them. [ours, refined]
- **D6** per-task skills via two-layer model + CloneDef.skills filter (the deferred install feature). [inherits]
- **D7 — confirmed by 07** Spec model: chatbot **always produces structured spec** (goal/AC/数据模型/契约); elaboration depth is a property of the pinned `workflow_ref` (execution-only default; full xzf-dev opt-in). Composite: each subunit pins its own depth. xzf-dev = opt-in 精炼器 (bridges gap #10).
- **D8** Execution-time HITL = workflow-native `interaction` node (separate from authoring chat). [inherits]
- **D9 (from research 04)** Task body data model: `task_spec` (goal/AC/契约) → new optional field in `schedules.config` JSON + `schema_version` "3.0" (versioned TEXT, no migration). `subunits[]` / `composition_plan` / per-task skills live in the **composition workflow YAML** (engine, per 05-B); skills ride `workflowChainItem.input_values`. No new tables/columns. **Multi-repo already supported** (worktree per project) — BUT `source_path=""` silently skipped (repos/index.md resolution unimplemented on scheduler path) → real bug, folds into F6.
- **D10 (from 02)** Engine already has parallel-dispatch+integration primitives: `computeExecutionLevels` (Kahn), `executeNodesParallel` (Promise.allSettled per level + maxConcurrent), `DispatchStrategy/buildDAG`, `MoaStrategy` (fan-out + aggregator = literally parallel-dispatch+integration). Scheduler has none. `idx_sched_execs_unique_active` (schema.sql:565) blocks multiple active children under one schedule_id. → option B substantially stronger.
- **D11 (from 03)** Per-task skills scoping = real build: `loadSkills()` dead post-ADR-006, `getPlugins()` ignores `CloneDef.skills` → every clone inherits all ~33 shared skills. Options: synthetic per-task skills dir in plugin path, or re-enable filtered `loadSkills`. Project-as-cwd proven (chat.ts:79,135); multi-project = primary cwd + rest as refs. `task-pool-system-prompt`: keep chat.ts:104-106 `purpose:'requirement'` seam, rewrite body → task-author SKILL.md + thin producer prompt.
- **D12 (from 01)** Chain is engine-execution-level parent/child **within one workspace** (parent_id/child_index on `executions`, not `schedule_executions`). `createFromSpec` per-call stateless → N-call feasible, BUT fan-out must create **N distinct child schedules** (unique_active index forbids multiple active children under one schedule_id). `sub_workflow` structurally same-ws-only. New `task_dispatch` node feasible via injection (engine depends only shared+providers) but needs: injected `TaskDispatchPort` + **cross-boundary await bridge** (engine node must block until child schedule completes — today handleChainComplete is fire-and-forget) + per-subunit node schema. Integration reuses engine swarm/moa (DRY win for B).
- **D13 (from 12)** Confirm gate = **manual**: chatbot 产 spec → draft → user hits '入队' on preview card → queued. The enqueue button IS the confirm gate (closes gap #2/#3). draft = review/edit state (composite tasks edit subunits here).
- **D14 (from 06)** Integration output = **configurable** via `task_spec.integration_goal`: synthesis (default, swarm-moa report) / merge (combined PR) / both. Composition workflow 末尾节点匹配。Reuses engine moa + merge node.
- **D15 (from 11)** Composite kanban = **parent card + drill-down**: 1 task = 1 card (aggregate status); click → drawer with composition DAG + N child cards (ws+workflow_ref+status) + integration node. SSE pushes parent+child `schedule_status`. Board stays clean.
- **D16 (from 13)** `workflow_chain` KEPT as "simple sequential same-ws" fast path (config.json array, no YAML). Coexists with composition (`task_dispatch`, multi-ws) + `sub_workflow` (same-ws by-name). when-to-use: simple seq same-ws → workflow_chain; composite multi-ws → composition; same-ws compose-in-workflow → sub_workflow. Story-walker #4 fixed chain code stays as fast-path mechanism.
- **D17 (story-walkthrough done)** 11 断点修复（G1-G10）折入 spec v2：R1→pause-resume、failed/aborted **terminal+retry cap**（避无限重派）、source_path 修复、abort 新建、SSE 注入、cast 扩、退役 'taskpool-draft' 哨兵、孤儿字段、**G9 task_spec↔WorkflowConfig 物化**、**G10 subunits→Loop-over-subunits**。`story-walkthrough.md` 存档。**Issues DAG 14 票**（`issues/`）。

## Not yet specified (fog)

- **F1** Composition topology — RESOLVED by D4=B: engine DAG levels + DispatchStrategy; "same wf diff vars" = Loop. Declared in composition workflow YAML (node `depends_on`).
- **F2** Integration output — RESOLVED by 06=(i): configurable `integration_goal` (default moa synthesis, merge opt-in).
- **F3** Spec maturity — RESOLVED by 07=(i): structured spec always; `workflow_ref` picks depth (execution-only default, xzf-dev opt-in).
- **F4** Task body data model — RESOLVED (04 + 05-B): `task_spec` in config v3.0; subunits/plan/skills in composition workflow YAML.
- **F5** Authoring clone identity: new "task-author" clone vs reuse workspace clone w/ task scope?
- **F6** Project→codebase binding for chatbot: cwd? repo refs? skills only? — **blocked**: `source_path=""` resolution bug (04) must be fixed for multi-repo codebase to work.
- **F7** Composite kanban UX — RESOLVED by 11=(i): parent card + drill-down.
- **F8** Confirm gate — RESOLVED by 12=(i): manual enqueue button; draft = review state.
- **F9** createFromSpec N-times-per-dispatch feasibility + per-call vars. (research 01)
- **F10** workflow_chain fate — RESOLVED by 13=(B): keep as simple sequential same-ws fast path.

_Resolved by inheritance/research (cleared from fog):_ sub_workflow cross-ws (no), dynamic_sub_workflow node types (agent-only), interaction ownership (workflow-native), skill scoping mechanism (two-layer + filter), naming collision (low, per 04), **F5 authoring-clone-identity (new task-author clone, per 03)**, **F6 project-binding (cwd=primary+refs, per 03; + source_path bug fix)**, **F9 createFromSpec N-call (feasible but needs N child schedules, per 01)**.

## Out of scope

- Abandoned DemandService / 12-endpoint task-board (PR #50 already dropped it).
- Cross-workspace `sub_workflow` (explicitly out per sub-workflow-node).
- Dynamic composition of sub_workflows (dynamic_sub_workflow is agent-nodes-only).
- Full xzf-dev as DEFAULT authoring pipeline (opt-in pinnable only).
- Frontend chat component redesign (reuse ChatPanel per chatbot-workflow-design D7).

## Decision Ticket Registry

| # | Slug | Type | Status | Blocked by |
|---|------|------|--------|------------|
| 01 | research-createfromspec-multi-call | research | resolved | None |
| 02 | research-composition-dag-gap | research | resolved | None |
| 03 | research-authoring-clone-skill | research | resolved | None |
| 04 | research-schedules-config-shape | research | resolved | None |
| 05 | grilling-composition-layer | grilling | **resolved (B → ADR-0008)** | None |
| 06 | grilling-integration-output | grilling | resolved (i) | None |
| 07 | grilling-spec-maturity | grilling | resolved (i) | None |
| 08 | grilling-task-body-model | grilling | resolved-by-research (04+05-B) | None |
| 09 | grilling-authoring-clone-identity | grilling | resolved-by-research (03) | None |
| 10 | grilling-project-binding | grilling | resolved-by-research (03) | None |
| 11 | grilling-composite-kanban-ux | grilling | resolved (i) | None |
| 12 | grilling-confirm-gate | grilling | resolved (i) | None |
| 13 | grilling-workflow-chain-fate | grilling | resolved (B) | None |
| 14 | prototype-authoring-panel-ux | prototype | resolved (v2.1) | None |

## ASCII — Total Roadmap + All Interaction Surfaces

```
═══════════════════════════════════════════════════════════════════════
TASK POOL REDESIGN v3 — total roadmap (inheritance-revised)
═══════════════════════════════════════════════════════════════════════

[1] AUTHORING  (任务面板, 不执行工作流) ─────────────────────
    user ──▶ /tasks panel
            ├─ select projects (多仓库 codebase 上下文)     [F6]
            ├─ 勾选 skills / agents (per-task, 两层模型过滤) [D6]
            ├─ authoring chatbot = peer clone chat           [D3]
            │     └─ via scheduler-API skill ──▶ POST /jobs(draft) + refine
            └─ spec 产出 [WHAT]: goal/AC/数据模型/契约
               简单: 1 subunit ;  复合: N subunits + topology + integration goal
            status: draft

[2] CONFIRM  (面板按钮) ──────────────────────────────────────
    spec preview ──▶ 入队 (draft → queued)
    (human confirm gate? → 决策 12)

[3] DISPATCH  (scheduler claim, 并发上限) ───────────────────
    ├─ 简单 (1 subunit):
    │     createFromSpec ──▶ 1 ws (多仓库 worktree) ──▶ run workflow_ref
    │
    └─ 复合 (N subunits):  composition 层 [决策 05, ADR 候选]
          (A) scheduler-layer composition_plan (泛化 workflow_chain)
          (B) workflow-layer composition workflow + new `task_dispatch` 节点 ★推荐
          fan-out: 每 subunit createFromSpec 独立 ws + 跑 sub-workflow_ref
          orchestrate: DAG / Loop(同wf不同vars) / Swarm
          integrate: 聚合节点 (swarm-moa / merge) → 统一产物 [决策 06]

[4] EXECUTION-TIME HITL  (pinned workflow 内, workflow-native) ─
    workflow 含 interaction 节点 ──▶ /api/workspaces/:id/interactions/...
    对话数据归 workflow (interaction_messages), 非 chatbot
    chatbot 仅作 UI 渲染 (复用 ChatPanel)                    [D8]

[5] REAL-TIME  (SSE) ──────────────────────────────────────────
    /api/scheduler/events ──▶ schedule_status(running/done/rollback) ──▶ /tasks
    + 10s 轮询兜底

[6] LIFECYCLE  (kanban) ──────────────────────────────────────
    draft → queued → claimed → running → done
    crash recovery: checkStaleClaimed 回滚 claimed/running → queued
    复合任务 N 子 ws 如何展示? [决策 11]

═══════════════════════════════════════════════════════════════════════
```

## Interaction surfaces (enumerated — UI/UX must cover all)

1. **/tasks kanban** — 5-col board, composite drill-down (11), SSE refresh (5).
2. **Authoring panel** — project/skill selector + chatbot + spec preview + enqueue (14 prototype).
3. **Authoring chatbot** — peer clone chat, spec authoring, calls scheduler API via skill (03,09).
4. **Confirm/enqueue** — panel button, draft→queued, optional human gate (12).
5. **Dispatch viewer** — simple (1 ws flow) vs composite (N ws DAG + integration) (11).
6. **Execution-time interaction modal** — workflow-native interaction node, reuses ChatPanel (D8).
7. **Spec/subunit editor** — for composite: edit N subunits (projects/workflow/vars/skills) (08,14).
