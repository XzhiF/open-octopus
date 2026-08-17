# 04 — spec↔agent linkage: which fields auto-bindable + reverse-notify

Type: grilling
Status: resolved (user chose a → v2-D12)
Blocked by: None

## Answer

User selected **(a) all 6 fields auto-bindable + reverse context-message**. `update_task_spec_field({field, value})`
tool binds projects/skills/goal/ac/subunits/integration_goal during chat; SpecPanel live-renders via
`spec_field_update` SSE. Reverse: user [保存草稿] → server injects context message (`@@spec_updated`) into the
task-author session. Conflict: user override wins (409 → agent re-GET + retry, v1 SKILL.md:110 pattern).
Mechanism per research ⑤. Matches user intent ("自动绑定目标/自动填写/联动").

## Question

Make the task-author agent chat and the SpecPanel **bidirectionally linked** (v2-D5). Research ⑤ fixed the
**mechanism**: agent tool `update_task_spec_field({field, value})` → server applies to `tasks` row → emits
`spec_field_update` SSE → SpecPanel subscribes + updates local state; reverse: SpecPanel [保存草稿] → notify agent.
This ticket decides: **which spec fields are agent-auto-bindable**, and the **reverse-notify shape** + **conflict policy**.

SpecPanel fields (research ⑤): projects, skills, goal, ac, subunits, integration_goal.

## Options

### (a) [Recommended] All 6 fields auto-bindable + reverse context-message
- All 6 spec fields (projects/skills/goal/ac/subunits/integration_goal) bindable via `update_task_spec_field` tool;
  agent sets any during chat, SpecPanel re-renders live via `spec_field_update` SSE.
- Reverse: user edits SpecPanel + [保存草稿] → server injects a context message into the task-author session
  (`@@spec_updated: <field>=<value>` or structured metadata) so the agent's next turn is aware of user overrides.
- Conflict: user override wins. Agent's next tool call on a stale version → 409 → agent re-GETs + retries
  (same pattern as v1 SKILL.md:110).
- Files: agent tool def (`agent-service.ts`), `task-author/SKILL.md` (tool usage), `emitSpecFieldUpdate` SSE
  (`scheduler-service.ts`), `SSEHandlers.onSpecFieldUpdate` (`sse.ts`), SpecPanel subscribe (`task-modal.tsx`), shared types.
- Matches user intent ("自动绑定目标/自动填写/联动").

### (b) Content fields only; structural = proposal+confirm
- Only content fields (goal/ac/integration_goal) auto-bind. Structural (projects/skills/subunits) → tool returns a
  "proposal" the user must accept in SpecPanel before persisting.
- More controlled; but adds friction the user didn't ask for, and contradicts "自动绑定".

### (c) Agent only proposes; user accepts all
- Tool writes a "pending proposal"; nothing persists until user accepts in SpecPanel.
- Safest; least "联动". Over-conservative for the user's intent.

## Recommendation

**(a).** User explicitly wants "通过 author agent 对话来自动绑定目标、自动填写" + "联动" — broad auto-bind with
user override is the fit. The 409-stale-retry pattern (already in v1 SKILL.md) handles conflicts. Reverse
context-message closes the loop (agent knows when user overrides). (b)/(c) add friction against the stated intent.

## Note
- Resource/skill PICKING UX (user specifies vs agent assists) is ticket 06 (O6); O4 only fixes the binding MECHANISM
  + field scope. The `skills`/`resources` fields are auto-bindable via the tool (a), but HOW they're chosen is O6.
- `update_task_spec_field` for `resources` writes the `tasks.resources` array (v2-D8 reference model); loading them
  into the task-author session (prompt-inject) happens on next turn or on draft open (ticket 05 mechanism).
