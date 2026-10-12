// packages/shared/src/__tests__/knowledge-mode.test.ts
//
// LLM-WIKI P1 ticket 12 — knowledge.mode 影子双轨开关（spec §执行身份 影子双轨,
// stories 30/31）。缺省 both：注入链原样运行 + 查阅记录开启（= 现状字节一致）。
// mode 的取值真相来自票面（inject | query | both），非实现自证。

import { describe, it, expect } from "vitest"
import {
  KnowledgeModeValues,
  DEFAULT_KNOWLEDGE_MODE,
  WIKI_REFS_KEY,
  STALE_REF_PREFIX,
  resolveKnowledgeMode,
  injectionEnabled,
  recordingEnabled,
  stripWikiRefs,
} from "../types/knowledge"

describe("knowledge.mode schema values（票 12 · story 30）", () => {
  it("exactly the three states inject | query | both", () => {
    expect([...KnowledgeModeValues].sort()).toEqual(["both", "inject", "query"])
  })

  it("default is both — 注入链原样 + 查阅记录开启（本期缺省态 = 现状）", () => {
    expect(DEFAULT_KNOWLEDGE_MODE).toBe("both")
  })

  it("wiki_refs rides the existing vars_update VarPool key name + stale prefix (ticket 11 pointer tokens)", () => {
    expect(WIKI_REFS_KEY).toBe("wiki_refs")
    expect(STALE_REF_PREFIX).toBe("stale:")
  })
})

describe("resolveKnowledgeMode — tolerant read of clone config", () => {
  it("absent config / absent knowledge field → both (status quo preserved for every existing clone)", () => {
    expect(resolveKnowledgeMode(undefined)).toBe("both")
    expect(resolveKnowledgeMode(null)).toBe("both")
    expect(resolveKnowledgeMode({})).toBe("both")
    expect(resolveKnowledgeMode({ model: "sonnet" })).toBe("both")
  })

  it("CloneDef.config shape: { knowledge: { mode } } wins when valid", () => {
    expect(resolveKnowledgeMode({ knowledge: { mode: "inject" } })).toBe("inject")
    expect(resolveKnowledgeMode({ knowledge: { mode: "query" } })).toBe("query")
    expect(resolveKnowledgeMode({ knowledge: { mode: "both" } })).toBe("both")
  })

  it("full clone config.json shape: nested { config: { knowledge: { mode } } } is the on-disk home", () => {
    expect(resolveKnowledgeMode({ name: "task-doer", config: { knowledge: { mode: "inject" } } })).toBe("inject")
  })

  it("garbage never crashes and never silently switches tracks — falls back to both", () => {
    expect(resolveKnowledgeMode({ knowledge: { mode: "sideways" } })).toBe("both")
    expect(resolveKnowledgeMode({ knowledge: "not-an-object" })).toBe("both")
    expect(resolveKnowledgeMode("not-an-object")).toBe("both")
    expect(resolveKnowledgeMode({ knowledge: { mode: 42 } })).toBe("both")
  })
})

describe("mode → track predicates", () => {
  it("both / undefined enable BOTH tracks (default path byte-for-byte status quo)", () => {
    expect(injectionEnabled("both")).toBe(true)
    expect(injectionEnabled(undefined)).toBe(true)
    expect(recordingEnabled("both")).toBe(true)
    expect(recordingEnabled(undefined)).toBe(true)
  })

  it("inject keeps injection on, turns query recording off (回滚开关 = 恢复现状)", () => {
    expect(injectionEnabled("inject")).toBe(true)
    expect(recordingEnabled("inject")).toBe(false)
  })

  it("query turns the injection chain off, keeps recording on (P2 预演态)", () => {
    expect(injectionEnabled("query")).toBe(false)
    expect(recordingEnabled("query")).toBe(true)
  })
})

describe("stripWikiRefs — recording gate for the vars_update channel", () => {
  it("mode=inject removes the wiki_refs key, other vars survive untouched", () => {
    const update = { wiki_refs: ["prj-octopus#oct-001"], summary: "kept", __status: "ok" }
    stripWikiRefs(update, "inject")
    expect(update).toEqual({ summary: "kept", __status: "ok" })
  })

  it("mode=both / mode=query / absent mode never strip (default path unchanged)", () => {
    const a = { wiki_refs: ["r1"] }
    stripWikiRefs(a, "both")
    expect(a.wiki_refs).toEqual(["r1"])
    stripWikiRefs(a, "query")
    expect(a.wiki_refs).toEqual(["r1"])
    stripWikiRefs(a, undefined)
    expect(a.wiki_refs).toEqual(["r1"])
  })
})
