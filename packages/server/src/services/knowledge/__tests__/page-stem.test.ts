/**
 * aa-fix 项②2 等价钉：实效账目页键 stem 归一单源（page-stem.ts）。
 * 手算向量（期望值逐条独立心算，非公式重算）钉「行为零变」：
 * - stripMdSuffix ← patrol.ts buildResolver 全路径去缀键旧式（大小写敏感版，
 *   扫描面文件名恒小写 .md ⇒ 可达面等价）；
 * - pageLedgerStem ← effectiveness-ledger.ts normalizeRefEntry 末段键旧式
 *   （split→pop→replace(/\.md$/i,"")→trim，逐字同序）与 auto-retire.ts
 *   toNarrowGatePage pageLedgerKey 旧式（同式无 trim——扫描 relPath 无空白⇒等价）。
 */
import { describe, it, expect } from "vitest"
import { stripMdSuffix, pageLedgerStem } from "../page-stem"

describe("stripMdSuffix — 去 .md 尾缀（单源）", () => {
  it.each([
    ["entities/ent-a.md", "entities/ent-a"],
    ["a.md.md", "a.md"],
    ["topics/top-x", "topics/top-x"],
    ["ent.MD", "ent"],
    ["", ""],
    [".md", ""],
    ["a.markdown", "a.markdown"],
  ] as const)("手算向量 %j ⇒ %j", (input, expected) => {
    expect(stripMdSuffix(input)).toBe(expected)
  })
})

describe("pageLedgerStem — 账目页键=末段去缀再 trim（单源）", () => {
  it.each([
    ["entities/ent-a.md", "ent-a"],
    ["concepts\\con-b.md", "con-b"],
    ["topics/hub-x/README.md", "README"],
    [" b.md ", "b.md"], // 先去缀后 trim（尾空白使 \.md$ 不中）——旧 ledger 同序，钉顺序语义
    [" b.md", "b"],
    ["no-ext", "no-ext"],
    ["x/.md", ""],
    ["", ""],
  ] as const)("手算向量 %j ⇒ %j", (input, expected) => {
    expect(pageLedgerStem(input)).toBe(expected)
  })

  it("对扫描面 relPath 与两份旧式逐字等价（正向+歧义面各验一线）", () => {
    // auto-retire 旧式（无 trim、正斜杠切分）——扫描 relPath 无空白 ⇒ 同值
    const oldAutoRetire = (relPath: string) => (relPath.split("/").pop() ?? "").replace(/\.md$/i, "")
    for (const rel of ["entities/ent-a.md", "cases/2026-10-01-c.md", "topics/hub-x/README.md"]) {
      expect(pageLedgerStem(rel)).toBe(oldAutoRetire(rel))
    }
    // patrol 尾段旧式（大小写敏感）——文件名恒小写 .md ⇒ 同值
    const oldPatrolBase = (relPath: string) => (relPath.split("/").pop() ?? relPath).replace(/\.md$/, "")
    for (const rel of ["concepts/con-a.md", "sources/src-b.md"]) {
      expect(stripMdSuffix(rel.split("/").pop() ?? rel)).toBe(oldPatrolBase(rel))
    }
  })
})
