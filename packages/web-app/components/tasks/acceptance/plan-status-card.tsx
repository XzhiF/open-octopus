"use client"

// 验收方案状态卡（2026-10-31）：旧编译清单删除后，第三步「拍个板」在没有
// ready 方案时只挂这一张卡。纪律：
//   · 不编造清单；生成中 / 失败 / 无方案如实说明；
//   · 没有场景清单时不设硬闸 —— 通过 / 退回仍可用（用户 2026-10-31 拍板）；
//   · 归档只读回看：无方案时不给「重新生成」，以台账为准。

import { useState } from "react"
import { toast } from "sonner"
import { regenerateAcceptancePlan, type PlanStatus } from "@/lib/tasks-api"

interface PlanStatusCardProps {
  taskId: string
  roundIndex: number
  status: PlanStatus
  error?: string
  readOnly: boolean
  /** 重新生成已发起 → 父级重拉 playbook（SSE 之外的手动兜底）。 */
  onRegenerated: () => void
}

const BADGE: Record<"generating" | "failed" | "missing", string> = {
  generating: "生成中",
  failed: "生成失败",
  missing: "无方案",
}

export function PlanStatusCard({
  taskId, roundIndex, status: rawStatus, error, readOnly, onRegenerated,
}: PlanStatusCardProps) {
  const [busy, setBusy] = useState(false)
  // ready 但清单为空（理论态）按 missing 处理 —— 不显示一个空面板。
  const status = rawStatus === "ready" ? "missing" : rawStatus

  const regenerate = async () => {
    if (!taskId || busy) return
    setBusy(true)
    try {
      const r = await regenerateAcceptancePlan(taskId)
      if (!r.ok) {
        toast.error(`重生成被拒：${r.reason ?? "未知原因"}`)
        return
      }
      toast.success("已重新发起方案生成")
      onRegenerated()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "重生成失败")
    } finally {
      setBusy(false)
    }
  }

  const title = readOnly
    ? "本轮没有可回看的验收方案"
    : status === "generating"
      ? "验收方案生成中"
      : status === "failed"
        ? "验收方案生成失败"
        : "本轮没有验收方案"

  const body = readOnly
    ? `归档时未生成方案；历史轮不再编译旧清单。验收结论以台账 acceptance-ledger-r${roundIndex}.md 为准。`
    : status === "generating"
      ? "规划 Agent 正在读取本轮证据，完成后这里会自动换成「场景 + 机器证据」。生成期间你仍可以直接通过或退回。"
      : status === "failed"
        ? `方案生成失败${error ? `（${error}）` : ""}，无法展示场景清单。你仍可以直接通过或退回。`
        : "规划 Agent 尚未产出方案（可能未启用）。你仍可以直接通过或退回 —— 本轮不设场景硬闸。"

  return (
    <div
      className="ap-card"
      data-testid="plan-status-card"
      data-plan-status={readOnly ? "archived" : status}
    >
      <div className="ap-card-head">
        <span className="ap-card-title">验收方案</span>
        <span className="ap-card-count">{readOnly ? "无方案" : BADGE[status]}</span>
      </div>
      <div className="ap-card-body">
        <p className="text-[11px] font-semibold leading-snug text-[var(--ap-ink-2)]">{title}</p>
        <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--ap-muted)]">{body}</p>
        {status === "failed" && !readOnly && (
          <button
            type="button"
            className="ap-block-link mt-2"
            data-testid="plan-regenerate"
            disabled={busy}
            onClick={() => void regenerate()}
          >
            {busy ? "↻ 已发起…" : "↻ 重新生成"}
          </button>
        )}
        {!readOnly && (
          <div className="ap-check-note mt-2">
            <span className="q">i</span>
            <span>没有场景清单时不设硬闸 —— 请以「看结果 / 试一试」和本轮证据自行判断。</span>
          </div>
        )}
      </div>
    </div>
  )
}
