// packages/web-app/lib/acceptance-matrix.ts
//
// 验货台「核对」tab 的纯函数层 — spec 票清单 × round-report 声称 × diff 实物路径
// 的三方对账（acceptance v2, 2026-09-16）。零 AI、零网络：报告与 spec 都是
// task-author/matt-spec-dev SKILL 的固定 markdown 约定（「票执行摘要」/
// 「Ticket DAG」表格），解析即契约。锚定判据 = 报告备注里的文件路径 token 与
// git diff 真实变更路径的 path-boundary 后缀互含（含 rename 的 oldPath）。
//
// 降级纪律：任一输入缺失/形状不对 → 该层为空数组，矩阵退化为「无契约结构」，
// 绝不猜测、绝不报错白屏。

import type { DiffFile } from "@/lib/tasks-api"

// ── 表格原语 ─────────────────────────────────────────────────────────────

/** 找 `## …<keyword>…` 标题后的第一张 pipe 表 → 行×列（跳过 ---| 分隔行）。
 *  找不到标题/表 → null（调用方走空态）。 */
export function parsePipeTableAfter(md: string, headingKeyword: RegExp): string[][] | null {
  const lines = md.split(/\r?\n/)
  let i = 0
  for (; i < lines.length; i++) {
    const l = lines[i]!
    if (/^#{1,6}\s/.test(l) && headingKeyword.test(l)) break
  }
  if (i >= lines.length) return null
  // 标题后找表头行（允许中间隔空行/引用行）
  let j = i + 1
  for (; j < lines.length; j++) {
    const l = lines[j]!
    if (l.trim().startsWith("|")) break
    if (/^#{1,6}\s/.test(l)) return null // 撞上下一个标题 — 本节无表
  }
  if (j >= lines.length) return null
  const rows: string[][] = []
  for (; j < lines.length; j++) {
    const l = lines[j]!.trim()
    if (!l.startsWith("|")) break
    const cells = l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue // 分隔行
    rows.push(cells)
  }
  return rows.length > 1 ? rows : null // 只有表头 = 无数据
}

function columnBy(rows: string[][], keywords: RegExp, fallback: number): number {
  const header = rows[0] ?? []
  const hit = header.findIndex((h) => keywords.test(h))
  return hit >= 0 ? hit : fallback
}

// ── 两侧契约 ─────────────────────────────────────────────────────────────

export interface ReportTicket {
  ticket: string
  title: string
  claimed: "pass" | "warn" | "other"
  remark: string
}

export interface SpecTickets {
  /** Ticket DAG 表首列（票号）。 */
  ticketIds: string[]
  /** User Stories 列表行（US*），无表可解析时 []。 */
  userStories: string[]
  /** In Scope 列表行。 */
  inScope: string[]
}

/** round-report 的「票执行摘要」表：票|标题|状态|备注（列按表头关键字定位）。 */
export function parseReportTickets(reportMd: string): ReportTicket[] {
  const rows = parsePipeTableAfter(reportMd, /票执行摘要|执行摘要|Ticket.*(执行|Summary)/i)
  if (!rows) return []
  const ti = columnBy(rows, /^票|ID|编号/, 0)
  const tt = columnBy(rows, /标题|Title/, 1)
  const st = columnBy(rows, /状态|结果|Status/, 2)
  const rm = columnBy(rows, /备注|说明|实物|Notes?|Remark/, 3)
  return rows.slice(1)
    .map((r) => {
      const ticket = (r[ti] ?? "").replace(/[*`]/g, "").trim()
      const statusCell = r[st] ?? ""
      return {
        ticket,
        title: (r[tt] ?? "").trim(),
        claimed: /✅|done|完成|pass/i.test(statusCell) ? "pass"
          : /⚠|❌|🟡|🔴|partial|部分|fail/i.test(statusCell) ? "warn"
            : "other",
        remark: (r[rm] ?? "").trim(),
      } as ReportTicket
    })
    .filter((r) => r.ticket.length > 0)
}

/** spec.md 的票契约：Ticket DAG 表（或任何名字含 ticket 的表）首列 + US/In Scope 列表。 */
export function parseSpecTickets(specMd: string): SpecTickets {
  const rows = parsePipeTableAfter(specMd, /Ticket\s*DAG|票列表|Tickets/i)
  const ticketIds = rows
    ? rows.slice(1).map((r) => (r[0] ?? "").replace(/[*`]/g, "").trim()).filter(Boolean)
    : []
  return {
    ticketIds,
    userStories: bulletLinesUnder(specMd, /User\s*Stories|用户故事/i),
    inScope: bulletLinesUnder(specMd, /In\s*Scope|范围内|范围/i),
  }
}

/** `## <keyword>` 与下一个 `##` 之间的列表行（- / * / 数字.）。 */
function bulletLinesUnder(md: string, headingKeyword: RegExp): string[] {
  const lines = md.split(/\r?\n/)
  const out: string[] = []
  let inside = false
  for (const l of lines) {
    if (/^#{1,6}\s/.test(l)) {
      if (inside) break
      inside = headingKeyword.test(l)
      continue
    }
    if (inside) {
      const m = l.match(/^\s*(?:[-*]\s+|\d+\.\s+)(.+)$/)
      if (m) out.push(m[1]!.trim())
    }
  }
  return out
}

// ── 路径 token 与锚定 ────────────────────────────────────────────────────

/** 文本里的文件路径样 token。两条分支：
 *  ① 多段路径 `(dir/)…dir/file.ext` —— 目录段不含 `.`，扩展名只可能在末段，
 *     因此 URL(`//x.io/pull/1`)里的 `.io` 不会被误当成末段扩展名吞进来；
 *  ② 裸文件名 `file.<已知代码扩展名>`（带否定前瞻，不吃 URL 域名段）。 */
export function extractPathTokens(text: string): string[] {
  const CODE_EXT = "ts|tsx|js|jsx|mjs|cjs|py|md|mdx|json|ya?ml|yml|toml|sql|sh|bash|css|scss|go|rs|java|kt|swift|rb|php|c|cc|cpp|h|hpp|vue|svelte|txt|csv|env|lock|proto|graphql"
  const re = new RegExp(
    `(?:[\\w@~+\\-]+\\/)+[\\w@~+\\-]+\\.\\w{1,12}|[\\w@~+\\-]+\\.(?:${CODE_EXT})(?![\\w./-])`,
    "g",
  )
  const out = new Set<string>()
  for (const m of text.match(re) ?? []) {
    out.add(m.replace(/^\.\//, "").replace(/`/g, ""))
  }
  return [...out]
}

/** path-boundary 后缀互含：token "commands/workflow.ts" 命中
 *  diff path "packages/cli/src/commands/workflow.ts"（反之亦然）。 */
function pathHit(token: string, diffPath: string): boolean {
  if (token === diffPath) return true
  const t = token.replace(/^\//, "")
  const p = diffPath.replace(/^\//, "")
  return p.endsWith("/" + t) || t.endsWith("/" + p)
}

export interface MatrixRow {
  ticket: string
  title: string
  /** 报告声称状态；null = 报告没有这张票的行。 */
  claimed: ReportTicket["claimed"] | null
  /** 备注里命中的文件 token。 */
  anchoredTokens: string[]
  /** 备注未锚定的文件 token（可疑：说了但没改）。 */
  unanchoredTokens: string[]
  /** diff 里被锚定的真实路径。 */
  matchedPaths: string[]
  status: "anchored" | "unanchored" | "no-claim"
}

export interface AcMatrix {
  rows: MatrixRow[]
  anchoredCount: number
  total: number
  /** 两侧都没票 = 契约结构缺失（UI 降级卡）。 */
  degraded: boolean
  userStories: string[]
}

/** 三方对账主入口。diffPaths 传 round-diff 展平后的 (path, oldPath) 全集。 */
export function buildAcMatrix(
  spec: SpecTickets,
  report: ReportTicket[],
  diffPaths: Iterable<{ path: string; oldPath?: string }>,
): AcMatrix {
  const paths = [...diffPaths]
  const byTicket = new Map<string, ReportTicket>()
  for (const r of report) byTicket.set(r.ticket, r)

  const tickets = [...new Set([...spec.ticketIds, ...report.map((r) => r.ticket)])]
  const rows: MatrixRow[] = tickets.map((ticket) => {
    const rep = byTicket.get(ticket)
    const tokens = extractPathTokens(`${rep?.remark ?? ""}`)
    const anchoredTokens: string[] = []
    const unanchoredTokens: string[] = []
    const matchedPaths: string[] = []
    for (const tok of tokens) {
      const hit = paths.find((p) => pathHit(tok, p.path) || (p.oldPath != null && pathHit(tok, p.oldPath)))
      if (hit) {
        anchoredTokens.push(tok)
        matchedPaths.push(hit.path)
      } else {
        unanchoredTokens.push(tok)
      }
    }
    const status: MatrixRow["status"] = !rep ? "no-claim" : anchoredTokens.length > 0 ? "anchored" : "unanchored"
    return {
      ticket,
      title: rep?.title ?? "",
      claimed: rep?.claimed ?? null,
      anchoredTokens,
      unanchoredTokens,
      matchedPaths: [...new Set(matchedPaths)],
      status,
    }
  })
  const anchoredCount = rows.filter((r) => r.status === "anchored").length
  return {
    rows,
    anchoredCount,
    total: rows.length,
    degraded: rows.length === 0,
    userStories: spec.userStories,
  }
}

/** round-diff repos → 展平 diff 文件（含 rename 的 oldPath）。 */
export function flattenDiffFiles(repos: Array<{ groups: Array<{ files: DiffFile[] }> }>): DiffFile[] {
  return repos.flatMap((r) => r.groups.flatMap((g) => g.files))
}
