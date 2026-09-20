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

/** 互斥列识别（走查回灌 2026-09-16）：真实 round-report 表头是
 *  `| 票 | 状态 | 判据结果 |` —— 无标题列时旧逻辑把状态列吞成标题、
 *  备注落空，锚定全军覆没。这里按 票→状态→判据/备注→标题 的优先级
 *  互斥指派，任一列被抢走就换下一候选。 */
function assignColumns(rows: string[][]): { ti: number; tt: number; st: number; rm: number } {
  const header = rows[0] ?? []
  const has = (re: RegExp) => (exclude: number[]) =>
    header.findIndex((h, i) => !exclude.includes(i) && re.test(h))
  const ti = has(/^票|ID|编号/)([-1])
  const tiSafe = ti >= 0 ? ti : 0
  const st0 = has(/状态|Status|state/)([tiSafe])
  const st = st0 >= 0 ? st0 : has(/结果|Result|Outcome/)([tiSafe])
  const rm = has(/备注|说明|实物|判据|Notes?|Remark/)([tiSafe, st])
  // 标题列优先命中；没有就把剩下唯一的数据列当标题（而不是当备注）。
  const tt = has(/标题|Title/)([tiSafe, st, rm])
  return { ti: tiSafe, tt, st, rm }
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

/** round-report 的「票执行摘要」表：票|标题|状态|备注（列互斥识别，见 assignColumns）。 */
export function parseReportTickets(reportMd: string): ReportTicket[] {
  const rows = parsePipeTableAfter(reportMd, /票执行摘要|执行摘要|Ticket.*(执行|Summary)/i)
  if (!rows) return []
  const { ti, tt, st, rm } = assignColumns(rows)
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "") : "")
  return rows.slice(1)
    .map((r) => {
      const ticket = cell(r, ti).replace(/[*`]/g, "").trim()
      const statusCell = cell(r, st)
      return {
        ticket,
        title: cell(r, tt).trim(),
        claimed: /✅|done|完成|pass/i.test(statusCell) ? "pass"
          : /⚠|❌|🟡|🔴|partial|部分|fail/i.test(statusCell) ? "warn"
            : "other",
        remark: cell(r, rm).trim(),
      } as ReportTicket
    })
    .filter((r) => r.ticket.length > 0)
}

/** 「Changed Files」全局段（git diff --stat 块）里的路径 token。
 *  真实报告的票级备注往往不写路径，实物清单集中在这一节 ——
 *  核对 tab 用它做「报告 vs 实物」全局对账（缺节 → []，调用方视为无全局数据）。 */
export function parseReportChangedFiles(reportMd: string): string[] {
  const lines = reportMd.split(/\r?\n/)
  let i = 0
  for (; i < lines.length; i++) {
    const l = lines[i]!
    if (/^#{1,6}\s/.test(l) && /Changed Files|变更文件|实物清单|改动文件/i.test(l)) break
  }
  if (i >= lines.length) return []
  let j = i + 1
  for (; j < lines.length; j++) {
    if (/^#{1,6}\s/.test(lines[j]!)) break
  }
  return extractPathTokens(lines.slice(i + 1, j).join("\n"))
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
  const CODE_EXT = "ts|tsx|js|jsx|mjs|cjs|py|md|mdx|json|ya?ml|yml|toml|sql|sh|bash|css|scss|go|rs|java|kt|swift|rb|php|c|cc|cpp|h|hpp|vue|svelte|txt|csv|env|lock|proto|graphql|db|sqlite|log"
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
  /** 备注原文（判定列）——锚定证据可复核。 */
  remark: string
  /** 备注里命中的文件 token。 */
  anchoredTokens: string[]
  /** 备注未锚定的文件 token（可疑：说了但没改）。 */
  unanchoredTokens: string[]
  /** 备注裸文件名锚（词干 = diff 文件名词干；走查回灌新增）。 */
  anchoredStems: string[]
  /** diff 里被锚定的真实路径。 */
  matchedPaths: string[]
  status: "anchored" | "unanchored" | "no-claim" | "silent"
}

/** 报告 Changed Files 段 vs diff 实物的全局对账（走查回灌新增）。 */
export interface GlobalReconcile {
  claimedFiles: string[]
  /** 报了但 diff 里没有（说了没做，文件级）。 */
  phantom: string[]
  /** diff 里有但报告没报（做了没说，文件级）。 */
  unreported: string[]
  aligned: boolean
}

export interface AcMatrix {
  rows: MatrixRow[]
  anchoredCount: number
  total: number
  /** 两侧都没票 = 契约结构缺失（UI 降级卡）。 */
  degraded: boolean
  userStories: string[]
  /** 报告无 Changed Files 段 = null（不硬造全局判定）。 */
  global: GlobalReconcile | null
}

/** 三方对账主入口。diffPaths 传 round-diff 展平后的 (path, oldPath) 全集；
 *  changedFiles = parseReportChangedFiles(reportMd)（缺省/空 = 无全局数据 → global null）。 */
export function buildAcMatrix(
  spec: SpecTickets,
  report: ReportTicket[],
  diffPaths: Iterable<{ path: string; oldPath?: string }>,
  changedFiles?: string[],
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
    // 裸文件名锚：备注词集 × diff 文件名词干（票号 slug 不参与，防同批互撞；
    // 短干 <6 字符不参与，交给全局块）。
    const anchoredStems: string[] = []
    const words = wordSet(rep?.remark ?? "")
    for (const p of paths) {
      if (matchedPaths.includes(p.path)) continue
      const stem = stemOf(p.path)
      if (stem.length >= 6 && words.has(stem.toLowerCase())) {
        anchoredStems.push(stem)
        matchedPaths.push(p.path)
      }
    }
    const status: MatrixRow["status"] = !rep
      ? "no-claim"
      : anchoredTokens.length + anchoredStems.length > 0
        ? "anchored"
        : tokens.length > 0
          ? "unanchored"
          : "silent"
    return {
      ticket,
      title: rep?.title ?? "",
      claimed: rep?.claimed ?? null,
      remark: rep?.remark ?? "",
      anchoredTokens,
      unanchoredTokens,
      anchoredStems: [...new Set(anchoredStems)],
      matchedPaths: [...new Set(matchedPaths)],
      status,
    }
  })
  const anchoredCount = rows.filter((r) => r.status === "anchored").length

  let global: GlobalReconcile | null = null
  if (changedFiles && changedFiles.length > 0) {
    const phantom: string[] = []
    const covered = new Set<string>()
    for (const tok of changedFiles) {
      const hits = paths.filter((p) => pathHit(tok, p.path) || (p.oldPath != null && pathHit(tok, p.oldPath)))
      if (hits.length === 0) phantom.push(tok)
      for (const h of hits) covered.add(h.path)
    }
    const unreported = paths.map((p) => p.path).filter((p) => !covered.has(p))
    global = { claimedFiles: changedFiles, phantom, unreported, aligned: phantom.length === 0 && unreported.length === 0 }
  }

  return {
    rows,
    anchoredCount,
    total: rows.length,
    degraded: rows.length === 0,
    userStories: spec.userStories,
    global,
  }
}

/** 备注词集（小写）：token 同时保留原样与去尾缀扩展名两形。 */
function wordSet(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9_.-]+/g) ?? []).flatMap((w) => [w, w.replace(/\.[a-z]+$/, "")]))
}

/** diff 文件名词干（去扩展名）。 */
function stemOf(p: string): string {
  const base = p.split("/").pop() ?? ""
  return base.replace(/\.[^.]+$/, "")
}

/** round-diff repos → 展平 diff 文件（含 rename 的 oldPath）。 */
export function flattenDiffFiles(repos: Array<{ groups: Array<{ files: DiffFile[] }> }>): DiffFile[] {
  return repos.flatMap((r) => r.groups.flatMap((g) => g.files))
}

// ── 打回→修复 回应对账（B 档 2026-09-20）────────────────────────────────
// task-fix 流（ADR-0018 轻量修复路由）必产 fix-report-rN.md（N=被打回轮），
// 其「反馈条目表」是 SKILL 规定的三列契约：反馈 → 修复动作 → 验证证据。
// 本节把第三列的路径 token 锚到修复轮的 diff 实物 —— 「幻影回应」（写了没改）
// 在这里现形。零 AI、纯解析；无表/列缺 → 空数组，UI 走诚实降级（与票对账同纪律）。

export interface FixResponseRow {
  feedback: string
  action: string
  evidence: string
  anchoredTokens: string[]
  /** 证据里写了路径但本轮 diff 没有 —— 幻影回应。 */
  unanchoredTokens: string[]
  matchedPaths: string[]
  /** anchored=证据路径对上了实物; unanchored=说了没锚; silent=只有文字证据。 */
  status: "anchored" | "unanchored" | "silent"
}

/** 证据文本 token × diff 实物路径 → 锚定三分（buildAcMatrix 同规则的独立出口）。 */
export function anchorEvidenceTokens(
  tokens: string[],
  paths: Iterable<{ path: string; oldPath?: string }>,
): { anchoredTokens: string[]; unanchoredTokens: string[]; matchedPaths: string[] } {
  const arr = [...paths]
  const anchoredTokens: string[] = []
  const unanchoredTokens: string[] = []
  const matchedPaths: string[] = []
  for (const tok of tokens) {
    const hit = arr.find((p) => pathHit(tok, p.path) || (p.oldPath != null && pathHit(tok, p.oldPath)))
    if (hit) {
      anchoredTokens.push(tok)
      matchedPaths.push(hit.path)
    } else {
      unanchoredTokens.push(tok)
    }
  }
  return { anchoredTokens, unanchoredTokens, matchedPaths: [...new Set(matchedPaths)] }
}

/** fix-report-rN.md → 反馈条目三列表（**含表头行**；列位由表头定，对账见 buildFixResponse）。 */
export function parseFixResponseTable(fixReportMd: string): string[][] {
  const rows = parsePipeTableAfter(fixReportMd, /反馈条目|反馈.*(表|清单)|Feedback.*(Table|Items)/i)
    ?? firstFeedbackLikeTable(fixReportMd)
  if (!rows) return []
  return rows.filter((r) => (r[0] ?? "").trim().length > 0)
}

/** 兜底：全文扫第一张「表头含 反馈/修复/证据 字样」的 ≥3 列表（agent 没按节名写时的宽容路径）。 */
function firstFeedbackLikeTable(md: string): string[][] | null {
  const lines = md.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim()
    if (!l.startsWith("|")) continue
    const header = l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
    if (header.length < 3) continue
    const joined = header.join(" ")
    if (!/反馈|修复|证据|Feedback|Fix|Evidence/i.test(joined)) continue
    const rows: string[][] = [header]
    for (let j = i + 1; j < lines.length; j++) {
      const r = lines[j]!.trim()
      if (!r.startsWith("|")) break
      const cells = r.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
      if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue
      rows.push(cells)
    }
    if (rows.length > 1) return rows
  }
  return null
}

/** 回应对账主入口：三列表逐行 × 修复轮 diff 实物。diffPaths 缺省 = 无实物可对
 *  （全判 silent，调用方按「存疑」渲染，绝不假装通过）。 */
export function buildFixResponse(
  fixReportMd: string,
  diffPaths?: Iterable<{ path: string; oldPath?: string }>,
): FixResponseRow[] {
  const table = parseFixResponseTable(fixReportMd)
  if (table.length === 0) return []
  const header = table[0] ?? []
  const used = new Set<number>()
  const colOf = (re: RegExp, fallback: number) => {
    const i = header.findIndex((h, idx) => !used.has(idx) && re.test(h))
    if (i >= 0) { used.add(i); return i }
    if (!used.has(fallback) && fallback < header.length) { used.add(fallback); return fallback }
    return -1
  }
  const fi = colOf(/反馈|意见|Feedback/i, 0)
  const ai = colOf(/修复|动作|改动|Fix|Action/i, 1)
  const ei = colOf(/证据|验证|结果|Evidence|Test/i, 2)
  return table.slice(1).map((cells) => {
    const pick = (i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "")
    const feedback = pick(fi)
    const action = pick(ai)
    const evidence = pick(ei)
    if (diffPaths == null) {
      return { feedback, action, evidence, anchoredTokens: [], unanchoredTokens: [], matchedPaths: [], status: "silent" } as FixResponseRow
    }
    const { anchoredTokens, unanchoredTokens, matchedPaths } = anchorEvidenceTokens(extractPathTokens(evidence), diffPaths)
    return {
      feedback,
      action,
      evidence,
      anchoredTokens,
      unanchoredTokens,
      matchedPaths,
      status: anchoredTokens.length > 0 ? "anchored" : unanchoredTokens.length > 0 ? "unanchored" : "silent",
    } as FixResponseRow
  }).filter((r) => r.feedback.length > 0)
}
