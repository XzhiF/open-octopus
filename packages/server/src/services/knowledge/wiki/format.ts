import { load as yamlLoad, JSON_SCHEMA } from "js-yaml"
import { WikiEntryFrontmatterSchema, type WikiEntryFrontmatter } from "@octopus/shared"

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
