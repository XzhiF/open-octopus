// packages/web-app/components/tasks/acceptance/ac-matrix-panel.tsx
//
// 验货台「核对」tab (acceptance v2) — spec 票清单 × round-report 声称 × diff 实物
// 路径的三方对账。全部计算在 lib/acceptance-matrix.ts（纯函数，单测覆盖），本
// 组件只渲染。行语义：
//   anchored   ✅ 报告说了、diff 里真有 —— 有实物对应
//   unanchored ⚠ 报告提了文件但 diff 没有 —— 说了没做/路径存疑
//   no-claim   ⬜ spec 有此票但报告只字未提 —— 最该被追问的一行
// footer「N/M 票有实物锚」= 这一轮的可信度速览。零 AI，判定可复核。

"use client"

import { useMemo } from "react"
import { CircleDashed, Link2, ListChecks } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import type { RoundDiffPayload } from "@/lib/tasks-api"
import {
  buildAcMatrix,
  flattenDiffFiles,
  parseReportTickets,
  parseSpecTickets,
  type MatrixRow,
} from "@/lib/acceptance-matrix"

interface AcMatrixPanelProps {
  /** 本 phase spec.md 全文（null = 尚未拉到/不存在）。 */
  specMd: string | null
  specLoading: boolean
  /** round-report.md 全文（与叙述 tab 的内嵌块同一份 state）。 */
  reportMd: string | null
  diff: RoundDiffPayload | null
}

export function AcMatrixPanel({ specMd, specLoading, reportMd, diff }: AcMatrixPanelProps) {
  const matrix = useMemo(() => {
    if (!specMd && !reportMd) return null
    const spec = specMd ? parseSpecTickets(specMd) : { ticketIds: [], userStories: [], inScope: [] }
    const report = reportMd ? parseReportTickets(reportMd) : []
    const files = diff ? flattenDiffFiles(diff.repos.filter((r) => !r.expired)) : []
    return buildAcMatrix(spec, report, files)
  }, [specMd, reportMd, diff])

  if (specLoading && !matrix) {
    return (
      <div className="flex items-center gap-2 p-6 text-xs text-muted-foreground">
        <Spinner className="size-3.5" /> 读取契约结构…
      </div>
    )
  }
  if (!matrix) {
    return <p className="p-4 text-[11px] text-muted-foreground">spec/报告未就绪 — 无法对账。</p>
  }
  if (matrix.degraded) {
    return (
      <div className="m-3 rounded-[13px] border-2 border-dashed border-pop-bd/40 p-4 text-[11px] text-muted-foreground space-y-1" data-testid="ac-matrix-degraded">
        <div className="font-mono text-[10px] font-black text-pop-dim">无契约结构</div>
        <p>本轮 spec.md 没有可解析的「Ticket DAG」表、round-report 也没有「票执行摘要」表 —— 三方对账缺一角，降级为逐文件人肉核对（叙述 tab）。</p>
        {matrix.userStories.length > 0 && (
          <ul className="pt-1 list-disc pl-4">
            {matrix.userStories.map((u, i) => <li key={i} className="truncate">{u}</li>)}
          </ul>
        )}
      </div>
    )
  }

  const diffUnavailable = !diff || (!diff.available)
  return (
    <div className="space-y-3">
      <div className="rounded-[13px] border-2 border-pop-bd bg-pop-paper shadow-pop-sm overflow-hidden" data-testid="ac-matrix">
        <div className="flex items-center gap-2 border-b-2 border-pop-bd/10 px-3 py-2">
          <ListChecks className="size-3.5 text-pop-dim" />
          <span className="font-mono text-[9.5px] font-black tracking-[.09em] text-pop-dim">票 × 声称 × 实物 对账</span>
          <span className="ml-auto font-mono text-[10px] font-black tabular-nums">
            <span className={matrix.anchoredCount === matrix.total ? "text-pop-green" : "text-pop-amber"}>
              {matrix.anchoredCount}/{matrix.total}
            </span>
            <span className="text-pop-dim"> 票有实物锚</span>
          </span>
        </div>
        {diffUnavailable && (
          <div className="border-b border-pop-bd/10 bg-pop-amber-soft px-3 py-1.5 text-[10px]" data-testid="ac-matrix-diff-missing">
            实物 diff 不可得 —— 锚定列冻结为「存疑」，此时声称无从对账，慎放行。
          </div>
        )}
        <table className="w-full text-left text-[11px]">
          <thead>
            <tr className="border-b border-pop-bd/10 font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">
              <th className="px-3 py-1.5">票</th>
              <th className="py-1.5 pr-2">声称</th>
              <th className="py-1.5 pr-2">实物锚</th>
              <th className="py-1.5 pr-3 text-right">判定</th>
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => <MatrixRowView key={row.ticket} row={row} diffUnavailable={diffUnavailable} />)}
          </tbody>
        </table>
      </div>
      {matrix.userStories.length > 0 && (
        <div className="rounded-[13px] border-2 border-pop-bd/30 px-3 py-2 text-[10.5px] text-muted-foreground space-y-0.5" data-testid="ac-matrix-us">
          <div className="font-mono text-[9px] font-black tracking-[.08em] text-pop-dim">USER STORIES（{matrix.userStories.length}）· 锚到票即可，逐条读去叙述 tab 的 spec.md</div>
          {matrix.userStories.map((u, i) => (
            <div key={i} className="truncate" title={u}>{u}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function MatrixRowView({ row, diffUnavailable }: { row: MatrixRow; diffUnavailable: boolean }) {
  const verdict = diffUnavailable
    ? { label: "存疑", cls: "text-pop-amber", Icon: CircleDashed }
    : row.status === "anchored"
      ? { label: "有实物", cls: "text-pop-green", Icon: Link2 }
      : row.status === "unanchored"
        ? { label: row.claimed == null ? "未上报" : "说了没锚", cls: "text-pop-amber", Icon: CircleDashed }
        : { label: "无实物对应", cls: "text-pop-red", Icon: CircleDashed }
  const claimedLabel = row.claimed === "pass" ? "✅" : row.claimed === "warn" ? "⚠️" : row.claimed === "other" ? "❔" : "—"
  return (
    <tr className="border-b border-pop-bd/5 last:border-0" data-acceptance-matrix-row={row.ticket}>
      <td className="px-3 py-1.5 align-top">
        <span className="grid size-[18px] place-items-center rounded-[8px] border-2 border-pop-bd font-mono text-[9.5px] font-black">{row.ticket}</span>
      </td>
      <td className="py-1.5 pr-2 align-top">
        <div className="max-w-[220px]">
          <span className="text-[12px]">{claimedLabel}</span>
          <span className="ml-1 block truncate text-[10.5px] text-muted-foreground" title={row.title}>{row.title || "（报告无此行）"}</span>
        </div>
      </td>
      <td className="py-1.5 pr-2 align-top">
        {row.matchedPaths.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {row.matchedPaths.slice(0, 3).map((p) => (
              <span key={p} className="max-w-[180px] truncate rounded-full border-[1.5px] border-pop-bd/30 bg-pop-green-soft px-1.5 py-px font-mono text-[9px] text-pop-green" title={p}>
                {p.split("/").slice(-2).join("/")}
              </span>
            ))}
            {row.matchedPaths.length > 3 && <span className="font-mono text-[9px] text-pop-dim">+{row.matchedPaths.length - 3}</span>}
          </div>
        ) : (
          <span className="font-mono text-[9.5px] text-pop-dim">{row.anchoredTokens.length === 0 && row.unanchoredTokens.length === 0 ? "—" : row.unanchoredTokens.map((t) => t.split("/").pop()).join(", ")}</span>
        )}
      </td>
      <td className={`py-1.5 pr-3 text-right align-top font-mono text-[10px] font-black ${verdict.cls}`}>
        <span className="inline-flex items-center gap-1"><verdict.Icon className="size-3" />{verdict.label}</span>
      </td>
    </tr>
  )
}
