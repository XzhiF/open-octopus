import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { ensureSchemaDoc, SCHEMA_DOC_FILE, SCHEMA_MD_TEMPLATE } from "../schema-doc"

/**
 * 票05 · SCHEMA.md 首版（AC4）S1 — 模板入仓 + 幂等 seed 进知识根。
 * 内容判据逐字取自票面与 spec §三层架构（「首版吸收 octo-wiki-curate 的编译纪律/
 * 页格式约定/命名法/工作流」）与 prototype Tab②「SCHEMA.md = 共演约定」契约——
 * expected 不来自实现。真 fs tmpdir，绝不碰 ~/.octopus。
 */

describe("SCHEMA.md 首版 — 模板 + 幂等 seed（票05 AC4）", () => {
  let tmpDir: string
  let root: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-schema-"))
    root = path.join(tmpDir, "knowledge")
    fs.mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("seeds SCHEMA.md at the knowledge root containing curate discipline / page format / naming / workflow", () => {
    const created = ensureSchemaDoc(root)
    expect(created).toBe(true)
    const text = fs.readFileSync(path.join(root, SCHEMA_DOC_FILE), "utf-8")
    // 编译纪律：唯一写闸 + 一次编译一 commit + INDEX/LOG 程序化
    expect(text).toContain("唯一写闸")
    expect(text).toContain("一个 git commit")
    expect(text).toContain("程序化")
    // 页格式约定：五类页 + front-matter v3 + 正文零日期 + 断链校验
    expect(text).toMatch(/entities[\s\S]*concepts[\s\S]*topics[\s\S]*sources[\s\S]*cases/)
    expect(text).toContain("零日期")
    expect(text).toContain("断链")
    // 命名法：kebab id 前缀 + 锚点只活 topic 硬约束、全库唯一永不复用
    expect(text).toContain("oct-NNN")
    expect(text).toContain("硬约束")
    expect(text).toContain("永不复用")
    expect(text).toContain("kebab")
    // 工作流：投喂即编译 + 矛盾不静默覆盖 + 人工文件写保护
    expect(text).toContain("矛盾")
    expect(text).toContain("不静默覆盖")
    expect(text).toContain("人工确认制")
    expect(text).toContain("写保护")
  })

  it("is idempotent and never overwrites a hand-edited SCHEMA.md（人机共演：人工文件）", () => {
    ensureSchemaDoc(root)
    // 模拟 owner 改写（策展人/系统永不回写）
    const edited = "# SCHEMA.md — 共演约定\n\nowner 手动增补一条约定：sources 页要点 ≤6 条。\n"
    fs.writeFileSync(path.join(root, SCHEMA_DOC_FILE), edited, "utf-8")

    expect(ensureSchemaDoc(root)).toBe(false)
    expect(fs.readFileSync(path.join(root, SCHEMA_DOC_FILE), "utf-8")).toBe(edited)
  })

  it("template is non-empty and starts with a title line（模板单源可被 seed 之外消费方 import）", () => {
    expect(SCHEMA_MD_TEMPLATE.startsWith("# SCHEMA.md")).toBe(true)
    expect(SCHEMA_MD_TEMPLATE.length).toBeGreaterThan(1000)
  })
})
