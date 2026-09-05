// packages/web-app/components/tasks/authoring/phase-spec-dialog.tsx
//
// PhaseSpecDialog（契约修复改版）：per-phase spec.md 的审阅 + 编辑面。走
// GET/PUT /api/tasks/:id/home-file（白名单 `.scratch/**.md`，服务端守卫）。
//
// 三态：
//   • 404（文件缺失，UI 增行后的常态）→ 空态 +「创建骨架」→ PUT 模板内容
//     （Key Decisions 表头对齐 SKILL K8 行稳定纪律 —— | # | Decision |
//      Conclusion | Reason |），落盘后进入编辑态。
//   • 200 → textarea 编辑 + 保存（PUT 幂等覆写；文件不参与 tasks.version
//     乐观锁，写后 server 落 @@spec_updated notice 让 agent 下轮重读）。
//   • specPath 不合规（绝对路径 / 非 .scratch/*.md —— agent 旁路直写的产物）
//     → 只读展示路径 + 说明（编辑器不开 GET 请求，避免必然的 403 噪声）。
//
// 编辑窗口与 spec 编辑同一谓词（isSpecEditable：v4 全程至归档前），409 由
// server 把关 → toast 呈现。

"use client"

import { useEffect, useState } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FileWarning } from "lucide-react"
import { toast } from "sonner"
import type { Task, TaskPhase } from "@octopus/shared"
import { getHomeFile, putHomeFile, TaskApiError } from "@/lib/tasks-api"

/** specPath 是否能被 home-file UI 端点服务：home 相对、`.scratch/` 前缀、
 *  `.md` 后缀（与 server 守卫同规；最终权威仍在 server）。 */
export function isUiEditableSpecPath(specPath: string): boolean {
  if (!specPath || specPath.includes("\0")) return false
  if (specPath.startsWith("/") || specPath.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(specPath)) {
    return false
  }
  const norm = specPath.replace(/\\/g, "/").replace(/^\.\//, "")
  if (norm.split("/").includes("..")) return false // 逃逸预判（server resolve+relative 是最终权威）
  return norm.startsWith(".scratch/") && norm.toLowerCase().endsWith(".md")
}

/** 骨架模板 —— 章节对齐 task-author SKILL 的 Batch 产物规范（K8 表头逐字，
 *  行稳定纪律吃这个锚点）。 */
export function specSkeleton(phase: TaskPhase): string {
  return `# Phase ${phase.index}: ${phase.name}

> 看板创建的骨架 —— 请在对话里让 task-author 澄清补全，或直接手改本文件
> （用户手改会触发 @@spec_updated，agent 下轮重读，不会拿旧稿覆盖你）。

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|----------|------------|--------|

## User Stories

- US1:

## 验收方式

- [ ]

## issues/

（票清单由 matt-verified-tickets 产出至本目录 issues/NN-*.md，恒含末张 E2E 票）
`
}

export interface PhaseSpecDialogProps {
  task: Task
  phase: TaskPhase
  open: boolean
  onOpenChange: (open: boolean) => void
}

type State =
  | { kind: "loading" }
  | { kind: "missing" }          // 404 → 创建骨架空态
  | { kind: "loaded"; content: string }
  | { kind: "unsupported" }      // specPath 出白名单（客户端预判，不发请求）
  | { kind: "error"; message: string }

export function PhaseSpecDialog({ task, phase, open, onOpenChange }: PhaseSpecDialogProps) {
  const editable = isUiEditableSpecPath(phase.specPath)
  const [state, setState] = useState<State>({ kind: "loading" })
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (!editable) {
      setState({ kind: "unsupported" })
      return
    }
    let cancelled = false
    setState({ kind: "loading" })
    setDraft(null)
    getHomeFile(task.id, phase.specPath)
      .then((r) => { if (!cancelled) setState({ kind: "loaded", content: r.content }) })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof TaskApiError && err.status === 404) {
          setState({ kind: "missing" })
        } else if (err instanceof TaskApiError && err.status === 403) {
          setState({ kind: "unsupported" })
        } else {
          setState({ kind: "error", message: err instanceof Error ? err.message : String(err) })
        }
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fetch on open/phase
  }, [open, phase.specPath, task.id, editable])

  const current = draft ?? (state.kind === "loaded" ? state.content : "")
  const dirty = draft !== null && state.kind === "loaded" && draft !== state.content

  const save = async (content: string, label: string) => {
    setSaving(true)
    try {
      await putHomeFile(task.id, phase.specPath, content)
      setState({ kind: "loaded", content })
      setDraft(null)
      toast.success(label)
    } catch (err: unknown) {
      toast.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-base">
            Phase {phase.index} spec · {phase.name}
          </DialogTitle>
          <DialogDescription className="text-xs font-mono">
            {phase.specPath}
          </DialogDescription>
        </DialogHeader>

        {state.kind === "loading" && (
          <div className="flex items-center justify-center py-16">
            <Spinner className="size-5" />
          </div>
        )}

        {state.kind === "unsupported" && (
          <div className="rounded-md border bg-muted/30 px-3 py-4 text-xs text-muted-foreground flex items-start gap-2" data-spec-unsupported>
            <FileWarning className="size-4 shrink-0 mt-0.5" />
            <span>
              此 specPath 不在看板编辑白名单（task home 的 <code>.scratch/**.md</code>）内 ——
              通常是 agent 绝对路径直写的产物。内容请通过文件路径查看，修改请在对话里进行。
            </span>
          </div>
        )}

        {state.kind === "error" && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-3 text-xs text-red-600" data-spec-error>
            读取失败：{state.message}
          </div>
        )}

        {state.kind === "missing" && (
          <div className="py-10 text-center space-y-3" data-spec-empty>
            <p className="text-xs text-muted-foreground">
              该 phase 还没有 spec.md（入队门禁会要求它存在）。
            </p>
            <Button
              size="sm"
              onClick={() => void save(specSkeleton(phase), "骨架已创建")}
              disabled={saving}
              data-spec-skeleton-button
            >
              {saving ? <Spinner className="size-3 mr-1" /> : null}
              创建骨架
            </Button>
          </div>
        )}

        {(state.kind === "loaded" || (state.kind === "missing" && draft !== null)) && (
          <>
            <textarea
              className="flex-1 min-h-[360px] w-full rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-relaxed resize-none"
              value={current}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              data-spec-editor
              aria-label={`Phase ${phase.index} spec 内容`}
            />
            <div className="flex items-center justify-end gap-2 pt-1">
              <span className="mr-auto text-[10px] text-muted-foreground">
                保存后 agent 下轮会收到 @@spec_updated；spec.md 冻结纪律见 SKILL（修订走 spec-rN 并存）
              </span>
              {dirty && draft !== null && (
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setDraft(null)} disabled={saving}>
                  放弃修改
                </Button>
              )}
              <Button
                size="sm" className="h-7 text-xs"
                disabled={!dirty || saving}
                onClick={() => draft !== null && void save(draft, "spec.md 已保存")}
                data-spec-save-button
              >
                {saving ? <Spinner className="size-3 mr-1" /> : null}
                {saving ? "保存中…" : "保存"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
