/**
 * 票08 清理账 S1 — 空 v2 域目录退役（spec 故事29）。
 *
 * 断言全走 fs 外部行为（tmpdir，零触真盘）：
 *   A1 ensureWikiSkeleton 不再长出 v2 域目录；只建 v3 五类 + _retired（含 cases）。
 *   A2 removeEmptyV2DomainDirs 只删**空**目录；非空即跳过并留痕；缺失即幂等 no-op。
 *   A3 cases 永不列入清理（判例目的地面）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import {
  ensureWikiSkeleton,
  removeEmptyV2DomainDirs,
  V2_LEGACY_DOMAINS,
  WIKI_PAGE_DIRS,
} from "../paths"

const V2_DOMAINS = ["projects", "workflows", "business", "research"] as const

describe("wiki v2 空域目录退役（票08 · 故事29）", () => {
  let root: string
  const logs: string[] = []
  const capture = (m: string) => logs.push(m)

  beforeEach(() => {
    logs.length = 0
    root = fs.mkdtempSync(path.join(os.tmpdir(), "aa08-vik-root-"))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("A1 ensureWikiSkeleton 建 v3 五类 + _retired，绝不建 v2 域目录", () => {
    ensureWikiSkeleton(root)
    for (const d of WIKI_PAGE_DIRS) expect(fs.existsSync(path.join(root, d))).toBe(true)
    expect(fs.existsSync(path.join(root, "_retired"))).toBe(true)
    expect(fs.existsSync(path.join(root, "cases"))).toBe(true) // 判例域保留
    for (const d of V2_DOMAINS) expect(fs.existsSync(path.join(root, d))).toBe(false)
  })

  it("A2 只删空目录、非空跳过、缺失幂等", () => {
    // 造混合态：projects 空、business 空、research 不存在、workflows 有内容
    fs.mkdirSync(path.join(root, "projects"), { recursive: true })
    fs.mkdirSync(path.join(root, "business"), { recursive: true })
    fs.mkdirSync(path.join(root, "workflows"), { recursive: true })
    const keptFile = path.join(root, "workflows", "legacy.md")
    fs.writeFileSync(keptFile, "- 历史词条")

    const res = removeEmptyV2DomainDirs(root, capture)

    expect(res.removed.sort()).toEqual(["business", "projects"])
    expect(res.skipped).toEqual(["workflows"]) // research 不存在 → 既不删也不跳（no-op）
    expect(fs.existsSync(path.join(root, "projects"))).toBe(false)
    expect(fs.existsSync(path.join(root, "business"))).toBe(false)
    expect(fs.existsSync(path.join(root, "workflows"))).toBe(true)
    expect(fs.readFileSync(keptFile, "utf-8")).toContain("历史词条") // 有内容目录零损失
    expect(logs.some((l) => l.includes("非空"))).toBe(true) // 留痕

    // 幂等再跑：空目录已没了，非空仍跳过，不报错
    const again = removeEmptyV2DomainDirs(root, capture)
    expect(again.removed).toEqual([])
    expect(again.skipped).toEqual(["workflows"])
  })

  it("A3 cases 绝不进清理面", () => {
    expect(V2_LEGACY_DOMAINS).not.toContain("cases")
    // 即便 cases 为空也不被 removeEmptyV2DomainDirs 触碰
    fs.mkdirSync(path.join(root, "cases"), { recursive: true })
    const res = removeEmptyV2DomainDirs(root, capture)
    expect(res.removed).not.toContain("cases")
    expect(fs.existsSync(path.join(root, "cases"))).toBe(true)
  })
})
