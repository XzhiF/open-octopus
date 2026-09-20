// packages/server/src/services/tasks/playbook-compile.ts
//
// 验收面 v2.1「验收剧本」编译器 — PURE, no fs, no AI (ADR-0022 / spec S2). The
// RoundEvidenceService reads the awaiting round's batch-dir files and hands the
// strings here; this turns 「这一轮该验什么、预期是什么」 into a票级 walk/probe/
// claim checklist a human can execute in ≤8 steps.
//
// Contract sources (all fixed markdown produced by task-author / matt-spec-dev):
//   • e2e-test-plan.md   — `## 测试步骤` / `### Step N: 名 (spec-…)` with
//                          `- 页面/操作/断言/反假跑` bullets  → walk items
//   • last NN-e2e-*.md   — TWO dialects are accepted:
//                          ① 正典 author-verified-tickets 模板: `## Acceptance
//                             Criteria` (→ finePrint), `**Verification type**`,
//                             fenced ```bash 块 (→ probe), `**Pass criteria**`
//                          ② 实票方言（在盘真任务实测形状,2026-09-19）: `Type:` /
//                             `走查模式：browser 走查` 行 + `## 走查步骤（…）` 编号
//                             列表（行内反引号命令 + `→` 后断言）+ `## 证据要求`
//                             （→ pass criteria）。编号步带可辨命令 → probe，
//                             browser 票 → walk；正典缺失时以此兜底。
//   • round-report.md    — `## 票执行摘要` (goal line) + `## Spec 修订` (⚠ flag)
//   • spec.md            — `## Acceptance Criteria` fallback ACs when no e2e
//                          ticket OR the ticket parsed to zero steps (兜底不再被
//                          「有票但读不懂」掐死——六单实机回归)
//   • acceptance-checks-r{N-1}.json — prior round skip/fail → carryover (top)
//
// Honesty rules (mirror acceptance-matrix degradation discipline): every missing
// source is recorded in coverage.missing, never guessed; empty inputs →
// available:false with a populated missing list, HTTP still 200 (the panel shows
// the 「无契约结构」 state, not a crash). Ids are deterministic (source-derived +
// seq) so a checkbox written this round resolves next round.

import type {
  ChecksFile, PlaybookPayload, PlaybookSection, PlaybookItem, PlaybookCarryover,
} from "./playbook-types"

export type { PlaybookPayload, PlaybookSection, PlaybookItem, PlaybookBudget, PlaybookCarryover } from "./playbook-types"

// ── checks-on-disk codec (acceptance-checks-r{N}.md) ──────────────────
// Stored as MARKDOWN (````json` fenced) so it rides the existing .md-only
// home-file write door (no security-surface change) and stays human-readable
// /editable in the batch file view（「叙述」tab 已退役 2026-09-20）. The panel
// writes via PUT /:id/home-file.

export const checksFileName = (roundIndex: number): string => `acceptance-checks-r${roundIndex}.md`

export function renderChecksMd(data: ChecksFile): string {
  return [
    `# 走查勾选 · Round ${data.round_index ?? "?"}`,
    "",
    "> 机器读写:验收台勾选 → 本文件;ledger 聚合、下轮 carryover 都吃它。JSON 体可手改。",
    "",
    "```json",
    JSON.stringify(data, null, 2),
    "```",
    "",
  ].join("\n")
}

/** Extract + validate the fenced ChecksFile; null on any miss/corruption. */
export function parseChecksMd(md: string): ChecksFile | null {
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(md)
  if (!m) return null
  try {
    const o = JSON.parse(m[1]) as ChecksFile
    if (!o || typeof o !== "object" || typeof o.checks !== "object" || o.checks === null) return null
    return o
  } catch {
    return null
  }
}

/** ticket base name a playbook item id was derived from (walk:<base>:n etc). */
export function ticketBaseFromItemId(id: string): string | null {
  const m = /^(?:walk|probe|claim):([^:]+):\d+$/.exec(id)
  return m && m[1] !== "plan" && m[1] !== "spec" ? m[1] : null
}

/** Max checkable steps the panel renders before the compiler degrades (D1/D4).
 *  Beyond this a human stops reading the report and stops ticking boxes — the
 *  whole point is a walkthrough you actually do. */
export const PLAYBOOK_STEP_BUDGET = 8

export interface PlaybookInputs {
  specMd?: string | null
  e2eTicket?: { name: string; content: string } | null
  e2eTestPlan?: string | null
  roundReport?: string | null
  /** prior round's checks (home-relative file already read + parsed by caller). */
  prevChecks?: { round: number; data: ChecksFile } | null
  /** this round index (for carryover labeling). */
  roundIndex: number
  /** 本任务配了 runbook（三级任一命中）→ 起服/就绪/收尾类探针折为 lifecycle
   *  提示（生命周期归「跑起来看」，剧本只留断言）；缺省 false 全步可跑。 */
  hasRunbook?: boolean
}

// ── line-level markdown helpers (tolerant; \r\n normalised) ───────────

function lines(md: string): string[] {
  return md.replace(/\r\n/g, "\n").split("\n")
}
function headingIdx(ls: string[], re: RegExp, from = 0): number {
  for (let i = from; i < ls.length; i++) if (/^#{1,6}\s/.test(ls[i]) && re.test(ls[i])) return i
  return -1
}
/** body of a `## …re…` section up to the next heading (or EOF). */
function sectionBody(md: string, re: RegExp): string | null {
  const ls = lines(md)
  const h = headingIdx(ls, re)
  if (h < 0) return null
  const out: string[] = []
  for (let i = h + 1; i < ls.length; i++) {
    if (/^#{1,6}\s/.test(ls[i])) break
    out.push(ls[i])
  }
  return out.join("\n").trim() || null
}
/** `- 键: 值` bullets in a block → map (first wins). */
function keyBullets(block: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const l of lines(block)) {
    const m = /^\s*[-*]\s*([^:：]+?)\s*[:：]\s*(.*)$/.exec(l)
    if (m && m[1] && m[2] && !(m[1] in map)) map[m[1].trim()] = m[2].trim()
  }
  return map
}
/** AC/checkbox list items (`- [x] AC1: …` or `- …`). */
function listItems(block: string): string[] {
  return lines(block)
    .map((l) => /^\s*[-*]\s*(?:\[[ xX]\]\s*)?(.*)$/.exec(l)?.[1]?.trim() ?? "")
    .filter(Boolean)
}

/** 人读步标题截断（列表项可能整段带命令,面板一屏原则）。 */
function clip(s: string, max = 80): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > max ? t.slice(0, max - 1) + "…" : t
}

/** LAST fenced block whose info-line matches fenceRe (```bash …). Returns its
 *  inner non-comment lines. No matching fence → []. */
function fencedCommands(md: string, fenceRe: RegExp): string[] {
  const ls = lines(md)
  let lastStart = -1
  for (let i = 0; i < ls.length; i++) {
    const open = /^```(.*)$/.exec(ls[i])
    if (open && fenceRe.test(open[1] ?? "")) lastStart = i
  }
  if (lastStart < 0) return []
  let end = ls.length
  for (let i = lastStart + 1; i < ls.length; i++) if (/^```/.test(ls[i])) { end = i; break }
  return ls
    .slice(lastStart + 1, end)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"))
}

// ── 实票方言（2026-09-19 六单/token 任务在盘形状）─────────────────────
// 行首命令词白名单：inline 反引号必须"像命令"才转 probe——防把
// `e2e-report.md`、`IdCheckUtils.class` 这类产物名误判成可执行步。
const CMD_START_RE =
  /^\s*(cd|curl|wget|java|mvn|mvnw|gradle|pnpm|npm|npx|node|python3?|pytest|sqlite3|bash|sh|docker|make|go|cargo|until|while|for|if|kill|pkill|ps|lsof|grep|jq|awk|wc|open)\b/

/** 生命周期命令分类（③ 管道步过滤）。仅当 task 配了 runbook 时用于把「起服/
 *  就绪轮询/收尾」折成一行提示——它们的活儿由「跑起来看」按钮统一做，剧本不该
 *  再让人逐条点。判据保守：只认明确的起/杀/就绪姿势，普通 curl/test/mvn 断言
 *  不沾（那些是真·验收点，要留执行钮）。ready 探活的 `curl health` 归 start 段
 *  引导后就不重复——故裸 curl 一律不判 lifecycle。 */
function lifecycleOf(cmd: string): PlaybookItem["lifecycle"] | undefined {
  const c = cmd.trim().toLowerCase()
  // 后台起进程/起容器 = start（nohup、& 结尾、java -jar、docker run/up/compose up）。
  if (/(^|[;&|]\s*)(nohup\b|java\s+-jar|python[3]?\s+-m|docker\s+(run|start|compose\s+up)|(pnpm|npm|yarn)\s+(run\s+)?(dev|start)|\b.*&\s*$)/.test(c)
    && !/\bcurl\b/.test(c)) return "start"
  // 就绪轮询（until/while ... curl ... do sleep / ; sleep ... done）。
  if (/^(until|while)\b/.test(c) || /\bdone\b/.test(c) && /sleep/.test(c)) return "ready"
  // 收尾杀进程（kill/pkill + 进程名，或含端口拒连确认）。
  if (/^(sudo\s+)?(kill|pkill|killall)\b/.test(c) || /(kill|pkill)\s+.*(java|node|server|jar|\.pid)/.test(c)) return "teardown"
  return undefined
}

/** 文本里第一条"像命令"的 inline 反引号；无 → null。 */
function inlineCmd(text: string): string | null {
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const c = (m[1] ?? "").trim()
    if (c && c.length <= 160 && CMD_START_RE.test(c)) return c
  }
  return null
}

interface TicketStep { op: string; expect: string; cmd: string | null }

/** 实票步解析：`## 走查步骤/验证步骤/测试步骤` 标题 或 `**Verification steps**:`
 *  粗体行 之后、下一个标题/粗体字段之前的编号·列表项。每项 = 一步；`→`/`=>`/`->`
 *  之后的文字 = 预期；inline 反引号命令 = probe 命令。 */
function ticketSteps(content: string): TicketStep[] {
  const ls = lines(content)
  let start = -1
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i] ?? ""
    if (/^#{1,6}\s/.test(l) && /走查步骤|验证步骤|测试步骤|walkthrough\s*steps|verification\s*steps/i.test(l)) { start = i; break }
    if (/^\s*\*\*\s*Verification\s+steps\s*\*\*\s*[:：]/i.test(l)) { start = i; break }
  }
  if (start < 0) return []
  const out: TicketStep[] = []
  for (let i = start + 1; i < ls.length && out.length < 8; i++) {
    const l = ls[i] ?? ""
    if (/^#{1,6}\s/.test(l) || /^\s*\*\*[^*]/.test(l)) break // 下一节/下一字段
    const m = /^\s*(?:\d+[.)]|[-*])\s+(.*)$/.exec(l)
    if (!m) continue
    let text = (m[1] ?? "").trim()
    // 续行并入（缩进散文行属于本步）
    for (let j = i + 1; j < ls.length; j++) {
      const c = (ls[j] ?? "").trim()
      if (!c || /^#{1,6}\s/.test(c) || /^\s*\*\*[^*]/.test(c) || /^\s*(?:\d+[.)]|[-*])\s+/.test(c)) break
      text += " " + c
      i = j
    }
    const arrowRe = /\s*(?:→|=>|->)\s*/g
    let last: RegExpExecArray | null = null
    let am: RegExpExecArray | null
    while ((am = arrowRe.exec(text))) last = am
    const op = (last ? text.slice(0, last.index) : text).trim()
    const expect = (last ? text.slice(last.index + last[0].length) : "").trim()
    const cmd = inlineCmd(text)
    if (op || cmd) out.push({ op: op || (cmd ?? ""), expect, cmd })
  }
  return out
}

// ── per-source extractors ────────────────────────────────────────────

function walkFromTestPlan(plan: string, base: string): PlaybookItem[] {
  const body = sectionBody(plan, /测试步骤|test\s*steps|walkthrough/i) ?? plan
  const ls = lines(body)
  const items: PlaybookItem[] = []
  let i = 0
  let seq = 0
  for (; i < ls.length; i++) {
    const h = /^#{2,4}\s*Step\s*(\d+)\s*[:：]?\s*(.*)$/i.exec(ls[i])
    if (!h) continue
    const title = (h[2] || `Step ${h[1]}`).replace(/\s*\(.*?\)\s*$/, "").trim()
    // gather bullets until next Step/heading
    const block: string[] = []
    for (let j = i + 1; j < ls.length && !/^#{2,4}\s/.test(ls[j]); j++) block.push(ls[j])
    const k = keyBullets(block.join("\n"))
    const op = [k["页面"] && `打开 ${k["页面"]}`, k["操作"]].filter(Boolean).join(" → ") || title
    const expect = k["断言"] || k["预期"] || k["预期结果"] || ""
    if (!expect && !op) continue
    items.push({
      id: `walk:${base}:${++seq}`,
      op: op || title,
      expect: expect || "见步骤说明",
      evidence: k["反假跑"] || k["真通过条件"] || undefined,
    })
  }
  return items
}

interface TicketDigest {
  acs: string[]
  type: "browser" | "api" | "unit" | "unknown"
  probeCmds: string[]
  passCriteria: string
  build: string
  /** 实票方言的编号步（正典票通常为空——无 `## 走查步骤` 标题）。 */
  steps: TicketStep[]
}
function digestTicket(content: string): TicketDigest {
  const acBody = sectionBody(content, /Acceptance\s*Criteria|验收标准/i) ?? ""
  const acs = listItems(acBody)
  const vm = sectionBody(content, /Verification\s*Method|验证方式/i) ?? content
  // type 三行词表并集：正典 `**Verification type**:` ∪ 实票 `Type:` 头 ∪ `走查模式：`
  // ——05 票的 Type 行只有裸 `e2e`、browser 实证在「走查模式」行，单选一源会误类。
  const typeRaw = [
    /\*\*\s*Verification type\s*\*\*\s*[:：]\s*(.+)/i.exec(vm)?.[1],
    /^\s*Type\s*[:：]\s*(.+)$/im.exec(content)?.[1],
    /走查模式\s*[:：]\s*(.+)/.exec(content)?.[1],
  ].filter(Boolean).join(" · ").toLowerCase()
  const steps = ticketSteps(content)
  // 分类序：browser 要实证（截图/Playwright/浏览器字样）——裸 `e2e` 不算 browser
  // （实盘 `Type: e2e` + 纯 curl 票是 API 级走查，归 browser 会丢命令 chip）。
  const type: TicketDigest["type"] = /browser|playwright|截图|screenshot|\bui\b/.test(typeRaw) ? "browser"
    : /api|curl|sqlite|contract|http|cli/.test(typeRaw) ? "api"
      : /unit|jest|vitest|pytest/.test(typeRaw) ? "unit"
        : steps.some((s) => s.cmd) ? "api" : "unknown"
  let probeCmds = fencedCommands(vm, /bash|sh|shell|console/i)
  if (!probeCmds.length) probeCmds = steps.filter((s) => s.cmd).map((s) => s.cmd as string)
  const passCriteria =
    /\*\*\s*Pass criteria\s*\*\*\s*[:：]\s*(.+)/i.exec(vm)?.[1]?.trim()
    ?? /^\s*Pass criteria\s*[:：]\s*(.+)/im.exec(content)?.[1]?.trim()
    ?? clip(sectionBody(content, /证据要求|放行标准/) ?? "", 120)
  const build = sectionBody(content, /What to build|要做什么|目标|目的/i) ?? ""
  return { acs, type, probeCmds, passCriteria, build, steps }
}

/** strip a `## Status\n...done` region detection for reopen is done elsewhere. */

// ── the compiler ─────────────────────────────────────────────────────

export function compilePlaybook(inp: PlaybookInputs): PlaybookPayload {
  const found: string[] = []
  const missing: string[] = []
  const sections: PlaybookSection[] = []
  const finePrint: PlaybookPayload["finePrint"] = []

  // goal: round-report 票执行摘要 first sentence, else first spec `#` line.
  let goal = ""

  // ── e2e ticket (the ONE browser ticket per phase) ──
  let ticketStepCount = 0
  if (inp.e2eTicket?.content) {
    found.push(`issues/${inp.e2eTicket.name}`)
    const base = inp.e2eTicket.name.replace(/\.md$/i, "")
    const d = digestTicket(inp.e2eTicket.content)
    if (d.acs.length) finePrint.push({ ticket: base, acs: d.acs })
    const items: PlaybookItem[] = []
    if (d.steps.length) {
      // 实票方言：编号步即人工走查脚本——browser → walk（动作+预期），
      // 其余 → 带命令的 probe（行首命令词白名单已滤掉产物名假命令）。
      if (d.type === "browser") {
        d.steps.forEach((s, n) => items.push({
          id: `walk:${base}:${n + 1}`,
          op: clip(s.op.replace(/`/g, "")),
          expect: s.expect || d.passCriteria || "见票内预期/证据要求",
          evidence: s.expect ? undefined : d.passCriteria || undefined,
        }))
      } else {
        d.steps.filter((s) => s.cmd).forEach((s, n) => {
          const life = inp.hasRunbook ? lifecycleOf(s.cmd as string) : undefined
          items.push({
            id: `probe:${base}:${n + 1}`,
            op: `执行 \`${s.cmd}\``,
            expect: s.expect || d.passCriteria || "命令 exit 0 且输出符合预期",
            probe: { command: s.cmd as string },
            // ③ 管道步过滤：配了 runbook，起服/就绪/收尾类命令折给「跑起来看」——
            // 面板渲染成一行灰提示、不给执行钮、不进连跑。无 runbook 时保留可跑。
            ...(life ? { lifecycle: life } : {}),
          })
        })
      }
    } else {
      // 正典模板路径（行为与 2026-09-18 前一致）。
      if (d.type === "browser" && d.build) {
        items.push({ id: `walk:${base}:0`, op: `照「${d.build.split("\n")[0]?.slice(0, 60) ?? base}」走一遍关键 UI 路径`, expect: d.passCriteria || "所有 AC 通过", evidence: d.passCriteria || undefined })
      }
      d.probeCmds.slice(0, 3).forEach((cmd, n) => {
        const life = inp.hasRunbook ? lifecycleOf(cmd) : undefined
        items.push({
          id: `probe:${base}:${n + 1}`, op: `执行 \`${cmd}\``,
          expect: d.passCriteria || "命令 exit 0 且输出符合预期", probe: { command: cmd },
          ...(life ? { lifecycle: life } : {}),
        })
      })
      if (!items.length && d.acs.length) {
        items.push({ id: `claim:${base}:0`, op: `逐条核对 ${base} 的 AC`, expect: d.acs[0] ?? "", evidence: d.passCriteria || undefined })
      }
    }
    ticketStepCount = items.length
    if (!items.length) missing.push(`issues/${inp.e2eTicket.name} 无可解析步骤`)
    if (items.length) sections.push({ kind: d.type === "api" ? "probe" : d.type === "browser" ? "walk" : "claim", title: base, source: `issues/${inp.e2eTicket.name}`, items })
  } else {
    missing.push("末张 NN-e2e-*.md")
  }

  // ── e2e-test-plan.md (story walkthrough) ──
  if (inp.e2eTestPlan) {
    found.push("e2e-test-plan.md")
    const items = walkFromTestPlan(inp.e2eTestPlan, "plan")
    if (items.length) sections.unshift({ kind: "walk", title: "E2E 测试计划", source: "e2e-test-plan.md", items })
  } else {
    missing.push("e2e-test-plan.md")
  }

  // ── round-report.md (goal + spec-revision flag) ──
  let specRevised = false
  if (inp.roundReport) {
    found.push("round-report.md")
    const sum = sectionBody(inp.roundReport, /票执行摘要|执行摘要/)
    if (sum) goal = listItems(sum)[0] ?? lines(sum).find((l) => l.trim() && !l.startsWith("|"))?.replace(/^[#>\s-]+/, "") ?? ""
    specRevised = /##\s*Spec\s*修订/i.test(inp.roundReport)
  } else {
    missing.push("round-report.md")
  }

  // ── spec.md (goal fallback + AC claim/finePrint when no e2e ticket) ──
  if (inp.specMd) {
    found.push("spec.md")
    if (!goal) goal = /^#\s+(.+)/m.exec(inp.specMd)?.[1]?.trim() ?? ""
    // 「无票」或「有票但两副词表都编不出步」都退 spec AC——六单实证:票存在却
    // 读不懂时旧逻辑把兜底掐死,整面板空在「无剧本」上。
    if (!inp.e2eTicket?.content || !ticketStepCount) {
      const acs = listItems(sectionBody(inp.specMd, /Acceptance\s*Criteria|验收标准|^##\s*AC\b/im) ?? "")
      if (acs.length) {
        finePrint.push({ ticket: "spec", acs })
        // No e2e ticket → the spec ACs are themselves the checkable steps.
        sections.push({
          kind: "claim", title: "spec 验收标准", source: "spec.md",
          items: acs.slice(0, PLAYBOOK_STEP_BUDGET).map((ac, n) => ({
            id: `claim:spec:${n + 1}`, op: `核对:${ac.slice(0, 80)}`, expect: ac,
          })),
        })
      }
    }
  } else {
    missing.push("spec.md")
  }

  // ── prev-round checks: ✓销账 / ✗⊘移入 carryover (D3) ──────────────
  const carryover: PlaybookCarryover[] = []
  if (inp.prevChecks?.data) {
    const flat = sections.flatMap((s) => s.items)
    for (const [id, c] of Object.entries(inp.prevChecks.data.checks ?? {})) {
      const src = flat.find((it) => it.id === id)
      if (c.decision === "pass") continue // ✓ 销账: drop from sections, no carryover
      carryover.push({
        id: `co:${id}@r${inp.prevChecks.round}`,
        fromRound: inp.prevChecks.round,
        decision: c.decision === "fail" ? "failed" : "skipped",
        note: c.note || undefined,
        op: src?.op ?? `上轮项 ${id}`,
        expect: src?.expect ?? "(本轮来源已变,请对照上轮台账)",
      })
    }
    // remove every resolved item (pass OR skip/fail — the latter resurfaces
    // via carryover) so a step appears exactly once per playbook.
    const resolvedIds = new Set(
      Object.entries(inp.prevChecks.data.checks ?? {}).map(([id]) => id),
    )
    for (const s of sections) s.items = s.items.filter((it) => !resolvedIds.has(it.id))
    if (carryover.length) {
      sections.unshift({
        kind: "claim",
        title: `上轮未结(carryover · R${inp.prevChecks.round})`,
        source: `acceptance-checks-r${inp.prevChecks.round}.json`,
        items: carryover.map((co) => ({
          id: co.id, op: co.op, expect: co.expect,
          evidence: `${co.decision === "failed" ? "上轮✗" : "上轮⊘"}${co.note ? ` · ${co.note}` : ""} — 补验 或 再豁免(需新原因)`,
        })),
      })
    }
  }
  // drop sections emptied by pruning
  for (let i = sections.length - 1; i >= 0; i--) if (sections[i].items.length === 0) sections.splice(i, 1)

  // ── budget / degrade (D4): merge ticket→1 item when over budget ──
  let stepCount = sections.reduce((n, s) => n + s.items.length, 0)
  let degraded = false
  if (stepCount > PLAYBOOK_STEP_BUDGET) {
    degraded = true
    for (const s of sections) {
      if (s.items.length > 1) {
        const kept = s.items[0]
        s.items = [{ ...kept, op: `${kept.op} （合并本票 ${s.items.length} 步,细目见折叠)` }]
      }
    }
    stepCount = sections.reduce((n, s) => n + s.items.length, 0)
  }

  return {
    available: sections.length > 0,
    goal: goal || (specRevised ? "(见 round-report;⚠ 含 Spec 修订)" : ""),
    specRevised,
    budget: { steps: stepCount, estMin: Math.max(1, Math.ceil(stepCount * 1.3)), over: stepCount > PLAYBOOK_STEP_BUDGET, degraded },
    sections,
    finePrint,
    carryover,
    coverage: { found, missing },
  }
}
