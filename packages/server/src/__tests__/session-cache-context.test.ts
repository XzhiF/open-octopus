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
import { EXPERT_ROLE_IDS } from "@octopus/shared"

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
  it("task-author registers the full catalog from turn 0", () => {
    const roster = resolveSessionExpertRoster(dao, {
      sessionId: "s-author",
      cloneName: "task-author",
      requested: [],
    })
    expect(roster).toEqual([...EXPERT_ROLE_IDS])
  })

  it("consulting different experts never changes the task-author roster", () => {
    resolveSessionExpertRoster(dao, {
      sessionId: "s-author-2",
      cloneName: "task-author",
      requested: [],
    })
    const first = resolveSessionExpertRoster(dao, {
      sessionId: "s-author-2",
      cloneName: "task-author",
      requested: ["product-manager"],
    })
    const second = resolveSessionExpertRoster(dao, {
      sessionId: "s-author-2",
      cloneName: "task-author",
      requested: ["engineering-sre"],
    })
    expect(second).toEqual(first)
    expect(second).toEqual([...EXPERT_ROLE_IDS])
  })

  it("other clones union requested experts (no remove/re-add cycle)", () => {
    const first = resolveSessionExpertRoster(dao, {
      sessionId: "s-other",
      cloneName: "workspace",
      requested: ["product-manager"],
    })
    const second = resolveSessionExpertRoster(dao, {
      sessionId: "s-other",
      cloneName: "workspace",
      requested: ["engineering-sre"],
    })
    expect(first).toEqual(["product-manager"])
    expect(second).toEqual(["product-manager", "engineering-sre"])
  })
})

describe("SessionCacheContextDAO — role state", () => {
  it("bumps revision on a real switch, not on a duplicate selection", () => {
    expect(dao.setActiveExpert("s-role", "product-manager")).toMatchObject({
      activeExpert: "product-manager",
      revision: 1,
      deliveredRevision: 0,
    })
    expect(dao.setActiveExpert("s-role", "product-manager").revision).toBe(1)
    expect(dao.setActiveExpert("s-role", "engineering-sre")).toMatchObject({
      activeExpert: "engineering-sre",
      revision: 2,
    })
    expect(dao.setActiveExpert("s-role", null)).toMatchObject({
      activeExpert: null,
      revision: 3,
    })
  })

  it("tracks delivery and can reset it when the provider transcript is lost", () => {
    dao.setActiveExpert("s-role-2", "engineering-sre")
    dao.markRoleDelivered("s-role-2", 1)
    expect(dao.getRoleState("s-role-2").deliveredRevision).toBe(1)
    dao.resetRoleDelivery("s-role-2")
    expect(dao.getRoleState("s-role-2").deliveredRevision).toBe(0)
  })

  it("builds a role card only for an undelivered revision", () => {
    dao.setActiveExpert("s-role-3", "engineering-sre")
    const card = pendingRoleCard(dao.getRoleState("s-role-3"))
    expect(card).toContain('name="SRE"')
    expect(card).toContain('id="engineering-sre"')
    dao.markRoleDelivered("s-role-3", 1)
    expect(pendingRoleCard(dao.getRoleState("s-role-3"))).toBeNull()
    dao.setActiveExpert("s-role-3", null)
    expect(pendingRoleCard(dao.getRoleState("s-role-3"))).toContain("专家身份已结束")
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
