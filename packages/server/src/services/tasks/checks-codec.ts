// packages/server/src/services/tasks/checks-codec.ts
//
// 验收勾选文件编解码（acceptance-checks-r{N}.md）。
//
// 2026-10-31 起验收清单只来自「验收方案」（acceptance-plan-rN.json）；
// 旧的契约文件编译器（compilePlaybook）已删除，本文件只保留盘上格式：
//
//   · checks 文件是验收台勾选 / 机器探针盖章的持久化真相；
//   · ledger 聚合、下轮 carryover、打回重开票都读它；
//   · 仍存为 MARKDOWN（```json 围栏）以复用 .md-only 的 home-file 写门。
//
// Stored as MARKDOWN so it rides the existing .md-only home-file write door
// (no security-surface change) and stays human-readable / editable in the
// batch file view.

import type { ChecksFile } from "./playbook-types"

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

/** ticket base name a legacy playbook item id was derived from
 *  (walk:<base>:n / probe:<base>:n / claim:<base>:n).
 *  历史 checks 文件里仍可能有这些 id；方案项（case:n）的票在 item.tickets。 */
export function ticketBaseFromItemId(id: string): string | null {
  const m = /^(?:walk|probe|claim):([^:]+):\d+$/.exec(id)
  return m && m[1] !== "plan" && m[1] !== "spec" ? m[1] : null
}
