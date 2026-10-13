import { describe, it, expect } from "vitest"
import { LOCATABLE_SOURCE_RE } from "@octopus/shared"
import {
  parseEntryMarkdown,
  parseWikiFile,
  serializeEntryMarkdown,
  serializeCaseMarkdown,
  serializePageMarkdown,
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

// ── 票04：判例 (cases) 文件层 — schema/解析/序列化 ──────────────────
const CASE_FILE = `---
id: case-2026-003
symptom: CI 报 LOCKFILE_CONFIG_MISMATCH
tags: [ci, pnpm, lockfile]
severity: blocker
occurrences: 2
rule_ref: oct-013
source: task-207 / exec-9f31
status: distilled
---
## 现场  pnpm 9 的 CI 读 v10 lockfile…
## 诊断  overrides 住在 pnpm-workspace.yaml…
## 根因  lockfile 格式版本与 CLI 版本错配
## 修复  CI 升 pnpm 10（commit 82d96372）
## 教训  工具链大版本升级先查配置文件归属变化
`

describe("cases file layer (ticket 04)", () => {
  it("parseWikiFile dispatches by symptom field: entry stays entry, case becomes case", () => {
    expect(parseWikiFile(SAMPLE_ENTRY).kind).toBe("entry")
    const f = parseWikiFile(CASE_FILE)
    expect(f.kind).toBe("case")
    if (f.kind !== "case") return
    // expected 逐字 prototype Tab③ lines 514-528（独立真相源）
    expect(f.meta).toEqual({
      id: "case-2026-003",
      domain: "cases",
      symptom: "CI 报 LOCKFILE_CONFIG_MISMATCH",
      tags: ["ci", "pnpm", "lockfile"],
      severity: "blocker",
      occurrences: 2,
      rule_ref: "oct-013",
      source: "task-207 / exec-9f31",
      status: "distilled",
    })
    expect(f.body).toContain("## 教训")
  })

  it("rejects invalid case front-matter: unknown status enum, missing severity, bad rule_ref", () => {
    expect(() => parseWikiFile(CASE_FILE.replace("status: distilled", "status: resolved"))).toThrow(/status/)
    expect(() => parseWikiFile(CASE_FILE.replace("severity: blocker\n", ""))).toThrow(/severity/)
    expect(() => parseWikiFile(CASE_FILE.replace("rule_ref: oct-013", "rule_ref: bad ref"))).toThrow(/rule_ref/)
    // open 判例合法地没有 rule_ref
    expect(parseWikiFile(CASE_FILE.replace("rule_ref: oct-013\n", "").replace("status: distilled", "status: open")).kind).toBe("case")
  })

  it("serializes case in the prototype field order and round-trips", () => {
    const f = parseWikiFile(CASE_FILE)
    if (f.kind !== "case") throw new Error("fixture must be a case")
    const out = serializeCaseMarkdown(f.meta, f.body)
    expect(out.startsWith("---\nid: case-2026-003\ndomain: cases\nsymptom: CI 报 LOCKFILE_CONFIG_MISMATCH\ntags: [ci, pnpm, lockfile]\nseverity: blocker\noccurrences: 2\nrule_ref: oct-013\nsource: task-207 / exec-9f31\nstatus: distilled\n---\n")).toBe(true)
    expect(parseWikiFile(out).kind).toBe("case")
  })

  it("source locatability gate: task/exec/commit pointers pass, vague talk fails (准入 D5)", () => {
    expect(LOCATABLE_SOURCE_RE.test("task-207 / exec-9f31")).toBe(true)
    expect(LOCATABLE_SOURCE_RE.test("exec-8a02")).toBe(true)
    expect(LOCATABLE_SOURCE_RE.test("commit 82d96372")).toBe(true)
    expect(LOCATABLE_SOURCE_RE.test("archive:ws-feat-actuator:2026-06-23")).toBe(true)
    expect(LOCATABLE_SOURCE_RE.test("听说的")).toBe(false)
    expect(LOCATABLE_SOURCE_RE.test("大概去年吧")).toBe(false)
  })
})

// ── 票04：页格式 v3（五类页）— 分派/schema/序列化 ─────────────────────
// fixture 逐字 prototype Tab② 页样例（entities/open-octopus 与 topics/prd-impl-workflow
// 的 front-matter 面）——独立真相源，禁从实现反推。

const V3_ENTITY_FILE = `---
id: ent-open-octopus
type: entity
entity_kind: project
title: Open Octopus（平台 monorepo）
summary: pnpm monorepo：engine/server/web-app/shared/cli/core-pack 六包
aliases: [octopus, open-octopus]
links: "[[top-prd-impl]] [[con-execution-identity]] [[ent-hermes]]"
sources: [raw/archives/task-207-summary.md, raw/inbox/2026-09-xx-arch-notes.md]
last_compiled: 2026-10-13
confidence: 0.9
---

## 概述
桩正文（序列化面）。
`

const V3_TOPIC_FILE = `---
id: top-prd-impl
type: topic
title: prd-impl 工作流知识
summary: PRD→实现→审查→ship 的 SOP、硬约束与已知陷阱
links: "[[ent-open-octopus]] [[top-windows-bash-ops]]"
sources: [raw/archives/task-183-summary.md, review-history:wf-prd-impl]
last_compiled: 2026-10-13
stability: stable
---

## 硬约束
- 修改 shared/ 后必须先 pnpm build -w shared 再全量构建 <!--#oct-008-->
`

describe("page format v3 (ticket 04)", () => {
  it("parseWikiFile dispatches type-bearing files to the v3 page pipeline (v2 domain files untouched)", () => {
    expect(parseWikiFile(SAMPLE_ENTRY).kind).toBe("entry")
    expect(parseWikiFile(CASE_FILE).kind).toBe("case")
    const f = parseWikiFile(V3_ENTITY_FILE)
    expect(f.kind).toBe("page")
    if (f.kind !== "page") return
    // expected 逐字 prototype Tab② 实体页样例
    expect(f.meta.type).toBe("entity")
    expect(f.meta.entity_kind).toBe("project")
    expect(f.meta.title).toBe("Open Octopus（平台 monorepo）")
    expect(f.meta.aliases).toEqual(["octopus", "open-octopus"])
    expect(f.meta.links).toEqual(["top-prd-impl", "con-execution-identity", "ent-hermes"])
    expect(f.meta.sources).toEqual(["raw/archives/task-207-summary.md", "raw/inbox/2026-09-xx-arch-notes.md"])
    expect(f.meta.last_compiled).toBe("2026-10-13")
    expect(f.meta.confidence).toBe(0.9)
    expect(f.meta.stability).toBeUndefined()
    expect(f.meta.topics).toEqual([])
  })

  it("topic page keeps stability without confidence (prototype sample asymmetry)", () => {
    const f = parseWikiFile(V3_TOPIC_FILE)
    if (f.kind !== "page") throw new Error("fixture must be a v3 page")
    expect(f.meta.stability).toBe("stable")
    expect(f.meta.confidence).toBeUndefined()
    expect(f.meta.links).toEqual(["ent-open-octopus", "top-windows-bash-ops"])
    expect(f.meta.sources[1]).toBe("review-history:wf-prd-impl")
  })

  it("serializes page in prototype field order and round-trips (links as YAML-nested [[a], [b]])", () => {
    const f = parseWikiFile(V3_ENTITY_FILE)
    if (f.kind !== "page") throw new Error("fixture must be a v3 page")
    const out = serializePageMarkdown(f.meta, f.body)
    expect(out.startsWith(
      "---\nid: ent-open-octopus\ntype: entity\nentity_kind: project\ntitle: Open Octopus（平台 monorepo）\nsummary: pnpm monorepo：engine/server/web-app/shared/cli/core-pack 六包\naliases: [octopus, open-octopus]\nlinks: [[top-prd-impl], [con-execution-identity], [ent-hermes]]\nlast_compiled: 2026-10-13\nsources: [raw/archives/task-207-summary.md, raw/inbox/2026-09-xx-arch-notes.md]\nconfidence: 0.9\n---\n",
    )).toBe(true)
    expect(parseWikiFile(out)).toEqual(f)
  })

  it("rejects bare type:case page without case fields — 判例走判例管线（P0 形态保留）", () => {
    const bare = V3_ENTITY_FILE.replace("type: entity", "type: case").replace("entity_kind: project\n", "")
    expect(() => parseWikiFile(bare)).toThrow(/INVALID_FRONTMATTER.*判例/s)
  })

  it("rejects entity_kind on non-entity pages and volatile without review_after", () => {
    expect(() => parseWikiFile(V3_TOPIC_FILE.replace("type: topic", "type: topic\nentity_kind: project"))).toThrow(/entity_kind/)
    const volatile = V3_TOPIC_FILE.replace("stability: stable", "stability: volatile")
    expect(() => parseWikiFile(volatile)).toThrow(/review_after/)
  })

  it("links normalizes all three token shapes to bare targets (space串/嵌套序列/引号串)", () => {
    const nested = V3_ENTITY_FILE.replace(`links: "[[top-prd-impl]] [[con-execution-identity]] [[ent-hermes]]"`, "links: [[top-prd-impl], [con-execution-identity], [ent-hermes]]")
    const f = parseWikiFile(nested)
    if (f.kind !== "page") throw new Error("fixture must be a v3 page")
    expect(f.meta.links).toEqual(["top-prd-impl", "con-execution-identity", "ent-hermes"])
  })
})
