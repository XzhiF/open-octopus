import { describe, it, expect } from "vitest"
import {
  parseEntryMarkdown,
  serializeEntryMarkdown,
  extractRuleAnchors,
  findDateOccurrences,
} from "../format"

/**
 * Fixture front-matter — quoted VERBATIM from spec.md §知识表示 (格式 v2)
 * and prototype.md Tab③ lines 459-486 (primary source, no re-derivation).
 */
const SAMPLE_ENTRY = `---
id: prj-octopus
domain: projects
title: Octopus 平台工程知识
summary: monorepo 构建/测试/端口规则与已知陷阱
topics: [build, test, ports, pitfall]
stability: stable          # stable | volatile（volatile 必带 review_after 日期）
last_compiled: 2026-10-12
sources: [archive:task-207, chat:session-8f21, doc:windows-bash.md]
confidence: 0.86           # 本期为静态初值，effectiveness 滚动更新属 P4
---

## 构建规则
- 修改 shared/ 后必须 \`pnpm build -w shared\` 再全量构建 <!--#oct-001-->
- 构建命令: \`pnpm build\` <!--#oct-002-->

## 已知陷阱
- Promise.allSettled 聚合调用必须设全局超时 <!--#oct-007-->
- stale 检测一律用 updated_at（不是 started_at） <!--#oct-008-->

## 端口规则
- ⛔ 保护端口: 3000, 3001, 3098, 3099 <!--#oct-010-->
- Windows 拆机三段式: pnpm port → kill:port → netstat 复核 <!--#oct-012-->
`

describe("wiki entry format (格式 v2)", () => {
  it("parses the prototype sample entry into schema-valid front-matter", () => {
    const { meta, body } = parseEntryMarkdown(SAMPLE_ENTRY)

    // Expected values are hand-copied from the spec sample — independent truth source.
    expect(meta).toEqual({
      id: "prj-octopus",
      domain: "projects",
      title: "Octopus 平台工程知识",
      summary: "monorepo 构建/测试/端口规则与已知陷阱",
      topics: ["build", "test", "ports", "pitfall"],
      stability: "stable",
      review_after: undefined,
      last_compiled: "2026-10-12", // string, NOT a JS Date (JSON_SCHEMA)
      sources: ["archive:task-207", "chat:session-8f21", "doc:windows-bash.md"],
      confidence: 0.86,
    })
    expect(body.startsWith("## 构建规则")).toBe(true)
    expect(body).not.toContain("---")
  })

  it("extracts invisible rule anchors in document order", () => {
    const { body } = parseEntryMarkdown(SAMPLE_ENTRY)
    // Anchor list copied from the fixture lines above (prototype Tab③ lines 493-503).
    expect(extractRuleAnchors(body)).toEqual([
      "oct-001", "oct-002", "oct-007", "oct-008", "oct-010", "oct-012",
    ])
  })

  it("rejects entries without front-matter delimiters, with a readable error", () => {
    expect(() => parseEntryMarkdown("# just a heading\nno front-matter here\n"))
      .toThrow(/INVALID_FRONTMATTER/)
  })

  it("rejects a missing required field, naming it in the error", () => {
    const noSummary = SAMPLE_ENTRY.replace("summary: monorepo 构建/测试/端口规则与已知陷阱\n", "")
    expect(() => parseEntryMarkdown(noSummary)).toThrow(/INVALID_FRONTMATTER.*summary/s)
  })

  it("rejects volatile stability without review_after (readable error)", () => {
    const volatile = SAMPLE_ENTRY.replace("stability: stable", "stability: volatile")
    expect(() => parseEntryMarkdown(volatile)).toThrow(/INVALID_FRONTMATTER.*review_after/s)
  })

  it("accepts volatile stability when review_after is present", () => {
    const volatile = SAMPLE_ENTRY
      .replace("stability: stable", "stability: volatile")
      .replace("last_compiled: 2026-10-12", "review_after: 2027-01-15\nlast_compiled: 2026-10-12")
    const { meta } = parseEntryMarkdown(volatile)
    expect(meta.stability).toBe("volatile")
    expect(meta.review_after).toBe("2027-01-15")
  })

  it("rejects an unknown domain value", () => {
    const badDomain = SAMPLE_ENTRY.replace("domain: projects", "domain: gossip")
    expect(() => parseEntryMarkdown(badDomain)).toThrow(/INVALID_FRONTMATTER.*domain/s)
  })

  it("serializes front-matter in the prototype field order and round-trips", () => {
    const { meta, body } = parseEntryMarkdown(SAMPLE_ENTRY)
    const out = serializeEntryMarkdown(meta, body)
    // Field order per spec sample: id/domain/title/summary/topics/stability/last_compiled/sources/confidence
    expect(out.startsWith("---\nid: prj-octopus\ndomain: projects\ntitle: Octopus 平台工程知识\nsummary: monorepo 构建/测试/端口规则与已知陷阱\ntopics: [build, test, ports, pitfall]\nstability: stable\nlast_compiled: 2026-10-12\nsources: [archive:task-207, chat:session-8f21, doc:windows-bash.md]\nconfidence: 0.86\n---\n")).toBe(true)
    // Re-parse yields the same meta (parse↔serialize consistency on fixture-derived data)
    expect(parseEntryMarkdown(out).meta).toEqual(meta)
  })

  it("flags ISO/slash/年月 dates in the body (L5 预检 input)", () => {
    // Date fixtures from prototype lines (cases file mentions & CI sample wording)
    const hits = findDateOccurrences("- 修复 CI 升 pnpm 10（commit 82d96372，2026-06-23）\n- 会议定在 2026/7/1\n- 记于2026年10月12日\n")
    expect(hits).toEqual(["2026-06-23", "2026/7/1", "2026年10月12日"])
  })

  it("finds no date occurrences in the evergreen sample body", () => {
    const { body } = parseEntryMarkdown(SAMPLE_ENTRY)
    expect(findDateOccurrences(body)).toEqual([])
  })
})
