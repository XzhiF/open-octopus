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
//   • last NN-e2e-*.md   — `## Acceptance Criteria` (AC list → finePrint),
//                          `**Verification type**` (browser→walk / api→probe),
//                          `**Verification steps**` fenced bash block (→ probe),
//                          `**Pass criteria**` (→ evidence on the ticket claim)
//   • round-report.md    — `## 票执行摘要` (goal line) + `## Spec 修订` (⚠ flag)
//   • spec.md            — `## Acceptance Criteria` fallback ACs when no e2e ticket
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
}
function digestTicket(content: string): TicketDigest {
  const acBody = sectionBody(content, /Acceptance\s*Criteria|验收标准/i) ?? ""
  const acs = listItems(acBody)
  const vm = sectionBody(content, /Verification\s*Method|验证方式/i) ?? content
  const typeRaw = /\*\*\s*Verification type\s*\*\*\s*[:：]\s*(.+)/i.exec(vm)?.[1]?.toLowerCase() ?? ""
  const type: TicketDigest["type"] = /browser|playwright|ui|e2e/.test(typeRaw) ? "browser"
    : /api|curl|sqlite|contract|http/.test(typeRaw) ? "api"
      : /unit|jest|vitest|test/.test(typeRaw) ? "unit" : "unknown"
  const probeCmds = fencedCommands(vm, /bash|sh|shell|console/i)
  const passCriteria = /\*\*\s*Pass criteria\s*\*\*\s*[:：]\s*(.+)/i.exec(vm)?.[1]?.trim() ?? ""
  const build = sectionBody(content, /What to build|要做什么|目标/i) ?? ""
  return { acs, type, probeCmds, passCriteria, build }
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
  if (inp.e2eTicket?.content) {
    found.push(`issues/${inp.e2eTicket.name}`)
    const base = inp.e2eTicket.name.replace(/\.md$/i, "")
    const d = digestTicket(inp.e2eTicket.content)
    if (d.acs.length) finePrint.push({ ticket: base, acs: d.acs })
    const items: PlaybookItem[] = []
    // browser ticket → a walk item ("run the story"); api ticket → probes only
    if (d.type === "browser" && d.build) {
      items.push({ id: `walk:${base}:0`, op: `照「${d.build.split("\n")[0]?.slice(0, 60) ?? base}」走一遍关键 UI 路径`, expect: d.passCriteria || "所有 AC 通过", evidence: d.passCriteria || undefined })
    }
    d.probeCmds.slice(0, 3).forEach((cmd, n) =>
      items.push({ id: `probe:${base}:${n + 1}`, op: `执行 \`${cmd}\``, expect: d.passCriteria || "命令 exit 0 且输出符合预期", probe: { command: cmd } }),
    )
    if (!items.length && d.acs.length) {
      items.push({ id: `claim:${base}:0`, op: `逐条核对 ${base} 的 AC`, expect: d.acs[0] ?? "", evidence: d.passCriteria || undefined })
    }
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
    if (!inp.e2eTicket?.content) {
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
