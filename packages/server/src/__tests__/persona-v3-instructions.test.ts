// packages/server/src/__tests__/persona-v3-instructions.test.ts
//
// r2-04 / GS4(b) — task-author persona mechanism assertions.
//
// US8 (chat-driven artifact edits) was PARTIAL in R1: the conversation
// behavior of the LLM is non-deterministic and cannot be asserted by an
// automated test (spec R2 strategy). What CAN be locked down is the
// *mechanism* side — the contract baked into the task-author persona text
// that the agent is expected to honor. This suite pins that contract so a
// future edit cannot silently drop one of these seams without turning the
// test red.
//
// Scope (per ticket r2-04):
//   1. The spec-field binding field list includes `decisions`.
//   2. The explicit task-creation example binds `source_chat_session_id`
//      (D15 session-first ordering — otherwise twin drafts appear).
//   3. The `@@spec_updated` reverse-notice explanation is present (US5
//      mechanism side: server appends to the next-turn system prompt).
//
// ── Mechanism ownership boundary (audit note) ──────────────────────────
// The artifact-directory / artifacts.json registration guidance is NOT
// asserted here and is NOT expected to live in the persona text. That
// guidance is carried by the `@@task_context` block that routes/clone
// appends to the system prompt at send time (D6), which is asserted in
// clone-spec-notice.test.ts (the D6 suite: capture.taskContext contains the
// artifacts dir absolute path + `artifacts.json` + the skill-group lock
// line). Do NOT flag the persona as "missing artifact wording" in a future
// audit — that responsibility is intentionally delegated to @@task_context
// so v2 tasks (no task_type) never receive artifact guidance. This file
// asserts only the persona-resident contract.

import { describe, it, expect } from "vitest"
import { getBuiltinCloneDef } from "../services/agent/builtin-clones"

describe("r2-04: task-author persona mechanism contract (US5/US8/D15)", () => {
  // Public seam: the exported built-in clone definition. Reading
  // `.persona` through getBuiltinCloneDef (not the module-local
  // TASK_AUTHOR_PERSONA const) keeps the test at the public interface, so
  // the persona template constant can be refactored without breaking this.
  const def = getBuiltinCloneDef("task-author")

  // Gate: if the task-author clone were ever removed/renamed, every
  // assertion below is meaningless — fail loudly here first.
  it("gate: task-author built-in clone is defined and carries a persona", () => {
    expect(def).not.toBeNull()
    expect(def?.persona).toBeTypeOf("string")
    expect(def!.persona.length).toBeGreaterThan(0)
  })

  const persona = def?.persona ?? ""

  // ── US8 mechanism: `decisions` is a bindable spec field ───────────────
  // The MoA adoption panel writes expert output into the `decisions` field
  // via the spec-field API (US11). The persona must advertise `decisions`
  // in its available-fields list so the agent knows it can bind there.
  it("US8: spec-field available-fields list advertises `decisions`", () => {
    // Locate the available-fields line (可用字段：...) — the spec-field
    // binding API's documented field list.
    const fieldListLine = persona
      .split("\n")
      .find((l) => l.includes("可用字段"))
    expect(fieldListLine).toBeDefined()
    // `decisions` must appear as a listed bindable field.
    expect(fieldListLine).toContain("decisions")
  })

  // ── D15 mechanism: explicit creation must bind source_chat_session_id ─
  // Session-first ordering: when the agent explicitly creates a draft
  // (autosave didn't seed one), it MUST pass source_chat_session_id to bind
  // the task to the current chat session. Omitting it produces an
  // unbound twin draft (D15 regression).
  it("D15: explicit task-creation example binds source_chat_session_id (session-first)", () => {
    // The explicit POST /api/tasks curl example must include the field.
    expect(persona).toContain("source_chat_session_id")
    // And must call out the D15 session-priority rationale so the agent
    // understands WHY it is required, not just that it is.
    expect(persona).toContain("D15")
    expect(persona).toContain("会话优先")
  })

  // ── US5 mechanism: @@spec_updated reverse-notice explanation ──────────
  // When the user direct-edits the SpecPanel and [保存草稿], the server
  // appends `@@spec_updated: <fields>` to the agent's NEXT-turn system
  // prompt. The persona must explain this reverse-notice channel so the
  // agent reconciles user overrides in the following turn.
  it("US5: persona explains the @@spec_updated reverse-notice (server → agent next turn)", () => {
    expect(persona).toContain("@@spec_updated")
    // The explanation must identify the delivery channel: server appends
    // into the next-round system prompt (not a user-visible message).
    expect(persona).toContain("system prompt")
  })
})
