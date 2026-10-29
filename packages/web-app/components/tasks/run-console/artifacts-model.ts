// packages/web-app/components/tasks/run-console/artifacts-model.ts
//
// 产物窗口展示模型纯层（2026-10-29 方案2）：server 已按 phase × 轮次归好组，
// 前端不重分组、不反推；这里只榨显示事实：总件数 / 单 phase 件数 / 预览截断。
//
// 体积记数走 lib/format.ts::formatBytes 单源（C4）。

import type { ArtifactManifestBody, ArtifactManifestPhase } from "@/lib/types"

/** 一个 phase 的产物件数（批次级 + 各轮次）。 */
export function phaseArtifactCount(phase: ArtifactManifestPhase): number {
  return phase.items.length + phase.rounds.reduce((n, r) => n + r.items.length, 0)
}

/** 全部件数 = phases + 未归属 + 原型。 */
export function manifestTotalCount(body: ArtifactManifestBody): number {
  return (
    body.phases.reduce((n, p) => n + phaseArtifactCount(p), 0) +
    body.unassigned.length +
    body.prototype.length
  )
}

/** 预览截断（对话框现读文本；server 读门已按 512KB 封顶，这里再按字符数视觉封顶）。 */
export function previewTruncate(content: string, maxChars = 20_000): { text: string; truncated: boolean } {
  if (content.length <= maxChars) return { text: content, truncated: false }
  return { text: content.slice(0, maxChars), truncated: true }
}

// ── JSON 预览高亮（2026-10-29 用户：runbook.json 不能只有裸文本）──────────
// 纯函数：格式化（能 parse 就 2 空格缩进，parse 不了原样返回）+ 词法切分。
// 渲染层只按 kind 上色，不做二次解析。

export type JsonTokenKind = "key" | "string" | "number" | "boolean" | "null" | "punct" | "plain"

export interface JsonToken {
  text: string
  kind: JsonTokenKind
}

/** 能解析就美化；坏 JSON 原样返回（预览不白屏，只失去高亮语义）。 */
export function prettyJsonForPreview(content: string): { text: string; parsed: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(content), null, 2), parsed: true }
  } catch {
    return { text: content, parsed: false }
  }
}

/**
 * JSON 词法切分：字符串（区分 key/value）、数字、true/false、null、标点。
 * 字符串后面跟 `:` 的视为 key（用 lookahead，冒号本身留给标点 token）。
 */
export function tokenizeJson(text: string): JsonToken[] {
  const re = /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b|[{}\[\],:]/g
  const tokens: JsonToken[] = []
  let last = 0
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0
    if (start > last) tokens.push({ text: text.slice(last, start), kind: "plain" })
    const raw = match[0]
    let kind: JsonTokenKind
    if (raw.startsWith('"')) kind = /^\s*:/.test(text.slice(start + raw.length)) ? "key" : "string"
    else if (raw === "true" || raw === "false") kind = "boolean"
    else if (raw === "null") kind = "null"
    else if (/^[{}[\],:]$/.test(raw)) kind = "punct"
    else kind = "number"
    tokens.push({ text: raw, kind })
    last = start + raw.length
  }
  if (last < text.length) tokens.push({ text: text.slice(last), kind: "plain" })
  return tokens
}
