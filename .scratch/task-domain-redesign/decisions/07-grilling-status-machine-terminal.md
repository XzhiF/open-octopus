# 07 — tasks status machine: terminal states + fate of 'claimed'

Type: grilling
Status: resolved (user chose a → v2-D14)
Blocked by: None

## Answer

User selected **(a)**. tasks.status = `draft|ready|running|done|failed|aborted` (terminal: done/failed/aborted).
`claimed` folds into `running` on tasks (runner-internal, schedules keeps claimed for stale-detection); kanban
shows "执行中" for both. Terminal failed (auto, G2) + aborted (user, G4) kept from v1, both terminal (no re-dispatch
loop). Discard draft/ready = soft-delete (`deleted_at`), not a status. All 7 decision tickets resolved → Wayfinder exit.

## Question

User confirmed authoring lifecycle `draft → ready → running` (v2-D2). This ticket fixes the **terminal states**
and the **fate of v1's `claimed`** (v1 had draft→queued→claimed→running→done/failed/aborted).

Context (O2=S2): `schedules` keeps run-phase status (queued/claimed/running/done/failed/aborted) for the runner
(`checkStaleClaimed` rolls back claimed/running). `tasks.status` is the authoring + kanban-visible lifecycle.
The tasks board card needs to show running/failed/aborted, so tasks.status must carry running + terminal (not just
draft/ready/done).

## Options

### (a) [Recommended] draft|ready|running|done|failed|aborted; `claimed` folds into `running` on tasks
- tasks.status: `draft` → `ready` → `running` → `{done | failed | aborted}` (terminal).
- `claimed` does NOT appear on tasks (folds into `running`); schedules keeps `claimed` internally for stale-detection.
  The kanban card shows "执行中" for both claimed+running; the distinction is a runner implementation detail.
- Terminal: `done` (success), `failed` (auto-failure, terminal — `checkStaleClaimed` does NOT roll back, v1 G2),
  `aborted` (user abort, terminal, v1 G4). Matches your `draft→ready→running` + keeps v1's failed/aborted.
- Discard a draft/ready = soft-delete (`deleted_at`, like schedules has), NOT a status.

### (b) tasks.status mirrors schedules full run sub-states
- tasks.status: draft|ready|queued|claimed|running|done|failed|aborted. More granular; kanban shows `claimed`
  separately. But duplicates schedules.status; two sources of truth for run sub-state (drift risk).

### (c) tasks.status = draft|ready|done only; running/terminal deferred to schedules
- Minimal tasks lifecycle; the board joins schedules to show running/failed/aborted. Cleanest separation but the
  tasks board can't render status without a join, and tasks can't be queried for "my failed tasks" directly.

## Recommendation

**(a).** The kanban is a tasks board — it needs running/failed/aborted on the task card without a join. `claimed` is
a runner-internal sub-state (stale-detection), not user-visible — folding it into `running` on tasks avoids dual
source-of-truth. Terminal failed/aborted kept from v1 (G2/G4, both terminal, no infinite re-dispatch). Discard =
soft-delete, not a status. Matches your `draft→ready→running` exactly + the v1 terminal work that's already built.

## Note
- schedules.status (O2=S2) keeps its full run-phase set (queued/claimed/running/done/failed/aborted) — the runner is
  unchanged. tasks.status is the authoring+kanban lifecycle; on dispatch (ready→running) tasks creates the schedule
  (status='queued') and tasks→'running'. tasks mirrors schedules terminal (done/failed/aborted) for the card.
- If you later want a distinct `cancelled` (discard draft/ready) vs `aborted` (stop running), add it — but
  soft-delete covers discard today.
