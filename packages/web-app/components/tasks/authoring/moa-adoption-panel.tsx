// packages/web-app/components/tasks/authoring/moa-adoption-panel.tsx
//
// MoA 采纳面板（原票 10 US11/AC5/AC6/D10/SW-BP3）。渲染辅助执行的三段结构化
// 输出（ac candidates / suggestions / risks）。v4-only UI 改版后：
//   • suggestions → spec-field(decisions) —— 保留（决策备忘录在 v4 活着）。
//   • ac 候选采纳段 **v4 隐藏**（goal/ac 是 v3 面，v4 起草不写；`v4` prop 由
//     OutputViewer 按 task_spec.format 传入）。v3/legacy 行为不变。
// AC6: run 带 output_parse_error 时 OutputViewer 渲染降级卡替代本面板。

"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Check, AlertTriangle, Lightbulb } from "lucide-react"
import { toast } from "sonner"
import { updateSpecField } from "@/lib/tasks-api"

export interface MoaAdoptionOutput {
  ac_candidates: string[]
  suggestions: string[]
  risks: string[]
}

export interface MoaAdoptionPanelProps {
  taskId: string
  output: MoaAdoptionOutput
  /** Current ac items (to merge adopted candidates into — dedup). */
  existingAc: string[]
  /** Current decisions memos (to merge adopted suggestions into — dedup). */
  existingDecisions: string[]
  /** v4 任务：ac 采纳段不渲染、adopt 不写 spec-field(ac)（goal/ac 已退役）。 */
  v4?: boolean
  /** Fired after a successful adoption (parent re-fetches task / updates UI). */
  onAdopted: (adopted: { ac: string[]; decisions: string[] }) => void
}

export function MoaAdoptionPanel({
  taskId,
  output,
  existingAc,
  existingDecisions,
  v4,
  onAdopted,
}: MoaAdoptionPanelProps) {
  const [acChecked, setAcChecked] = useState<boolean[]>(() => output.ac_candidates.map(() => true))
  const [sugChecked, setSugChecked] = useState<boolean[]>(() => output.suggestions.map(() => false))
  const [busy, setBusy] = useState(false)
  const [adopted, setAdopted] = useState<{ ac: string[]; decisions: string[] } | null>(null)

  const toggleAc = (i: number) =>
    setAcChecked((arr) => arr.map((v, j) => (j === i ? !v : v)))
  const toggleSug = (i: number) =>
    setSugChecked((arr) => arr.map((v, j) => (j === i ? !v : v)))

  const adopt = async () => {
    if (busy) return
    setBusy(true)
    try {
      // AC5 (v3 only): merge selected candidates into the EXISTING ac list
      // (dedup, keep order). v4: goal/ac 不再是 UI 面 — 跳过 ac 写入。
      const selectedAc = v4 ? [] : output.ac_candidates.filter((_, i) => acChecked[i])
      const nextAc = [...existingAc]
      for (const c of selectedAc) {
        if (!nextAc.includes(c)) nextAc.push(c)
      }
      // SW-BP3: suggestions → spec-field(decisions). Same dedup/append pattern.
      const selectedSug = output.suggestions.filter((_, i) => sugChecked[i])
      const nextDecisions = [...existingDecisions]
      for (const s of selectedSug) {
        if (!nextDecisions.includes(s)) nextDecisions.push(s)
      }

      if (selectedAc.length > 0) {
        await updateSpecField(taskId, "ac", nextAc, { source: "user" })
      }
      if (selectedSug.length > 0) {
        await updateSpecField(taskId, "decisions", nextDecisions, { source: "user" })
      }

      setAdopted({ ac: selectedAc, decisions: selectedSug })
      onAdopted({ ac: selectedAc, decisions: selectedSug })
      toast.success(v4
        ? `已采纳 ${selectedSug.length} 条方案建议（决策备忘）`
        : `已采纳 ${selectedAc.length} 条 ac + ${selectedSug.length} 条方案建议`)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "采纳失败")
    } finally {
      setBusy(false)
    }
  }

  const hasAny = output.ac_candidates.length > 0 || output.suggestions.length > 0 || output.risks.length > 0
  if (!hasAny) return null

  return (
    <div
      className="mt-2 rounded-md bg-background border p-2.5 text-[11px] space-y-2.5"
      data-moa-adoption-panel
    >
      {adopted ? (
        <div className="text-emerald-600" data-moa-adopted>
          ✅ 已采纳 {adopted.ac.length} 条 ac + {adopted.decisions.length} 条方案建议
          <span className="block text-muted-foreground mt-0.5">
            方案建议进入决策备忘{!v4 && "；ac 已合并进右侧目标卡"}。
          </span>
        </div>
      ) : (
        <>
          {!v4 && output.ac_candidates.length > 0 && (
            <div>
              <div className="font-medium mb-1 flex items-center gap-1">
                <Check className="size-3 text-emerald-600" /> ac 候选（勾选采纳）
              </div>
              {output.ac_candidates.map((c, i) => (
                <label key={i} className="flex items-start gap-2 py-0.5 cursor-pointer">
                  <Checkbox
                    className="mt-0.5"
                    checked={acChecked[i] ?? false}
                    onCheckedChange={() => toggleAc(i)}
                    data-moa-ac-checkbox={i}
                  />
                  <span>{c}</span>
                </label>
              ))}
            </div>
          )}

          {output.suggestions.length > 0 && (
            <div>
              <div className="font-medium mb-1 flex items-center gap-1">
                <Lightbulb className="size-3 text-amber-500" /> 方案建议（勾选 → 决策备忘）
              </div>
              {output.suggestions.map((s, i) => (
                <label key={i} className="flex items-start gap-2 py-0.5 cursor-pointer">
                  <Checkbox
                    className="mt-0.5"
                    checked={sugChecked[i] ?? false}
                    onCheckedChange={() => toggleSug(i)}
                    data-moa-suggestion-checkbox={i}
                  />
                  <span>{s}</span>
                </label>
              ))}
            </div>
          )}

          {output.risks.length > 0 && (
            <div>
              <div className="font-medium mb-1 flex items-center gap-1">
                <AlertTriangle className="size-3 text-red-500" /> 风险（仅告知）
              </div>
              <ul className="text-muted-foreground space-y-0.5 list-disc pl-4">
                {output.risks.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}

          <Button
            size="sm"
            className="h-6 text-[10px] w-full"
            onClick={adopt}
            disabled={busy}
            data-moa-adopt-button
          >
            {busy ? "采纳中…" : "采纳勾选项"}
          </Button>
        </>
      )}
    </div>
  )
}
