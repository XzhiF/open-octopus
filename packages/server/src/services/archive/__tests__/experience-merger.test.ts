import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { ExperienceMerger } from "../experience-merger"
import { createNullEmitter } from "../step-emitter"
import {
  appendToKnowledgeFile,
  listAllRules,
  listAllActiveRules,
  parseKnowledgeFile,
} from "../../knowledge/file-ops"
import type { ExperienceAction } from "../experience-merger"

/**
 * B 止血 —— 旧实现整文件 LLM 重写且不写条目 id：读侧（parseKnowledgeFile）
 * 只认 `<!-- id:... -->` 注释行，LLM 丢注释/返回空即整文件经验静默蒸发。
 * 新实现 append-only + 保留/生成 id，全部用例不 mock LLM —— 确定性。
 */

function action(over: Partial<ExperienceAction> & { text: string }): ExperienceAction {
  return {
    id: over.id ?? "",
    action: "add",
    confidence: 0.8,
    category: "process",
    ...over,
  } as ExperienceAction
}

describe("ExperienceMerger (append-only)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-merger-"))
    process.env.OCTOPUS_KNOWLEDGE_DIR = tmpDir
  })

  afterEach(() => {
    delete process.env.OCTOPUS_KNOWLEDGE_DIR
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("add: 条目以带 id 注释的格式落盘，读侧 parseKnowledgeFile 可见", async () => {
    const merger = new ExperienceMerger()
    const result = await merger.merge("test-org", [
      action({ id: "exp-keep-1", text: "Always run migrations in a transaction", scope: "workflow", target: "myflow" }),
    ], createNullEmitter())

    expect(result.added).toBe(1)

    const filePath = path.join(tmpDir, "workflows", "myflow.md")
    const rules = parseKnowledgeFile(filePath)
    expect(rules).toHaveLength(1)
    expect(rules[0]!.id).toBe("exp-keep-1") // 保留调用方给的 id，不重写整文件
    expect(rules[0]!.text).toBe("Always run migrations in a transaction")
  })

  it("add: 缺 id 时生成合法 id，绝不落无 id 条目", async () => {
    const merger = new ExperienceMerger()
    await merger.merge("test-org", [
      action({ id: "", text: "Generated-id experience", scope: "project", target: "repo-a" }),
    ], createNullEmitter())

    const rules = parseKnowledgeFile(path.join(tmpDir, "projects", "repo-a.md"))
    expect(rules).toHaveLength(1)
    expect(rules[0]!.id).toMatch(/^repo-a-\d{8}-/)
    expect(rules[0]!.source).toBe("archive")
  })

  it("org 经验落到 experiences/ 目录且 listAllActiveRules 扫得到（不再写会被 rebuildIndex 覆写的 index.md）", async () => {
    const merger = new ExperienceMerger()
    const result = await merger.merge("test-org", [
      action({ id: "org-exp-1", text: "Org-wide: prefer prepared statements" }), // scope 默认 org
    ], createNullEmitter())
    expect(result.added).toBe(1)

    expect(fs.existsSync(path.join(tmpDir, "experiences", "org.md"))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, "index.md"))).toBe(false) // 未污染索引文件

    const active = listAllActiveRules("test-org")
    const found = active.find(r => r.rule_id === "org-exp-1")
    expect(found).toBeDefined()
    expect(found!.text).toBe("Org-wide: prefer prepared statements")
    // engine 注入器只认 global/project/workflow scope —— org 经验映射为 global
    expect(found!.scope).toBe("global")
  })

  it("update: 退休旧条目 + 追加新条目，旧文本历史保留但不再 active", async () => {
    const filePath = path.join(tmpDir, "workflows", "myflow.md")
    appendToKnowledgeFile(filePath, "OLD wording", "exp-up-1", "archive")

    const merger = new ExperienceMerger()
    const result = await merger.merge("test-org", [
      action({ id: "exp-up-1", text: "NEW wording", action: "update", scope: "workflow", target: "myflow" }),
    ], createNullEmitter())
    expect(result.updated).toBe(1)

    // append-only：旧行仍在文件里（带 retired 标记），但没有被整文件重写抹掉 id
    const all = listAllRules("test-org")
    expect(all.find(r => r.rule_id === "exp-up-1")!.retired).toBe(true)

    const active = listAllActiveRules("test-org")
    expect(active.some(r => r.text === "OLD wording")).toBe(false)
    expect(active.some(r => r.text === "NEW wording")).toBe(true)
  })

  it("update: 目标 id 不存在时按 add 落盘，不静默丢", async () => {
    const merger = new ExperienceMerger()
    const result = await merger.merge("test-org", [
      action({ id: "exp-ghost", text: "Update for a vanished entry", action: "update", scope: "workflow", target: "myflow" }),
    ], createNullEmitter())
    expect(result.added).toBe(1)
    expect(result.updated).toBe(0)
    expect(listAllActiveRules("test-org").some(r => r.text === "Update for a vanished entry")).toBe(true)
  })

  it("delete: 退休条目；id 不存在视为已删（幂等），不虚报丢失", async () => {
    const filePath = path.join(tmpDir, "workflows", "myflow.md")
    appendToKnowledgeFile(filePath, "Doomed rule", "exp-del-1", "archive")

    const merger = new ExperienceMerger()
    const result = await merger.merge("test-org", [
      action({ id: "exp-del-1", text: "Doomed rule", action: "delete", scope: "workflow", target: "myflow" }),
      action({ id: "exp-nothing", text: "Never existed", action: "delete", scope: "workflow", target: "myflow" }),
    ], createNullEmitter())
    expect(result.deleted).toBe(2)

    expect(listAllActiveRules("test-org").some(r => r.text === "Doomed rule")).toBe(false)
    expect(listAllRules("test-org").find(r => r.rule_id === "exp-del-1")!.retired).toBe(true)
  })

  it("每条 add 的经验合并后都必须能数到（旧实现的静默丢失回归锚点）", async () => {
    const merger = new ExperienceMerger()
    const texts = ["e-1", "e-2", "e-3", "e-4"].map(t => `Experience ${t}`)
    const actions = texts.map((t, i) =>
      action({ id: `bulk-${i}`, text: t, scope: i % 2 === 0 ? "workflow" : "project", target: i % 2 === 0 ? "wf" : "rp" }),
    )
    await merger.merge("test-org", actions, createNullEmitter())

    const activeTexts = new Set(listAllActiveRules("test-org").map(r => r.text))
    for (const t of texts) expect(activeTexts.has(t)).toBe(true)
  })

  it("写盘失败必须抛出（不得 log+continue 吞掉已消费的经验）", async () => {
    // 让知识目录的父路径变成一个文件 → ENOTDIR
    const blocker = path.join(os.tmpdir(), `exp-blocker-${Date.now()}`)
    fs.writeFileSync(blocker, "not a directory")
    process.env.OCTOPUS_KNOWLEDGE_DIR = path.join(blocker, "knowledge")

    const merger = new ExperienceMerger()
    try {
      await expect(merger.merge("test-org", [
        action({ id: "exp-fail-1", text: "Must not vanish silently" }),
      ], createNullEmitter())).rejects.toThrow()
    } finally {
      fs.rmSync(blocker, { force: true })
    }
  })

  it("空输入返回全 0，不碰磁盘", async () => {
    const merger = new ExperienceMerger()
    const result = await merger.merge("test-org", [], createNullEmitter())
    expect(result).toEqual({ added: 0, updated: 0, deleted: 0 })
    expect(fs.readdirSync(tmpDir)).toHaveLength(0)
  })
})
