// Cache-stability seam (schema v56): frozen system prompt, stable expert
// roster, and the transient-reminder helper. These are the invariants the
// provider prefix cache depends on.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { SessionCacheContextDAO, hashPrompt } from "../db/dao/session-cache-context-dao"
import { resolveSessionExpertRoster } from "../services/agent/session-expert-roster"
import { withTransientReminder } from "../services/agent/prompt-reminder"
import { pendingRoleCard, buildRoleCard, buildRoleResetCard } from "../services/agent/role-card"
import { resolveCloneRolePack } from "../services/agent/clone-resolver"

let db: Database.Database
let dao: SessionCacheContextDAO

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  dao = new SessionCacheContextDAO(db)
})

afterAll(() => {
  db.close()
})

beforeEach(() => {
  db.prepare("DELETE FROM session_prompt_snapshots").run()
  db.prepare("DELETE FROM session_expert_rosters").run()
})

describe("SessionCacheContextDAO — frozen system prompt", () => {
  it("builds once and returns the same prompt even when the builder drifts", () => {
    let version = 1
    const build = () => `persona-v${version}`
    const first = dao.getOrCreatePromptSnapshot("s-1", build)
    version = 2
    const second = dao.getOrCreatePromptSnapshot("s-1", build)

    expect(first.systemPrompt).toBe("persona-v1")
    expect(second.systemPrompt).toBe("persona-v1")
    expect(second.promptHash).toBe(first.promptHash)
    expect(second.promptHash).toBe(hashPrompt("persona-v1"))
  })

  it("stores a stable hash for the exact bytes sent to the provider", () => {
    const prompt = "line 1\nline 2"
    const saved = dao.savePromptSnapshot("s-hash", prompt)
    expect(saved.promptHash).toBe(hashPrompt(prompt))
    expect(dao.getPromptSnapshot("s-hash")).toEqual(saved)
  })

  it("does not lock in a transient empty build", () => {
    const empty = dao.getOrCreatePromptSnapshot("s-empty", () => "")
    expect(empty.systemPrompt).toBe("")
    expect(dao.getPromptSnapshot("s-empty")).toBeNull()
    const next = dao.getOrCreatePromptSnapshot("s-empty", () => "later")
    expect(next.systemPrompt).toBe("later")
  })

  it("invalidate drops the snapshot so the next turn picks up new memory", () => {
    dao.getOrCreatePromptSnapshot("s-reset", () => "old")
    dao.invalidatePromptSnapshot("s-reset")
    const next = dao.getOrCreatePromptSnapshot("s-reset", () => "new")
    expect(next.systemPrompt).toBe("new")
  })
})

describe("SessionCacheContextDAO — expert roster", () => {
  it("unions requested experts without duplicating or reordering", () => {
    dao.saveExpertRoster("s-exp", ["a", "b"])
    expect(dao.addExpertsToRoster("s-exp", ["b", "c", "a"])).toEqual(["a", "b", "c"])
    // Re-adding an existing set is a no-op (same array contents).
    expect(dao.addExpertsToRoster("s-exp", ["a"])).toEqual(["a", "b", "c"])
  })

  it("deleteSession removes both cache rows", () => {
    dao.savePromptSnapshot("s-del", "p")
    dao.saveExpertRoster("s-del", ["a"])
    dao.deleteSession("s-del")
    expect(dao.getPromptSnapshot("s-del")).toBeNull()
    expect(dao.getExpertRoster("s-del")).toEqual([])
  })
})

describe("resolveSessionExpertRoster — stable across consults", () => {
  it("registers the full clone roster from turn 0", () => {
    const roster = resolveSessionExpertRoster(dao, {
      sessionId: "s-author",
      requested: [],
    })
    expect(roster).toEqual(expect.arrayContaining(["workspace", "scheduler", "archive"]))
    expect(roster.length).toBeGreaterThanOrEqual(8)
    expect(roster).not.toContain("main-agent")
  })

  it("consulting different clones never changes the seeded roster", () => {
    const seeded = resolveSessionExpertRoster(dao, {
      sessionId: "s-author-2",
      requested: [],
    })
    const first = resolveSessionExpertRoster(dao, {
      sessionId: "s-author-2",
      requested: [seeded[0]],
    })
    const second = resolveSessionExpertRoster(dao, {
      sessionId: "s-author-2",
      requested: [seeded[1]],
    })
    expect(first).toEqual(seeded)
    expect(second).toEqual(seeded)
  })

  it("clones created later union in on first use (no remove/re-add cycle)", () => {
    const seeded = resolveSessionExpertRoster(dao, {
      sessionId: "s-other",
      requested: [],
    })
    const first = resolveSessionExpertRoster(dao, {
      sessionId: "s-other",
      requested: ["later-created-clone"],
    })
    expect(first).toEqual([...seeded, "later-created-clone"])
    // Repeat consults of an already-listed clone are a no-op (byte-stable).
    const second = resolveSessionExpertRoster(dao, {
      sessionId: "s-other",
      requested: ["later-created-clone"],
    })
    expect(second).toEqual(first)
  })
})

describe("SessionCacheContextDAO — role state", () => {
  it("bumps revision on a real switch, not on a duplicate selection", () => {
    expect(dao.setActiveExpert("s-role", "product-manager", "expert")).toMatchObject({
      activeExpert: "product-manager",
      activeKind: "expert",
      revision: 1,
      deliveredRevision: 0,
    })
    expect(dao.setActiveExpert("s-role", "product-manager", "expert").revision).toBe(1)
    expect(dao.setActiveExpert("s-role", "engineering-sre", "expert")).toMatchObject({
      activeExpert: "engineering-sre",
      revision: 2,
    })
    // Identity now targets clones by default (v59).
    expect(dao.setActiveExpert("s-role", "workspace")).toMatchObject({
      activeExpert: "workspace",
      activeKind: "clone",
      revision: 3,
    })
    expect(dao.setActiveExpert("s-role", null)).toMatchObject({
      activeExpert: null,
      revision: 4,
    })
    // Clearing an already-clear role is a no-op regardless of kind.
    expect(dao.setActiveExpert("s-role", null).revision).toBe(4)
  })

  it("tracks delivery and can reset it when the provider transcript is lost", () => {
    dao.setActiveExpert("s-role-2", "engineering-sre", "expert")
    dao.markRoleDelivered("s-role-2", 1)
    expect(dao.getRoleState("s-role-2").deliveredRevision).toBe(1)
    dao.resetRoleDelivery("s-role-2")
    expect(dao.getRoleState("s-role-2").deliveredRevision).toBe(0)
  })

  it("builds a role card only for an undelivered revision", () => {
    dao.setActiveExpert("s-role-3", "engineering-sre", "expert")
    const card = pendingRoleCard(dao.getRoleState("s-role-3"))
    expect(card).toContain('name="SRE"')
    expect(card).toContain('id="engineering-sre"')
    dao.markRoleDelivered("s-role-3", 1)
    expect(pendingRoleCard(dao.getRoleState("s-role-3"))).toBeNull()
    dao.setActiveExpert("s-role-3", null)
    expect(pendingRoleCard(dao.getRoleState("s-role-3"))).toContain("专家身份已结束")
  })

  it("clone card carries the WHOLE role pack (no truncation) + skills + boundary", () => {
    const pack = resolveCloneRolePack("workspace")
    expect(pack).not.toBeNull()
    if (!pack?.persona) throw new Error("workspace clone must carry a persona")

    dao.setActiveExpert("s-role-4", "workspace")
    const card = pendingRoleCard(dao.getRoleState("s-role-4"))
    expect(card).toContain("clone: workspace")
    expect(card).toContain(`<clone name="workspace"`)
    expect(card).toContain("## 可用技能")
    expect(card).toContain("## 边界")
    expect(card).toContain("## 岗位包")
    // Full persona inline — head and tail both present (nothing sliced off).
    expect(card).toContain(pack.persona.slice(0, 60))
    expect(card).toContain(pack.persona.slice(-60))
  })

  it("role card is the persona carrier — the reset card explicitly exits the role", () => {
    const card = buildRoleCard("engineering-sre", 3)
    expect(card).toContain("revision 3")
    expect(card).toContain("最新一张角色卡生效")
    expect(buildRoleResetCard(4)).toContain("回到会话的基础角色")
  })
})

describe("withTransientReminder", () => {
  it("keeps the raw message when there is nothing to inject", () => {
    expect(withTransientReminder("hello")).toBe("hello")
    expect(withTransientReminder("hello", "   ")).toBe("hello")
  })

  it("appends a trailing system-reminder block", () => {
    expect(withTransientReminder("hello", "现场 A")).toBe(
      "hello\n\n<system-reminder>\n现场 A\n</system-reminder>",
    )
  })
})
