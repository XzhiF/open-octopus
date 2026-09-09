// packages/web-app/components/tasks/authoring/draft-batches.tsx
//
// #53 draft-artifact-visibility — 右栏「草稿批次」区：磁盘直扫 `.scratch/` 的
// 产物可见面（spec K1：绕开 task_spec.phases[] 门控，agent 落盘即现）。插在
// 「Phase 计划」(WorkflowBox) 与「执行产物」(OutputViewer) 之间，仅 v4 渲染。
//
// 职责边界（两区一账）：
//   • 本区 = 磁盘真相（有什么文件）；WorkflowBox = 契约真相（phases[]）。
//   • 按 specPath 前缀对位：批次 ● 已对位某 P_i / ○ 未对位；phase ✗ 已登记未落盘。
//   • ○ 未对位 + draft → [建骨架并对位]（K6）：读 spec.md 首标题作 name，整数组
//     PUT 追加一条 phase（复用 phases-mutation 的 S5 纪律，不复制）。
//   • 点文件 → 复用 PhaseSpecDialog（K4：喂合成 TaskPhase，弹窗只吃 specPath）。
//
// 数据源与刷新由 useBatchTree 拥有（父级 authoring-workspace 传入 tree），本区
// 不自行 fetch——保证行内展开/入队清单/本区三处吃同一份 batches（一屏一真相）。

"use client"

import { useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FolderOpen, Copy, RefreshCw, ChevronRight, ChevronDown, FileWarning, Layers } from "lucide-react"
import { toast } from "sonner"
import type { Task, TaskPhase } from "@octopus/shared"
import type { BatchTreeEntry, HomeFileListingEntry } from "@/lib/tasks-api"
import { getHomeFile, TaskApiError } from "@/lib/tasks-api"
import { PhaseSpecDialog, specFileClass, batchDirOf, normalizeRel } from "./phase-spec-dialog"
import { SectionCard } from "./section-card"
import { DEFAULT_NEW_WORKFLOW, withPhases } from "./phases-mutation"
import { isRelativeScratchSpec, type BatchTreeState } from "./use-batch-tree"

export interface DraftBatchesProps {
  task: Task
  phases: TaskPhase[]
  isDraft: boolean
  tree: BatchTreeState
  onMutated: () => void
}

/** home 相对 posix 的目录名（batchDirOf 语义，但对已归一的 dir 直接返回）。 */
function copyToClipboard(text: string): void {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text)
    return
  }
  const ta = document.createElement("textarea")
  ta.value = text
  ta.style.position = "fixed"
  ta.style.left = "-9999px"
  ta.style.opacity = "0"
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand("copy")
  } catch {
    /* ignore */
  }
  document.body.removeChild(ta)
}

const baseName = (p: string) => normalizeRel(p).split("/").pop() ?? p
const isSpecFile = (p: string) => baseName(p).toLowerCase() === "spec.md"
const isTicket = (p: string) => normalizeRel(p).includes("/issues/")

export function DraftBatches({ task, phases, isDraft, tree, onMutated }: DraftBatchesProps) {
  const { batches, loading, error, refresh } = tree
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dialogBatch, setDialogBatch] = useState<{ batch: BatchTreeEntry; file: HomeFileListingEntry } | null>(null)
  const [busySlug, setBusySlug] = useState<string | null>(null)

  // 全部落盘文件路径集（供「已登记未落盘」反向账）。
  const allPaths = useMemo(
    () => new Set(batches.flatMap((b) => b.files.map((f) => normalizeRel(f.path)))),
    [batches],
  )

  // 对位：批次 dir 命中某 phase 的 specPath 所在目录 → ● P_i。
  const phaseForBatch = useMemo(() => {
    const byDir = new Map<string, TaskPhase>()
    for (const p of phases) {
      if (!isRelativeScratchSpec(p.specPath)) continue
      byDir.set(batchDirOf(p.specPath), p)
    }
    return byDir
  }, [phases])

  const orphans = useMemo(
    () =>
      phases.filter(
        (p) => isRelativeScratchSpec(p.specPath) && !allPaths.has(normalizeRel(p.specPath)),
      ),
    [phases, allPaths],
  )

  const toggle = (dir: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(dir) ? next.delete(dir) : next.add(dir)
      return next
    })

  const handleAdopt = async (batch: BatchTreeEntry) => {
    if (busySlug) return
    if (phases.some((p) => p.slug === batch.slug)) {
      toast.error(`slug「${batch.slug}」已存在——目录名与既有 phase 撞，先在对话里核对`)
      return
    }
    setBusySlug(batch.dir)
    try {
      // K6：首 `# ` 标题作 name（缺/失败回退 slug）。
      let name = batch.slug
      try {
        const r = await getHomeFile(task.id, `${batch.dir}/spec.md`)
        const m = /^\s*#\s+(.+?)\s*$/m.exec(r.content)
        if (m?.[1]) name = m[1].slice(0, 100)
      } catch (err) {
        if (!(err instanceof TaskApiError && err.status === 404)) throw err
      }
      await withPhases(task, (base) => [
        ...base,
        {
          index: 9999,
          name,
          slug: batch.slug,
          specPath: `./${batch.dir}/spec.md`,
          workflowRef: DEFAULT_NEW_WORKFLOW as TaskPhase["workflowRef"],
          inputValues: { batch_dir: "${phase.batch_rel}" },
        },
      ])
      toast.success(`Phase「${name}」已建骨架并对位`)
      onMutated()
    } catch (err) {
      toast.error(`建骨架失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusySlug(null)
    }
  }

  return (
    <SectionCard
      icon={<Layers className="size-3.5 text-pop-ink" />}
      iconTint="var(--pop-cyan-soft)"
      title="草稿批次"
      count={batches.length}
      hint="磁盘直扫 · 落盘即现"
      storageKey="authoring-batches"
      data-draft-batches
      action={
        <button
          onClick={refresh}
          className="p-0.5 rounded hover:bg-muted transition-colors"
          title="刷新批次目录"
          data-batch-refresh
        >
          <RefreshCw className="size-3 text-muted-foreground" />
        </button>
      }
    >
      {/* 全出血（-mx/-my 抵消卡体 px-3 py-2）：路径条/警示/列表保持边到边形态 */}
      <div className="-mx-3 -my-2">
      {/* 落点路径行（抄执行产物区 artifactsDir idiom） */}
      <div className="px-3 py-1 border-b flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono bg-muted/30">
        <FolderOpen className="size-2.5 shrink-0" />
        <span className="truncate" title={`~/.octopus/tasks/${task.id}/.scratch`}>
          .scratch/
        </span>
        <button
          onClick={() => copyToClipboard(`~/.octopus/tasks/${task.id}/.scratch`)}
          className="shrink-0 ml-auto p-0.5 rounded hover:bg-muted transition-colors"
          title="复制路径"
        >
          <Copy className="size-2.5" />
        </button>
      </div>

      {/* 「未落盘」判据只在扫描就绪时讲真话（loading/error 态不误警） */}
      {orphans.length > 0 && !loading && !error && (
        <div className="px-3 py-1 border-b text-[10px] text-amber-600 flex items-center gap-1" data-batch-orphans>
          <FileWarning className="size-3 shrink-0" />
          已登记未落盘：{orphans.map((p) => `P${p.index}`).join(", ")}
        </div>
      )}

      {loading && batches.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-muted-foreground flex items-center gap-2">
          <Spinner className="size-3" /> 扫描批次目录…
        </div>
      ) : error && batches.length === 0 ? (
        <div className="px-3 py-2 text-[11px] text-red-600">{error}</div>
      ) : batches.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-muted-foreground/60" data-batch-empty>
          ⏳ 尚无批次文件——对话里让 agent 拆，spec/票一旦写进 `.scratch/` 这里立刻出现（不必等 phases 写回）。
        </div>
      ) : (
        <div className="divide-y">
          {batches.map((b) => {
            const matched = phaseForBatch.get(b.dir)
            const hasSpec = b.files.some((f) => isSpecFile(f.path))
            const tickets = b.files.filter((f) => isTicket(f.path))
            const open = expanded.has(b.dir)
            return (
              <div key={b.dir} data-batch-row={b.slug}>
                <div className="w-full px-3 py-2 flex items-center gap-2 text-left">
                  <button className="flex items-center gap-2 flex-1 min-w-0" onClick={() => toggle(b.dir)} data-batch-toggle={b.slug}>
                    {open ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
                    <span className="text-xs font-mono truncate" data-batch-slug={b.slug}>{b.slug}</span>
                    <Badge variant={hasSpec ? "secondary" : "outline"} className={`text-[9px] ${hasSpec ? "" : "text-amber-600 border-amber-400/50"}`}>
                      spec{hasSpec ? "✓" : "✗"}
                    </Badge>
                    <span className="text-[9px] text-muted-foreground">票×{tickets.length}</span>
                  </button>
                  {matched ? (
                    <span className="text-[10px] text-emerald-600 shrink-0" data-batch-matched={b.slug}>● P{matched.index}</span>
                  ) : isDraft ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[10px] shrink-0"
                      onClick={() => void handleAdopt(b)}
                      disabled={busySlug !== null}
                      data-batch-adopt={b.slug}
                    >
                      {busySlug === b.dir ? <Spinner className="size-3 mr-1" /> : null}
                      ○ 建骨架并对位
                    </Button>
                  ) : (
                    <span className="text-[10px] text-muted-foreground shrink-0" data-batch-unmatched={b.slug}>○ 未对位</span>
                  )}
                </div>
                {open && (
                  <div className="px-3 pb-2 flex flex-wrap gap-1.5" data-batch-files={b.slug}>
                    {b.files.map((f) => {
                      const cls = specFileClass(f.path)
                      return (
                        <button
                          key={f.path}
                          onClick={() => setDialogBatch({ batch: b, file: f })}
                          className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-muted/50 font-mono flex items-center gap-1"
                          data-batch-file={f.path}
                          title={`${f.path} · ${f.mtime.slice(0, 16).replace("T", " ")}`}
                        >
                          <span className={`px-1 rounded ${cls.tone}`}>{cls.label}</span>
                          {baseName(f.path)}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      </div>

      {dialogBatch && (
        <PhaseSpecDialog
          task={task}
          phase={synthesizePhase(dialogBatch.batch)}
          initialActivePath={dialogBatch.file.path}
          open
          onOpenChange={(o) => { if (!o) setDialogBatch(null) }}
        />
      )}
    </SectionCard>
  )
}

/** 点批次内某文件 → 合成喂 PhaseSpecDialog 的 TaskPhase（K4：弹窗只吃 specPath，
 *  index/name 仅标题用）。specPath 恒取批目录 spec.md（列目录以整批为域），
 *  被点文件经 initialActivePath 定位 —— 点票也能看到并切到同批 spec.md。 */
function synthesizePhase(batch: BatchTreeEntry): TaskPhase {
  return {
    index: 0,
    name: batch.slug,
    slug: batch.slug,
    specPath: `./${batch.dir}/spec.md`,
    workflowRef: DEFAULT_NEW_WORKFLOW as TaskPhase["workflowRef"],
    inputValues: {},
  }
}
