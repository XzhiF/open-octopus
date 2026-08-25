# 03 — Draft autosave scope: which fields does turn-end autosave write?

Type: grilling
Status: resolved (user chose a → v2-D11)
Blocked by: None

## Answer

User selected **(a) minimal: row-existence + title**. First task-author turn: create `tasks` row (status='draft',
source_chat_session_id=session.id, title=auto) if absent. Each turn: update title + updated_at. Spec fields NOT
autosaved — they flow via O4 `update_task_spec_field` tool (agent) + [保存草稿] button (user). Mechanism fixed by
research ③ → v2-D6 (server-side `clone/index.ts:406`, cloneName==='task-author' gate). Zero content-parsing fragility.
Solves the core "no save moment" pain: draft row exists from turn 1.

## Question

The task-author clone chat must **deterministically save a draft** after each turn (v2-D4: app-driven, not LLM-whim).
Research ③ fixed the **mechanism**: server-side at `packages/server/src/routes/clone/index.ts:406` (after the auto-title
block, before the `done` SSE), gated by `cloneName === 'task-author'` — deterministic, race-free, full context
(`fullContent`, `body.message`, `toolCalls`), mirrors the existing auto-title pattern. This ticket decides the **scope**:
which fields does turn-end autosave write to the `tasks` row, beyond ensuring the row exists?

Note: spec fields (goal/ac/projects/skills/subunits/integration) flow via the **O4 `update_task_spec_field` tool**
(agent-driven, ticket 04) + the **[保存草稿] button** (user-driven). So autosave's distinct job = ensure the draft
row persists + title, NOT duplicating spec (which has its own structured channels).

## Options

### (a) [Recommended] Minimal: row-existence + title
- First task-author turn: if no `tasks` row linked to this session (`source_chat_session_id`) exists, create one
  (`status='draft'`, `source_chat_session_id=session.id`, `title`=auto from session title / first user msg).
- Each turn: update `title` (mirror auto-title) + bump `updated_at`.
- Spec fields NOT autosaved — they flow via O4 tool + save button. Clean separation; zero content-parsing fragility.
- Solves the core pain ("no save moment"): a draft row exists from turn 1 even before the agent emits a spec.

### (b) row + title + freeform description/notes
- (a) + a `description`/`notes` field the agent or user can fill, autosaved each turn (agent's 1-line turn summary).
- Useful for kanban card subtitle / context. Mild extra; still no structured-spec parsing.

### (c) row + title + best-effort spec parse
- (a) + parse assistant prose/tool-call results for goal/ac and persist into `task_spec`.
- Fragile (free-form agent text; partial-stream parsing error-prone). Duplicates what the O4 tool already does
  deterministically. Not recommended — research ⑤ explicitly rejected message-parsing for the spec linkage.

## Recommendation

**(a).** The deterministic save moment = "draft row exists + titled." Spec has its own structured channels (O4 tool
+ save button). (b) is a harmless superset if you want a kanban subtitle; (c) is fragile and redundant with the tool.

## Note
- Mechanism (server-side `clone/index.ts:406`) is fixed by research ③ → v2-D6. This ticket only fixes scope.
- Interacts with O4 (ticket 04): the `update_task_spec_field` tool is the agent's spec-write channel; autosave must
  not race it (server-side sequencing at the same seam handles ordering — autosave runs after assistant persist, tool
  calls already applied during the turn).
- [保存草稿] button = manual flush of SpecPanel local state → `PUT /tasks/:id` (user-driven spec save), distinct from autosave.
