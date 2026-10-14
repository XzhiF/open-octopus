// packages/server/src/services/knowledge/__tests__/skill-draft-llm.test.ts
//
// P3 票04 — 生产适配器离线闸（spec Testing Decisions「生产适配器另验离线闸」，
// createProductionCaseExtractor/createProductionArchiveSummarizer 同款制式）。
// 单测其余面一律 seam mock（skill-draft-service.test.ts），本文件只钉闸断言：
// OCTOPUS_KNOWLEDGE_LLM_DISABLED=1 ⇒ 恒空串 ⇒ 服务收敛为
// PROPOSE_EMPTY / REVISE_EMPTY——零落盘零改写，绝不产假草案。

import { describe, it, expect, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"

let prevDisabled: string | undefined
afterEach(() => {
  if (prevDisabled === undefined) delete process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED
  else process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED = prevDisabled
})

describe("skill 草案生产适配器：离线闸（票04 S1·生产面）", () => {
  it("OCTOPUS_KNOWLEDGE_LLM_DISABLED=1 ⇒ proposer/reviser 恒空串；服务两路分别收敛 PROPOSE_EMPTY/REVISE_EMPTY，零落盘零改写", async () => {
    prevDisabled = process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED
    process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED = "1"
    const { createProductionSkillProposer, createProductionSkillReviser, SKILL_PROPOSE_MODEL_ENV, SKILL_REVISE_MODEL_ENV } = await import("../skill-draft-llm")
    expect(SKILL_PROPOSE_MODEL_ENV).toBe("OCTOPUS_SKILL_PROPOSE_MODEL")
    expect(SKILL_REVISE_MODEL_ENV).toBe("OCTOPUS_SKILL_REVISE_MODEL")
    const proposer = createProductionSkillProposer()
    const reviser = createProductionSkillReviser()
    await expect(proposer("任意 prompt")).resolves.toBe("")
    await expect(reviser("任意 prompt")).resolves.toBe("")

    // 服务面闸断言（tmp 知识根：一包干净 + 一草案，走生产适配器 ⇒ 零产零改）
    const { freezePackItem, writePackManifest } = await import("../material-pack")
    const { SkillDraftService } = await import("../skill-draft-service")
    const { writeDraft } = await import("../skill-draft-store")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aa04-off-"))
    try {
      const root = path.join(tmp, "knowledge")
      fs.mkdirSync(root, { recursive: true })
      const manifest = { v: 1 as const, taskId: "off-1", createdAt: new Date().toISOString(), items: [], recompiles: [] }
      manifest.items.push(freezePackItem(root, "off-1", {
        fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", name: "摘录",
        origin: "exec:off-1", title: "摘录 off-1", payload: "## exec e\n\n- 摘录：（本次执行无关键事件——干净跑完）\n",
      }))
      writePackManifest(root, "off-1", manifest)
      writeDraft(root, {
        name: "flow-offline", description: "d", origin: "sequence-similar", source: "pack:task-x; pack:task-y",
        body: "## 步骤\n\n1. old", createdAt: "2026-10-14T00:00:00.000Z",
      })

      const service = new SkillDraftService({ root, propose: proposer, revise: reviser })
      const outcome = await service.detectForTask("off-1")
      expect(outcome.created).toHaveLength(0)
      expect(outcome.reasons).toContain("PROPOSE_EMPTY")
      await expect(service.reviseDraft("flow-offline", "改改")).rejects.toMatchObject({ code: "REVISE_EMPTY" })
      expect(fs.readFileSync(path.join(root, "drafts", "skills", "flow-offline", "SKILL.md"), "utf-8")).toContain("1. old")
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
