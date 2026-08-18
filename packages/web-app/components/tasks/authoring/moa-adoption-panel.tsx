// packages/web-app/components/tasks/authoring/moa-adoption-panel.tsx
//
// The v3 MoA adoption panel (ticket 10, US11/AC5/AC6/D10/SW-BP3). Renders the
// three-stage structured output from an assist-workflow run (ac candidates /
// suggestions / risks) and lets the user checkbox-adopt ac candidates into
// spec-field(ac) + suggestions into spec-field(decisions). Risks are read-only
// (they inform, not bind). Interaction reference: prototype VariantL adoption
// panel (app/tasks/prototype/page.tsx:3232) — code rewritten, not copied.
//
// AC5: [采纳勾选项] → merged spec-field(ac) + spec-field(decisions); the
// right-side ac list then shows the adopted items (source mark handled by
// GoalAcCard re-rendering from the SSE-applied ac). `decisions` is the adoption
// target for MoA suggestions (SW-BP3 — the field had a schema home but no
// settable route until the shared validator gained the branch).
// AC6: when the run carries `output_parse_error`, the OutputViewer renders a
// degraded card (output_raw) INSTEAD of this panel — so this panel only mounts
// with a well-formed `output`.

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
  /** Fired after a successful adoption (parent re-fetches task / updates UI). */
  onAdopted: (adopted: { ac: string[]; decisions: string[] }) => void
}

export function MoaAdoptionPanel({
  taskId,
  output,
  existingAc,
  existingDecisions,
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
      // AC5: merge selected candidates into the EXISTING ac list (dedup, keep
      // order — adopted items appended after the current set so the agent's
      // own ac isn't reordered).
      const selectedAc = output.ac_candidates.filter((_, i) => acChecked[i])
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
      toast.success(`已采纳 ${selectedAc.length} 条 ac + ${selectedSug.length} 条方案建议`)
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
            ac 已合并进右侧目标卡；方案建议进入决策备忘。
          </span>
        </div>
      ) : (
        <>
          {output.ac_candidates.length > 0 && (
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
