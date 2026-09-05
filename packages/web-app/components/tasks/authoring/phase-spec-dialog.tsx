// packages/web-app/components/tasks/authoring/phase-spec-dialog.tsx
//
// PhaseSpecDialog（ADR-0018 改版）：per-phase 批次目录（Batch dir）的审阅 +
// 编辑面。走 GET/PUT /api/tasks/:id/home-file（白名单 `.scratch/**.md`，服务端
// 守卫）+ GET ?list=1 批次文件枚举 —— spec 家族（spec.md / spec-rN.md）、
// fix-feedback-rN / fix-report-rN / round-report / issues/ 全在这里可见可编辑。
//
// spec 权威（ADR-0018）：spec.md 是**唯一活文档** —— 入队前你（草稿侧）维护；
// 入队后执行侧在 workspace 就地审查更新，server collect 回流 home 成终态镜像。
// 这里对 home spec.md 的手改经下一轮 seed 进入 ws；若该轮执行侧也改，以回流为准。
//
// 三态（对当前选中文件）：
//   • 404（文件缺失，spec.md 在 UI 增行后的常态）→ 空态 +「创建骨架」→ PUT 模板
//     内容（Key Decisions 表头对齐 SKILL K8 行稳定纪律 —— | # | Decision |
//     Conclusion | Reason |），落盘后进入编辑态。
//   • 200 → textarea 编辑 + 保存（PUT 幂等覆写；文件不参与 tasks.version
//     乐观锁，写后 server 落 @@spec_updated notice 让 agent 下轮重读）。
//   • specPath 不合规（绝对路径 / 非 .scratch/*.md —— agent 旁路直写的产物）
//     → 只读展示路径 + 说明（编辑器不开 GET 请求，避免必然的 403 噪声）。
//
// 编辑窗口与 spec 编辑同一谓词（isSpecEditable：v4 全程至归档前），409 由
// server 把关 → toast 呈现。

"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FileWarning } from "lucide-react"
import { toast } from "sonner"
import type { Task, TaskPhase } from "@octopus/shared"
import { getHomeFile, putHomeFile, listHomeDir, TaskApiError, type HomeFileListingEntry } from "@/lib/tasks-api"

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

/** home 相对 posix 化（与 server listHomeDir 的 path 输出同格式）。 */
function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "")
}

/** 批次目录 = specPath 的 dirname（posix，home 相对）。 */
export function batchDirOf(specPath: string): string {
  const norm = normalizeRel(specPath)
  const i = norm.lastIndexOf("/")
  return i > 0 ? norm.slice(0, i) : ""
}

/** spec 家族分组徽章（文件名约定即类型 —— ADR-0018，无 schema 类型位）。 */
export function specFileClass(rel: string): { label: string; tone: string } {
  const name = normalizeRel(rel).split("/").pop() ?? rel
  const lower = name.toLowerCase()
  if (/^spec-r\d+\.md$/.test(lower)) return { label: "修订", tone: "bg-sky-500/10 text-sky-600" }
  if (lower === "spec.md") return { label: "spec", tone: "bg-amber-500/10 text-amber-600" }
  if (lower.startsWith("spec")) return { label: "spec", tone: "bg-amber-500/10 text-amber-600" }
  if (lower.startsWith("fix-feedback")) return { label: "反馈", tone: "bg-red-500/10 text-red-600" }
  if (lower.startsWith("fix-report") || lower.startsWith("round-report") || lower.startsWith("code-review"))
    return { label: "报告", tone: "bg-emerald-500/10 text-emerald-600" }
  if (normalizeRel(rel).includes("/issues/")) return { label: "票", tone: "bg-zinc-500/10 text-zinc-500" }
  return { label: "其他", tone: "bg-muted text-muted-foreground" }
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
  const specRel = normalizeRel(phase.specPath)
  const editable = isUiEditableSpecPath(phase.specPath)
  const batchDir = batchDirOf(phase.specPath)
  // 当前查看/编辑的批次文件（默认 specPath；点清单切换 —— ADR-0018 可见性）。
  const [activeRel, setActiveRel] = useState(specRel)
  const [state, setState] = useState<State>({ kind: "loading" })
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [files, setFiles] = useState<HomeFileListingEntry[] | null>(null)

  // 开窗复位 + 批次清单拉取（缺目录/越权静默空态，不打扰编辑主流程）。
  useEffect(() => {
    if (!open) return
    setActiveRel(specRel)
    if (!editable) {
      setState({ kind: "unsupported" })
      setFiles(null)
      return
    }
    let cancelled = false
    listHomeDir(task.id, batchDir)
      .then((f) => { if (!cancelled) setFiles(f) })
      .catch(() => { if (!cancelled) setFiles(null) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-anchor on open/phase
  }, [open, specRel, task.id, editable, batchDir])

  // 加载当前选中文件。
  useEffect(() => {
    if (!open || !editable) return
    let cancelled = false
    setState({ kind: "loading" })
    setDraft(null)
    getHomeFile(task.id, activeRel)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-fetch on file switch
  }, [open, activeRel, task.id, editable])

  const current = draft ?? (state.kind === "loaded" ? state.content : "")
  const dirty = draft !== null && state.kind === "loaded" && draft !== state.content

  // 清单排序：spec 家族在前，其余按 mtime 新在前；issues/ 归组在后。
  const sortedFiles = useMemo(() => {
    if (!files) return []
    const rank = (f: HomeFileListingEntry): number => {
      const c = specFileClass(f.path).label
      if (c === "spec") return 0
      if (c === "修订") return 1
      if (c === "反馈") return 2
      if (c === "报告") return 3
      if (c === "票") return 5
      return 4
    }
    return [...files].sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : 1))
  }, [files])

  const save = async (content: string, label: string) => {
    setSaving(true)
    try {
      await putHomeFile(task.id, activeRel, content)
      setState({ kind: "loaded", content })
      setDraft(null)
      toast.success(label)
      // 刷新清单（新文件的 mtime/存在性）。
      listHomeDir(task.id, batchDir).then(setFiles).catch(() => { /* keep */ })
    } catch (err: unknown) {
      toast.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const activeName = activeRel.split("/").pop() ?? activeRel

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[820px] max-h-[88vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-base">
            Phase {phase.index} 批次目录 · {phase.name}
            <span className="ml-2 text-xs font-mono font-normal text-muted-foreground">{activeName}</span>
          </DialogTitle>
          <DialogDescription className="text-xs font-mono">
            {batchDir || phase.specPath}
          </DialogDescription>
        </DialogHeader>

        {/* 批次文件清单（ADR-0018 可见性：spec 家族 / 反馈 / 报告 / 票） */}
        {editable && (
          <div className="flex flex-wrap gap-1.5 pb-1 border-b" data-spec-file-list>
            {(sortedFiles.length > 0 ? sortedFiles : [{ path: specRel, mtime: "", bytes: 0 }]).map((f) => {
              const cls = specFileClass(f.path)
              const active = f.path === activeRel
              return (
                <button
                  key={f.path}
                  onClick={() => setActiveRel(f.path)}
                  className={`text-[10px] px-1.5 py-0.5 rounded border font-mono flex items-center gap-1 ${
                    active ? "border-amber-400/60 bg-amber-500/10" : "border-border hover:bg-muted/50"
                  }`}
                  data-spec-file={f.path}
                  title={`${f.path}${f.mtime ? ` · ${f.mtime.slice(0, 16).replace("T", " ")}` : ""}`}
                >
                  <span className={`px-1 rounded ${cls.tone}`}>{cls.label}</span>
                  {f.path.split("/").pop()}
                </button>
              )
            })}
          </div>
        )}

        {state.kind === "loading" && (
          <div className="flex items-center justify-center py-16">
            <Spinner className="size-5" />
          </div>
        )}

        {state.kind === "unsupported" && (
          <div className="rounded-md border bg-muted/30 px-3 py-4 text-xs text-muted-foreground flex items-start gap-2" data-spec-unsupported>
            <FileWarning className="size-4 shrink-0 mt-0.5" />
            <span>
              此路径不在看板编辑白名单（task home 的 <code>.scratch/**.md</code>）内 ——
              通常是 agent 绝对路径直写的产物。内容请通过文件路径查看，修改请在对话里进行。
            </span>
          </div>
        )}

        {state.kind === "error" && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-3 text-xs text-red-600" data-spec-error>
            读取失败：{state.message}
          </div>
        )}

        {state.kind === "missing" && activeRel === specRel && (
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

        {(state.kind === "loaded" || (state.kind === "missing" && activeRel === specRel && draft !== null)) && (
          <>
            <textarea
              className="flex-1 min-h-[360px] w-full rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-relaxed resize-none"
              value={current}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              data-spec-editor
              aria-label={`Phase ${phase.index} 批次文件 ${activeName} 内容`}
            />
            <div className="flex items-center justify-end gap-2 pt-1">
              <span className="mr-auto text-[10px] text-muted-foreground">
                手改经下一轮 seed 进 workspace；执行侧若在 ws 修订 spec，collect 回流以终态为准
              </span>
              {dirty && draft !== null && (
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setDraft(null)} disabled={saving}>
                  放弃修改
                </Button>
              )}
              <Button
                size="sm" className="h-7 text-xs"
                disabled={!dirty || saving}
                onClick={() => draft !== null && void save(draft, `${activeName} 已保存`)}
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
