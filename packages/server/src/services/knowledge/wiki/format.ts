import { load as yamlLoad, JSON_SCHEMA } from "js-yaml"
import {
  WikiEntryFrontmatterSchema,
  WikiCaseFrontmatterSchema,
  WikiPageFrontmatterSchema,
  type WikiEntryFrontmatter,
  type WikiCaseFrontmatter,
  type WikiPageFrontmatter,
  type WikiPageType,
  type WikiDomain,
  WIKI_PAGE_DIR_BY_TYPE,
  WIKI_DOMAIN_TO_PAGE_TYPE,
} from "@octopus/shared"

/**
 * 词条 (Entry) 格式 v2 解析/序列化 —— front-matter 手工按 `---` 切分 +
 * js-yaml `load`（JSON_SCHEMA：不让 js-yaml 把裸日期转成 JS Date，仓库先例
 * server/src/index.ts CJS load 同款）+ zod 校验。仓库无 gray-matter，不新增依赖。
 */

export interface ParsedEntryFile {
  meta: WikiEntryFrontmatter
  body: string
}

/**
 * Split `---\n<yaml>\n---\n<body>` into { yaml block, body }.
 * Unlike the legacy knowledge files (file-ops.parseKnowledgeFile), v2 entries
 * always begin with front-matter — a missing delimiter is a hard error.
 */
function splitFrontMatter(raw: string): { frontMatter: string; body: string } {
  const text = raw.replace(/\r\n/g, "\n")
  const lines = text.split("\n")
  if (lines[0]?.trim() !== "---") {
    throw new Error("INVALID_FRONTMATTER: 文件必须以 '---' front-matter 开头（第一行）")
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---")
  if (end === -1) {
    throw new Error("INVALID_FRONTMATTER: front-matter 缺少结束的 '---' 行")
  }
  return {
    frontMatter: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n").replace(/^\n+/, "").replace(/\n+$/, "\n"),
  }
}

/**
 * Parse a v2 entry file. Throws `INVALID_FRONTMATTER: <field>: <message>`
 * with a human-readable reason (ticket 01 acceptance: 不合规拒绝编译并给出可读错误).
 */
export function parseEntryMarkdown(raw: string): ParsedEntryFile {
  const { frontMatter, body } = splitFrontMatter(raw)

  let data: unknown
  try {
    // JSON_SCHEMA — keeps `last_compiled: 2026-10-12` a string, not a Date.
    data = yamlLoad(frontMatter, { schema: JSON_SCHEMA })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`INVALID_FRONTMATTER: YAML 解析失败 — ${msg.split("\n")[0]}`)
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("INVALID_FRONTMATTER: front-matter 必须是键值映射")
  }

  const parsed = WikiEntryFrontmatterSchema.safeParse(data)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(i => `${i.path.join(".") || "(front-matter)"}: ${i.message}`)
      .join("; ")
    throw new Error(`INVALID_FRONTMATTER: ${detail}`)
  }

  return { meta: parsed.data, body }
}

/** Quote a scalar only when bare emission would be ambiguous in YAML. */
function yamlScalar(value: string): string {
  if (/[:#]/.test(value) || /^[\s\-?[\]{}|>*&!%@`'"]/.test(value) || /\n/.test(value) || value !== value.trim()) {
    return JSON.stringify(value)
  }
  return value
}

/**
 * Serialize front-matter + body back to a v2 entry file.
 * Field order follows the spec sample verbatim
 * (id/domain/title/summary/topics/stability/[review_after]/last_compiled/sources/confidence)
 * so git diffs of recompiled entries stay stable.
 */
export function serializeEntryMarkdown(meta: WikiEntryFrontmatter, body: string): string {
  const lines = [
    "---",
    `id: ${meta.id}`,
    `domain: ${meta.domain}`,
    `title: ${yamlScalar(meta.title)}`,
    `summary: ${yamlScalar(meta.summary)}`,
    `topics: [${meta.topics.join(", ")}]`,
    `stability: ${meta.stability}`,
  ]
  if (meta.review_after) lines.push(`review_after: ${meta.review_after}`)
  lines.push(
    `last_compiled: ${meta.last_compiled}`,
    `sources: [${meta.sources.join(", ")}]`,
    `confidence: ${meta.confidence}`,
    "---",
    "",
  )
  return lines.join("\n") + (body.endsWith("\n") ? body : body + "\n")
}

/** Rule-line anchor `<!--#oct-001-->` — invisible id, 格式 v2 唯一保留的行内注释 (prototype Tab③). */
export const RULE_ANCHOR_RE = /<!--#([A-Za-z0-9_-]+)-->/

/** Extract anchor ids in document order (duplicates preserved — uniqueness is the caller's check). */
export function extractRuleAnchors(body: string): string[] {
  const out: string[] = []
  const re = new RegExp(RULE_ANCHOR_RE.source, "g")
  for (const m of body.matchAll(re)) {
    out.push(m[1])
  }
  return out
}

/**
 * L5 正文禁日期巡检 (warn 预检，ticket 01 只做预检；完整 lint 闸属 ticket 02)。
 * Matches ISO (2026-06-23), slash (2026/7/1) and 年月日 (2026年10月12日) shapes.
 */
export function findDateOccurrences(body: string): string[] {
  return body.match(/\d{4}-\d{2}-\d{2}|\d{4}\/\d{1,2}\/\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日/g) ?? []
}

// ── 判例 (Case) 文件层（票04）──────────────────────────────────────
// cases/ front-matter 与词条 (Entry) 不同形（prototype Tab③ lines 514-528）：
// 没有 stability/confidence（历史记录的"稳定性"由蒸馏出的规则承担），
// 取而代之 symptom/tags/severity/occurrences/rule_ref/source/status。
// 解析层用 parseWikiFile 分派；下游（lint/DB/INDEX）消费 caseEntryView 视图。

export type ParsedWikiFile =
  | { kind: "entry"; meta: WikiEntryFrontmatter; body: string }
  | { kind: "case"; meta: WikiCaseFrontmatter; body: string }
  /** 页格式 v3（票04 基座）：type 五值替代 domain，links/aliases/entity_kind 新增。 */
  | { kind: "page"; meta: WikiPageFrontmatter; body: string }

/**
 * front-matter 分派判据（三层）：
 * 1) 有 symptom 字段即判例（entry/page schema 无此字段；判例保留 P0 形态——prototype Tab②）；
 * 2) 有 v3 `type` 走页管线（entity/concept/topic/source/case；case 走判例形态，页管线拒收裸 type:case）；
 * 3) 否则按 v2 词条（domain）管线——**兼容可读**（为重蒸馏票07 留路），写路径出 v3。
 */
export function parseWikiFile(raw: string): ParsedWikiFile {
  const { frontMatter, body } = splitFrontMatter(raw)
  let data: unknown
  try {
    data = yamlLoad(frontMatter, { schema: JSON_SCHEMA })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`INVALID_FRONTMATTER: YAML 解析失败 — ${msg.split("\n")[0]}`)
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("INVALID_FRONTMATTER: front-matter 必须是键值映射")
  }
  const rec = data as Record<string, unknown>
  if (typeof rec.symptom === "string") {
    const parsed = WikiCaseFrontmatterSchema.safeParse(data)
    if (!parsed.success) {
      const detail = parsed.error.issues.map(i => `${i.path.join(".") || "(front-matter)"}: ${i.message}`).join("; ")
      throw new Error(`INVALID_FRONTMATTER: ${detail}`)
    }
    return { kind: "case", meta: parsed.data, body }
  }
  if (typeof rec.type === "string") {
    const parsed = WikiPageFrontmatterSchema.safeParse(data)
    if (!parsed.success) {
      const detail = parsed.error.issues.map(i => `${i.path.join(".") || "(front-matter)"}: ${i.message}`).join("; ")
      throw new Error(`INVALID_FRONTMATTER: ${detail}`)
    }
    return { kind: "page", meta: parsed.data, body }
  }
  const parsed = WikiEntryFrontmatterSchema.safeParse(data)
  if (!parsed.success) {
    const detail = parsed.error.issues.map(i => `${i.path.join(".") || "(front-matter)"}: ${i.message}`).join("; ")
    throw new Error(`INVALID_FRONTMATTER: ${detail}`)
  }
  return { kind: "entry", meta: parsed.data, body }
}

/** 只读判例 front-matter（append-only 比对 / 检索 rule_ref 顺藤用）；非判例文件抛错。 */
export function parseCaseMarkdown(raw: string): { meta: WikiCaseFrontmatter; body: string } {
  const f = parseWikiFile(raw)
  if (f.kind !== "case") throw new Error("INVALID_FRONTMATTER: 不是判例 (cases) 文件")
  return f
}

/**
 * 判例 → 词条视图（lint L1/L5/DB upsert/统计消费的统一形态）。
 * symptom 同时落 title 与 summary（检索加权面）；stability 恒 stable——
 * 判例不做半衰期（准入 D5），"常青性"由 rule_ref 指向的规则承担。
 */
export function caseEntryView(meta: WikiCaseFrontmatter, lastCompiled: string): WikiEntryFrontmatter {
  return {
    id: meta.id,
    domain: "cases",
    title: meta.symptom,
    summary: meta.symptom,
    topics: [...meta.tags],
    stability: "stable",
    last_compiled: lastCompiled,
    sources: [meta.source],
    confidence: 1,
  }
}

/**
 * 判例文件序列化——字段顺序逐字 prototype Tab③ lines 514-528
 * (id/symptom/tags/severity/occurrences/[rule_ref]/source/status/[procedural])，
 * rule_ref/procedural 缺席时省略该行（open 判例尚无规则指针；未打标判例无流程型位）。
 */
export function serializeCaseMarkdown(meta: WikiCaseFrontmatter, body: string): string {
  const lines = [
    "---",
    `id: ${meta.id}`,
    `domain: cases`,
    `symptom: ${yamlScalar(meta.symptom)}`,
    `tags: [${meta.tags.join(", ")}]`,
    `severity: ${meta.severity}`,
    `occurrences: ${meta.occurrences}`,
  ]
  if (meta.rule_ref) lines.push(`rule_ref: ${meta.rule_ref}`)
  lines.push(
    `source: ${yamlScalar(meta.source)}`,
    `status: ${meta.status}`,
  )
  // aa-fix 项8：蒸馏「流程型」标记（true/false 皆显式写位=词表兜底让位；缺席=不写行）
  if (meta.procedural !== undefined) lines.push(`procedural: ${meta.procedural}`)
  lines.push("---", "")
  return lines.join("\n") + (body.endsWith("\n") ? body : body + "\n")
}

// ── 页格式 v3（票04）：序列化 + 统一视图 ──────────────────────────────

/**
 * v3 页序列化。字段顺序逐字 prototype Tab② 实体页样例
 * (id/type/[entity_kind]/title/summary/[topics]/[aliases]/links/[stability]/[review_after]/last_compiled/sources/[confidence])，
 * 重编译 git diff 稳定。links 序列化为 YAML 嵌套式 `[[a], [b]]`——原型 token `[[a]] [[b]]`
 * 空格串不可直接入 YAML，嵌套式是最贴近原型且可解析、可往返的等价形（偏离已在票报告备案）。
 */
export function serializePageMarkdown(meta: WikiPageFrontmatter, body: string): string {
  const lines = [
    "---",
    `id: ${meta.id}`,
    `type: ${meta.type}`,
  ]
  if (meta.entity_kind) lines.push(`entity_kind: ${yamlScalar(meta.entity_kind)}`)
  lines.push(
    `title: ${yamlScalar(meta.title)}`,
    `summary: ${yamlScalar(meta.summary)}`,
  )
  if (meta.topics.length > 0) lines.push(`topics: [${meta.topics.join(", ")}]`)
  if (meta.aliases.length > 0) lines.push(`aliases: [${meta.aliases.join(", ")}]`)
  lines.push(`links: [${meta.links.map(l => `[${yamlScalar(l)}]`).join(", ")}]`)
  if (meta.stability) lines.push(`stability: ${meta.stability}`)
  if (meta.review_after) lines.push(`review_after: ${meta.review_after}`)
  lines.push(`last_compiled: ${meta.last_compiled}`)
  lines.push(`sources: [${meta.sources.join(", ")}]`)
  if (meta.confidence !== undefined) lines.push(`confidence: ${meta.confidence}`)
  if (meta.status) lines.push(`status: ${meta.status}`) // 票08：仅退役页写此字段
  lines.push("---", "")
  return lines.join("\n") + (body.endsWith("\n") ? body : body + "\n")
}

/** v3 type → 页目录（entities/concepts/topics/sources/cases）。 */
export function pageDirForType(type: WikiPageType): string {
  return WIKI_PAGE_DIR_BY_TYPE[type]
}

/**
 * v3 页 → 词条视图（扫描/INDEX/DB 统一消费形态，pageEntryView 不落盘）。
 * domain 位放页目录名（形态层内部值，非 WikiDomain 枚举——消费方只读不校验）。
 */
export function pageEntryView(meta: WikiPageFrontmatter): WikiEntryFrontmatter {
  return {
    id: meta.id,
    domain: WIKI_PAGE_DIR_BY_TYPE[meta.type] as unknown as WikiDomain,
    title: meta.title,
    summary: meta.summary,
    topics: [...meta.topics],
    stability: meta.stability ?? "stable",
    ...(meta.review_after ? { review_after: meta.review_after } : {}),
    last_compiled: meta.last_compiled,
    sources: [...meta.sources],
    confidence: meta.confidence ?? 0.5,
  }
}

/** 扫描统一分型：v3 页取 type；v2 词条按 domain→type 映射（兼容读面，INDEX 分组用）。 */
export function pageTypeOf(meta: WikiEntryFrontmatter | WikiPageFrontmatter): WikiPageType {
  return "type" in meta ? meta.type : WIKI_DOMAIN_TO_PAGE_TYPE[meta.domain]
}
