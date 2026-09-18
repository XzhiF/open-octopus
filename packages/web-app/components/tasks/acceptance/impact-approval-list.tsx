// packages/web-app/components/tasks/acceptance/impact-approval-list.tsx
//
// D14 影响清单（task-phase-redesign 票 12 接缝）—— server 无 spec-r2 impact
// API → items 恒空，但「勾选 → updateSpecField(phases 整数组) 写回」的渲染与
// 提交链已就绪（票 07 AC5 语义：version bump + spec_field_update SSE）。
// 原住 acceptance-modal.tsx，验货台收编为控制台 tab 时搬入 acceptance/。

"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "sonner"
import type { TaskPhase } from "@octopus/shared"
import { updateSpecField } from "@/lib/tasks-api"

export interface PhaseImpactItem {
  /** 稳定 key（决策行号/编号，K8「Key Decisions 行 diff」产物）。 */
  key: string
  /** 受影响的后续 phase（1-based index）。 */
  phaseIndex: number
  /** spec 连带修订说明。 */
  change: string
  /** workflow 重估建议说明（人一眼可读）。 */
  workflowReassess?: string
  /** 批准后写入该 phase 的新 workflowRef（可选）。 */
  nextWorkflowRef?: string
}

export interface ImpactApprovalListProps {
  taskId: string
  /** 当前 phases（写回时整数组替换受影响项）。 */
  phases: TaskPhase[]
  /** server 影响分析产物 — 当前恒空（v4.1 接缝），渲染/写回逻辑就绪。 */
  items: PhaseImpactItem[]
  onDone: () => void
}

export function ImpactApprovalList({ taskId, phases, items, onDone }: ImpactApprovalListProps) {
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-2.5 space-y-1" data-impact-list-empty data-testid="impact-list-empty">
        <div className="text-[11px] font-semibold text-muted-foreground">决策影响清单</div>
        <p className="text-[10px] text-muted-foreground">
          暂无条目 — server 的 spec-r2 影响分析 API 未上线（D14，v4.1 接缝）。勾选 + 批准改写
          phases（workflow 重估连带）的渲染与写回逻辑已就绪：批准 = updateSpecField(phases 整数组)。
        </p>
      </div>
    )
  }

  const toggle = (key: string) => {
    setCheckedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleApprove = async () => {
    if (busy || checkedKeys.size === 0) return
    setBusy(true)
    try {
      // 批准 → 按勾选条目改写受影响 phase（workflow 重估建议落地为该行 nextWorkflowRef），
      // 整数组 spec-field 写回（票 07 AC5 语义：version bump + spec_field_update SSE）。
      const byPhase = new Map<number, PhaseImpactItem[]>()
      for (const it of items) {
        if (!checkedKeys.has(it.key)) continue
        byPhase.set(it.phaseIndex, [...(byPhase.get(it.phaseIndex) ?? []), it])
      }
      const nextPhases: TaskPhase[] = phases.map((p) => {
        const hits = byPhase.get(p.index)
        if (!hits) return p
        const ref = hits.map((h) => h.nextWorkflowRef).filter(Boolean).pop()
        return ref ? { ...p, workflowRef: ref as TaskPhase["workflowRef"] } : p
      })
      await updateSpecField(taskId, "phases", nextPhases, { source: "user" })
      toast.success(`影响清单已批准 — ${checkedKeys.size} 条修订写入 phases（spec-r2 传播）`)
      setCheckedKeys(new Set())
      onDone()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "影响清单批准失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-md border border-pop-purple/40 bg-pop-purple-soft p-2.5 space-y-2" data-impact-list>
      <div className="text-[11px] font-semibold text-muted-foreground">决策影响清单（批准即改写后续 phase）</div>
      <ul className="space-y-1.5">
        {items.map((it) => (
          <li key={it.key}>
            <label className="flex items-start gap-1.5 text-[11px] cursor-pointer" data-impact-item={it.key} data-testid={`impact-item-${it.key}`}>
              <input
                type="checkbox"
                checked={checkedKeys.has(it.key)}
                onChange={() => toggle(it.key)}
                className="mt-0.5"
              />
              <span>
                <b>Phase {it.phaseIndex}</b> · {it.change}
                {it.workflowReassess && <span className="block text-[10px] text-muted-foreground">workflow 重估：{it.workflowReassess}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button size="sm" className="h-6 text-[10px]" disabled={checkedKeys.size === 0 || busy} onClick={() => void handleApprove()} data-impact-approve data-testid="impact-approve">
          {busy ? <Spinner className="size-3 mr-1" /> : null}
          批准并改写（{checkedKeys.size}）
        </Button>
      </div>
    </div>
  )
}
