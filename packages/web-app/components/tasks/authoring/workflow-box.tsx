// packages/web-app/components/tasks/authoring/workflow-box.tsx
//
// PhaseListEditor（契约修复改版，原票 12 PhaseBindingList 升级）：v4 draft 右栏
// 的 phase 结构化编辑面。一切 phases 变更走 PUT task_spec.phases 整数组 +
// If-Match（S5 纪律：写回前 getTask 重取 version；409 不自动重试 — 拿旧数组
// 盖回 agent 的并发意图是危险的，提示用户重试即可）。
//
// 绑定目录改版（2026-09-06）：可绑工作流 = workflow-presets.yaml 绑定目录
// （GET /api/workflow-presets，与 task-author agent 同源）——不再枚举
// built-in 域；GET /api/workflows/built-in 仅作输入定义镜像（required/默认值
// 渲染 + 入队预检），不作可选项列表。选中目录项即以条目 inputs 骨架预填。
//
// 能力（v4-only UI，generic/任务级 v3 单卡已随 goal/ac 旧路径退役）：
//   • 增删 phase、改 name/slug/specPath、上移/下移 —— 仅 draft 态开放。
//     裁定依据：index=数组位次是验收查询（/:id/acceptance）与轮次定位
//     （dispatchPhaseRound）的键，gate 按位次报 phase:<i>；ready 起 spec 快照已物化
//     冻结（K16 隔离即冻结），看板上的结构重排会造成派生/账本/快照三方错位。
//     ready 后退化为只读 + 换绑定；跨轮传播走 task-author 对话（agent 车道）。
//   • 逐行「spec.md」→ PhaseSpecDialog（home-file GET/PUT，契约修复新端点）。
//   • taskPhaseSchema.workflowRef 非空（shared min(1)）→ 新 phase 表单必须带
//     workflow 初选；新建即以目录骨架带 inputValues（「绑定工作流」可改）。
//
// 写回链保留票 12 的修复：S2 取数 effect 只依赖 [open]；AC-20 开窗期间
// catalog/defs 各恰一次 fetch；S5 保存前重取 version。

"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Search, ChevronRight, Plus, Trash2, ArrowUp, ArrowDown, FileText, Pencil,
} from "lucide-react"
import { toast } from "sonner"
import type { Task, TaskSpec, TaskPhase } from "@octopus/shared"
import { getTask, updateTask, getHomeFile } from "@/lib/tasks-api"
import {
  getBuiltInWorkflowDetail,
  listBuiltInWorkflows,
  listWorkflowPresets,
  type BuiltInWorkflowSummary,
  type WorkflowPreset,
} from "@/lib/workflow-presets-api"
import { PhaseSpecDialog, normalizeRel } from "./phase-spec-dialog"
import { cn } from "@/lib/utils"
import {
  findBatchFor,
  findSpecEntry,
  isRelativeScratchSpec,
  summarizeSpec,
  type BatchTreeState,
} from "./use-batch-tree"
import {
  DEFAULT_NEW_WORKFLOW,
  SLUG_RE,
  defaultSpecPath,
  withPhases,
} from "./phases-mutation"

export interface WorkflowBoxProps {
  task: Task
  onMutated: () => void
  /** #53：磁盘直扫树（行内展开的 spec 灯/票清单数据源）。缺省时展开区退化到
   *  只显契约信息——旧调用点（测试/历史面）不因缺 prop 而红。 */
  batchTree?: BatchTreeState
}

export function WorkflowBox({ task, onMutated, batchTree }: WorkflowBoxProps) {
  return <PhaseListEditor task={task} onMutated={onMutated} batchTree={batchTree} />
}

/** Classify an input value's placeholder SHAPE for the chip label — pure
 *  ${...} template shows verbatim; anything else truncates at 20 chars. */
function describeInputShape(value: string): string {
  if (/^\$\{[^}]+\}$/.test(value)) return value
  return value.length > 20 ? value.slice(0, 17) + "…" : value
}

function InputChips({ values }: { values: Record<string, string> }) {
  const entries = Object.entries(values)
  if (entries.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1" data-input-chips>
      {entries.map(([key, value]) => (
        <Badge key={key} variant="outline" className="text-[9px] py-0 h-4">
          {key}: {describeInputShape(value)}
        </Badge>
      ))}
    </div>
  )
}

// ── PhaseListEditor（v4 唯一面） ─────────────────────────────────────

function PhaseListEditor({ task, onMutated, batchTree }: WorkflowBoxProps) {
  const phases = task.task_spec.phases ?? []
  const isDraft = task.status === "draft"
  const [openPhaseIdx, setOpenPhaseIdx] = useState<number | null>(null)
  const [specTarget, setSpecTarget] = useState<{ phase: TaskPhase; activeRel?: string } | null>(null)
  const [deletingIdx, setDeletingIdx] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  // 分层展开（2026-09-12 拍板）：默认只展开「当前 phase」（= 首个，draft 期
  // 即待推进的那格），其余收成细条。null = 尚未交互，仍走默认（agent 稍后
  // 写回 phases 时，首个 phase 自动获得默认展开）。
  const [openSet, setOpenSet] = useState<Set<number> | null>(null)
  const effectiveOpen = openSet ?? new Set(phases.length > 0 ? [phases[0].index] : [])
  const togglePhase = (idx: number) => {
    const next = new Set(effectiveOpen)
    if (next.has(idx)) next.delete(idx)
    else next.add(idx)
    setOpenSet(next)
  }

  // 所有结构动作共用的串行闸：一次只有一个在飞（连点重排会连 bump version）。
  const guard = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      if (busy) return
      setBusy(true)
      try {
        await fn()
        toast.success(label)
        onMutated()
      } catch (err) {
        toast.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setBusy(false)
      }
    },
    [busy, onMutated],
  )

  const handleMove = (index: number, dir: -1 | 1) =>
    void guard("已重排", async () => {
      await withPhases(task, (base) => {
        const pos = base.findIndex((p) => p.index === index)
        const to = pos + dir
        if (pos < 0 || to < 0 || to >= base.length) return base
        const next = [...base]
        const [row] = next.splice(pos, 1)
        next.splice(to, 0, row)
        return next
      })
    })

  const handleDelete = (index: number) =>
    void guard(`Phase ${index} 已删除`, async () => {
      await withPhases(task, (base) => base.filter((p) => p.index !== index))
    })

  const handleAdd = (row: {
    name: string
    slug: string
    workflowRef: string
    inputValues: Record<string, string>
  }) =>
    void guard(`Phase ${row.name} 已添加`, async () => {
      await withPhases(task, (base) => {
        if (base.some((p) => p.slug === row.slug)) {
          throw new Error(`slug「${row.slug}」已存在——换个目录名`)
        }
        return [
          ...base,
          {
            // index 由 renumber 统一位次重排（占位 9999 防与既有撞键）
            index: 9999,
            name: row.name,
            slug: row.slug,
            specPath: defaultSpecPath(row.slug),
            workflowRef: row.workflowRef as TaskPhase["workflowRef"],
            // 目录骨架预填（占位符由 server materialize 解析）
            inputValues: { ...row.inputValues },
          },
        ]
      })
    })

  return (
    // 卡壳退役（2026-09-12 分层重排）：phase 直接排在「SPEC · 规格」分组吊牌下，
    // 每 phase 一张独立贴纸卡；「Phase 计划」折叠壳由逐卡展开态取代。
    <div className="space-y-1.5" data-workflow-box data-phase-binding-list>
      {phases.length === 0 ? (
        <p className="text-[11px] text-muted-foreground" data-phase-bind-empty>
          尚无 phase —— 对话里让 agent 拆分（拆分产物会先在下方「草稿批次」区出现），或用「添加 Phase」手动建骨架。
        </p>
      ) : (
        phases.map((p, i) => (
          <PhaseRow
            key={p.index}
            task={task}
            phase={p}
            editable={isDraft}
            busy={busy}
            first={i === 0}
            last={i === phases.length - 1}
            canDelete={phases.length > 1}
            current={i === 0}
            expanded={effectiveOpen.has(p.index)}
            onToggle={() => togglePhase(p.index)}
            onMove={handleMove}
            onRequestDelete={setDeletingIdx}
            onOpenBind={setOpenPhaseIdx}
            onOpenSpec={(p, activeRel) => setSpecTarget({ phase: p, activeRel })}
            onEdited={onMutated}
            busyGate={guard}
            batchTree={batchTree}
          />
        ))
      )}

      {isDraft && <AddPhaseRow busy={busy} onAdd={handleAdd} />}

      {!isDraft && (
        <p className="text-[10px] text-muted-foreground">
          结构编辑仅 draft 开放（入队后信封已物化冻结）；换绑定仍可用，跨轮传播走对话。
        </p>
      )}

      {openPhaseIdx !== null && (
        <WorkflowBindingDialog
          task={task}
          phaseIndex={openPhaseIdx}
          open
          onOpenChange={(o) => { if (!o) setOpenPhaseIdx(null) }}
          onMutated={onMutated}
        />
      )}

      {specTarget && (
        <PhaseSpecDialog
          task={task}
          phase={specTarget.phase}
          initialActivePath={specTarget.activeRel}
          open
          onOpenChange={(o) => { if (!o) setSpecTarget(null) }}
        />
      )}

      {/* 删除二次确认（不可撤销 —— 批次文件保留但脱离任务） */}
      <AlertDialog open={deletingIdx !== null} onOpenChange={(o) => { if (!o) setDeletingIdx(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 Phase {deletingIdx}</AlertDialogTitle>
            <AlertDialogDescription>
              删除后其后 phase 自动重排编号。若该 phase 已有批次产物（spec/issues），文件不会被删除，但将脱离任务。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => { e.preventDefault(); if (deletingIdx != null) handleDelete(deletingIdx) }}
              className="bg-pop-red hover:bg-pop-red/90"
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ── 单行（查看态 + draft 内联编辑 name/slug/specPath） ────────────────

interface PhaseRowProps {
  task: Task
  phase: TaskPhase
  editable: boolean
  busy: boolean
  first: boolean
  last: boolean
  canDelete: boolean
  /** 是否首个 phase（导航语义：当前待推进 → 「当前」chip）。 */
  current: boolean
  /** 受控展开（PhaseListEditor 管默认「只展开当前」，2026-09-12 分层重排）。 */
  expanded: boolean
  onToggle: () => void
  onMove: (index: number, dir: -1 | 1) => void
  onRequestDelete: (index: number) => void
  onOpenBind: (index: number) => void
  onOpenSpec: (phase: TaskPhase, activeRel?: string) => void
  onEdited: () => void
  busyGate: (label: string, fn: () => Promise<void>) => Promise<void>
  batchTree?: BatchTreeState
}

const fmtBytes = (n: number): string =>
  n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1024 / 1024).toFixed(1)}M`
const fmtTime = (iso: string): string => (iso ? iso.slice(5, 16).replace("T", " ") : "")
const baseName = (p: string): string => normalizeRel(p).split("/").pop() ?? p

// 分层重排（2026-09-12）：phase 色号瓷砖循环 —— P1 黄、P2 粉、P3 紫…
const PHASE_TONES = [
  "bg-pop-yellow text-pop-ink",
  "bg-pop-pink text-white",
  "bg-pop-purple text-white",
  "bg-pop-cyan text-pop-ink",
  "bg-pop-green text-white",
  "bg-pop-amber text-pop-ink",
]
const toneFor = (index: number): string =>
  PHASE_TONES[((index - 1) % PHASE_TONES.length + PHASE_TONES.length) % PHASE_TONES.length]

function PhaseRow({
  task, phase, editable, busy, first, last, canDelete, current, expanded, onToggle,
  onMove, onRequestDelete, onOpenBind, onOpenSpec, onEdited, busyGate, batchTree,
}: PhaseRowProps) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(phase.name)
  const [slug, setSlug] = useState(phase.slug)
  const [specPath, setSpecPath] = useState(phase.specPath)
  // #53 行内展开：展开态受控（默认只展开当前 phase），展开区吃磁盘树。
  const [summary, setSummary] = useState<{ kdRows: number; excerpt: string } | undefined>(undefined)

  const batches = batchTree?.batches ?? []
  const diskKnown = !!batchTree && !batchTree.loading && !batchTree.error
  const specEntry = expanded ? findSpecEntry(batches, phase.specPath) : null
  const batch = expanded ? findBatchFor(batches, phase.specPath) : null
  const ticketFiles = useMemo(
    () => (batch?.files ?? []).filter((f) => normalizeRel(f.path).includes("/issues/")),
    [batch],
  )

  // 展开后懒取 spec 正文摘要（一次；失败=空摘要，灯与票清单不受影响）。
  useEffect(() => {
    if (!expanded || summary !== undefined || !specEntry) return
    let cancelled = false
    getHomeFile(task.id, normalizeRel(phase.specPath))
      .then((r) => { if (!cancelled) setSummary(summarizeSpec(r.content)) })
      .catch(() => { if (!cancelled) setSummary({ kdRows: 0, excerpt: "" }) })
    return () => { cancelled = true }
  }, [expanded, summary, specEntry, task.id, phase.specPath])

  // 退出编辑态/外部刷新（SSE onMutated）→ 回到服务端事实
  useEffect(() => {
    if (!editing) {
      setName(phase.name)
      setSlug(phase.slug)
      setSpecPath(phase.specPath)
    }
  }, [phase, editing])

  const invalid =
    !name.trim() || name.trim().length > 100 ||
    !SLUG_RE.test(slug) || slug.length > 100 ||
    !specPath.trim()

  const handleSaveRow = () =>
    busyGate("已保存", async () => {
      await withPhases(task, (base) =>
        base.map((p) =>
          p.index === phase.index
            ? { ...p, name: name.trim(), slug, specPath: specPath.trim() }
            : p,
        ),
      )
      setEditing(false)
      onEdited()
    })

  return (
    <div
      data-phase-bind-card={phase.index}
      className={cn(
        "group overflow-hidden rounded-xl border-pop-bd bg-pop-paper transition-shadow hover:shadow-pop",
        expanded ? "border-[2.5px] shadow-pop-sm" : "border-2 shadow-none",
      )}
    >
      {editing ? (
        <div className="space-y-1.5 px-2.5 py-2" data-phase-row-edit-form={phase.index}>
          <div className="flex items-center gap-1.5">
            <Label className="text-[10px] w-10 shrink-0">name</Label>
            <Input
              className="h-6 text-xs"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              data-phase-name-input={phase.index}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Label className="text-[10px] w-10 shrink-0">slug</Label>
            <Input
              className={`h-6 text-xs ${slug && !SLUG_RE.test(slug) ? "border-pop-red" : ""}`}
              value={slug}
              maxLength={100}
              title="path-safe：字母/数字开头，可含 . _ -"
              onChange={(e) => setSlug(e.target.value)}
              data-phase-slug-input={phase.index}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Label className="text-[10px] w-10 shrink-0">spec</Label>
            <Input
              className="h-6 text-xs font-mono"
              value={specPath}
              onChange={(e) => setSpecPath(e.target.value)}
              data-phase-specpath-input={phase.index}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => setEditing(false)} disabled={busy} data-phase-edit-cancel={phase.index}>
              取消
            </Button>
            <Button size="sm" className="h-6 text-[10px]" onClick={() => void handleSaveRow()} disabled={invalid || busy} data-phase-edit-save={phase.index}>
              {busy ? <Spinner className="size-3 mr-1" /> : null}保存
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* ── header 行：整行 = 展开开关（P# 瓷砖 + 名称 + 绑定 + chevron）── */}
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            title="展开/收起：spec 磁盘状态 + 票清单 + 摘要（不必开弹窗）"
            data-phase-expand-toggle={phase.index}
            className={cn("flex w-full min-w-0 items-center gap-2 text-left", expanded ? "px-2.5 pt-2" : "px-2 py-1")}
          >
            <span aria-hidden className={cn(
              "grid shrink-0 place-items-center rounded-lg border-2 border-pop-bd font-mono font-black shadow-[2px_2px_0_rgba(28,27,34,.15)]",
              toneFor(phase.index),
              expanded ? "size-[26px] text-[11px]" : "size-[18px] rounded-[6px] text-[9px]",
            )}>
              P{phase.index}
            </span>
            <span data-phase-name={phase.index} className={cn(
              "min-w-0 truncate",
              expanded ? "text-[12.5px] font-black text-pop-ink" : "text-[11px] font-bold text-pop-dim",
            )}>
              {phase.name}
            </span>
            {expanded && (
              <span className="min-w-0 shrink truncate text-[9px] font-mono text-pop-dim/80" data-phase-slug={phase.index}>
                {phase.slug}
              </span>
            )}
            {current && (
              <span className="shrink-0 rounded-full border-[1.5px] border-pop-bd bg-pop-cyan-soft px-1.5 text-[8.5px] font-black text-pop-cyan">当前</span>
            )}
            {phase.workflowRef ? (
              <span data-phase-workflow-ref={phase.index} className="ml-auto max-w-[150px] shrink-0 truncate rounded-md border-[1.5px] border-pop-bd bg-pop-purple-soft px-1.5 py-px font-mono text-[9px] font-black text-pop-purple">
                {phase.workflowRef}
              </span>
            ) : (
              <span className="ml-auto shrink-0 text-[10px] font-black text-pop-amber" data-phase-unbound={phase.index}>
                未绑定
              </span>
            )}
            <ChevronRight aria-hidden className={cn("size-3 shrink-0 text-pop-dim transition-transform", expanded && "rotate-90")} />
          </button>

          {/* ── 展开体：三层信息（① spec 磁盘灯 ② 批次/票 ③ inputs 折叠）── */}
          {expanded && (
            <div className="mx-2 mt-1.5 space-y-1 rounded-lg border-[1.5px] border-pop-bd/25 bg-pop-bg px-2.5 py-2" data-phase-expand-panel={phase.index}>
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-8 shrink-0 font-mono text-[8.5px] font-black tracking-wider text-pop-dim/70">SPEC</span>
                {/* spec 磁盘灯（K5 判定源=tree；扫描未就绪/域外路径不臆断，中性表达） */}
                {specEntry ? (
                  <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[10px]" data-phase-spec-disk={phase.index}>
                    <span className="text-pop-green">spec.md ✓</span>
                    <span className="font-mono text-muted-foreground">
                      {fmtBytes(specEntry.bytes)} · {fmtTime(specEntry.mtime)}
                    </span>
                    <button
                      className="ml-auto text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2"
                      onClick={() => onOpenSpec(phase)}
                      data-phase-open-editor={phase.index}
                    >
                      打开编辑器
                    </button>
                  </div>
                ) : !diskKnown ? (
                  <div className="min-w-0 flex-1 text-[10px] text-muted-foreground" data-phase-spec-unknown={phase.index}>
                    spec.md · 磁盘状态未知（扫描未就绪，可在「草稿批次」区 [↻] 刷新）
                  </div>
                ) : isRelativeScratchSpec(phase.specPath) ? (
                  <div className="min-w-0 flex-1 text-[10px] text-pop-amber" data-phase-spec-missing={phase.index}>
                    spec.md ✗ 磁盘未落盘 —— 该 phase 已登记但批次目录里还没有 spec.md
                  </div>
                ) : phase.specPath ? (
                  <div className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground font-mono" data-phase-spec-abs={phase.index}>
                    路径不在 `.scratch` 扫描域（绝对路径直写）：{baseName(phase.specPath)}
                  </div>
                ) : (
                  <div className="min-w-0 flex-1 text-[10px] text-muted-foreground" data-phase-spec-nopath={phase.index}>
                    尚未设定 spec 路径
                  </div>
                )}
              </div>

              {/* 摘要（懒取，失败静默） */}
              {summary && (summary.kdRows > 0 || summary.excerpt) && (
                <div className="pl-10 text-[10px] text-muted-foreground" data-phase-summary={phase.index}>
                  {summary.kdRows > 0 && <span className="mr-1.5">Key Decisions {summary.kdRows} 条</span>}
                  {summary.excerpt && <span className="line-clamp-2">{summary.excerpt}</span>}
                </div>
              )}

              <div className="flex items-start gap-2 min-w-0">
                <span className="w-8 shrink-0 pt-px font-mono text-[8.5px] font-black tracking-wider text-pop-dim/70">批次</span>
                <div className="min-w-0 flex-1 space-y-1">
                  {batch && (
                    <div className="truncate text-[9px] font-mono text-pop-dim/80" title={batch.dir}>{batch.dir}</div>
                  )}
                  {/* 票清单 chips（点击 = 复用弹窗打开该票） */}
                  {batch ? (
                    ticketFiles.length > 0 ? (
                      <div className="flex flex-wrap gap-1" data-phase-tickets={phase.index}>
                        {ticketFiles.map((f) => (
                          <button
                            key={f.path}
                            onClick={() => onOpenSpec(phase, normalizeRel(f.path))}
                            className="rounded border-[1.5px] border-pop-bd/40 bg-pop-paper px-1.5 py-0.5 font-mono text-[9px] hover:bg-pop-yellow-soft"
                            title={f.path}
                            data-phase-ticket={f.path}
                          >
                            {baseName(f.path)}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[10px] text-muted-foreground/70" data-phase-tickets-empty={phase.index}>
                        issues/ 尚无票
                      </div>
                    )
                  ) : diskKnown ? (
                    <div className="text-[10px] text-muted-foreground/70" data-phase-batch-missing={phase.index}>
                      未找到该 phase 的批次目录（落盘后自动出现）
                    </div>
                  ) : null}
                </div>
              </div>

              {/* inputs 默认收进 details（层级：文件/批次先于参数） */}
              {Object.keys(phase.inputValues ?? {}).length > 0 && (
                <details className="pl-10">
                  <summary className="cursor-pointer font-mono text-[8.5px] font-black tracking-wider text-pop-dim/70 hover:text-pop-ink">
                    INPUTS ×{Object.keys(phase.inputValues ?? {}).length}
                  </summary>
                  <div className="pt-1"><InputChips values={phase.inputValues ?? {}} /></div>
                </details>
              )}
            </div>
          )}

          {/* ── 动作带：恒在 DOM（e2e 钉点）；收起态 hover/focus 才显形 ── */}
          <div className={cn(
            "flex items-center gap-1.5 px-2 pb-1.5 transition-opacity duration-150",
            expanded ? "pt-0.5" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          )}>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px] font-black text-pop-purple hover:bg-pop-purple-soft hover:text-pop-purple"
              onClick={() => onOpenBind(phase.index)}
              data-phase-bind-button={phase.index}
            >
              {phase.workflowRef ? "更换工作流" : "绑定工作流"}
              <ChevronRight className="size-3" />
            </Button>
            <div className="ml-auto flex items-center divide-x divide-border/60 rounded-md border border-border/60">
              <Button
                variant="ghost"
                size="sm"
                className="size-6 p-0 text-muted-foreground hover:text-foreground"
                title={`编辑 spec.md：${phase.specPath}`}
                onClick={() => onOpenSpec(phase)}
                data-phase-spec-button={phase.index}
              >
                <FileText className="size-3" />
              </Button>
              {editable && (
                <>
                  <Button
                    variant="ghost" size="sm" className="size-6 p-0 text-muted-foreground hover:text-foreground" title="编辑名称/slug/spec 路径"
                    onClick={() => setEditing(true)}
                    data-phase-edit-button={phase.index}
                  >
                    <Pencil className="size-3" />
                  </Button>
                  <Button
                    variant="ghost" size="sm" className="size-6 p-0 text-muted-foreground hover:text-foreground" title="上移" disabled={first || busy}
                    onClick={() => onMove(phase.index, -1)}
                    data-phase-move-up={phase.index}
                  >
                    <ArrowUp className="size-3" />
                  </Button>
                  <Button
                    variant="ghost" size="sm" className="size-6 p-0 text-muted-foreground hover:text-foreground" title="下移" disabled={last || busy}
                    onClick={() => onMove(phase.index, 1)}
                    data-phase-move-down={phase.index}
                  >
                    <ArrowDown className="size-3" />
                  </Button>
                  <Button
                    variant="ghost" size="sm" className="size-6 p-0 text-pop-red hover:text-pop-red/80"
                    title={canDelete ? "删除 phase" : "至少保留一个 phase"} disabled={!canDelete || busy}
                    onClick={() => onRequestDelete(phase.index)}
                    data-phase-delete-button={phase.index}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ── 添加 Phase（仅 draft） ───────────────────────────────────────────

function AddPhaseRow({
  busy, onAdd,
}: {
  busy: boolean
  onAdd: (row: { name: string; slug: string; workflowRef: string; inputValues: Record<string, string> }) => void
}) {
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [workflowRef, setWorkflowRef] = useState(DEFAULT_NEW_WORKFLOW)
  const [catalog, setCatalog] = useState<WorkflowPreset[]>([])
  const fetchedRef = useRef(false)

  // 绑定目录一次拉取（catalog 即全部可选项）；失败退化为「只有默认推荐项」的
  // 自由文本 ref。
  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true
    listWorkflowPresets()
      .then(({ presets }) => {
        if (presets.length > 0) setCatalog(presets)
        if (!presets.some((w) => w.workflow === DEFAULT_NEW_WORKFLOW) && presets[0]) {
          setWorkflowRef(presets[0].workflow)
        }
      })
      .catch(() => setCatalog([]))
  }, [])

  // slug 未手打过 → 跟随 name 简版 slugify
  const [slugTouched, setSlugTouched] = useState(false)
  const suggestedSlug = name
    .trim().toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || `phase-${catalog.length + 1}`
  const effectiveSlug = slugTouched ? slug : suggestedSlug
  const valid =
    name.trim().length > 0 && name.trim().length <= 100 &&
    SLUG_RE.test(effectiveSlug) && effectiveSlug.length <= 100

  const handleAdd = () => {
    if (!valid || busy) return
    onAdd({
      name: name.trim(),
      slug: effectiveSlug,
      workflowRef,
      inputValues: { ...catalog.find((w) => w.workflow === workflowRef)?.inputs },
    })
    setName("")
    setSlug("")
    setSlugTouched(false)
  }

  return (
    <div className="rounded-md border border-dashed px-2.5 py-2 space-y-1.5" data-phase-add-form>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-medium text-muted-foreground">
          <Plus className="inline size-3 mr-0.5" />添加 Phase
        </span>
        <span className="text-[9px] text-muted-foreground ml-auto font-mono">
          {defaultSpecPath(effectiveSlug || "…")}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          className="h-6 text-xs flex-1" placeholder="名称（≤100 字）" value={name} maxLength={100}
          onChange={(e) => setName(e.target.value)}
          data-phase-add-name
        />
        <Input
          className={`h-6 text-xs w-32 font-mono ${slugTouched && effectiveSlug && !SLUG_RE.test(effectiveSlug) ? "border-pop-red" : ""}`}
          placeholder={`slug=${suggestedSlug}`} value={effectiveSlug} maxLength={100}
          onChange={(e) => { setSlugTouched(true); setSlug(e.target.value) }}
          data-phase-add-slug
        />
      </div>
      <div className="flex items-center gap-1.5">
        <select
          className="h-6 flex-1 min-w-0 rounded-md border border-border bg-background px-1.5 text-[11px]"
          value={workflowRef}
          onChange={(e) => setWorkflowRef(e.target.value)}
          data-phase-add-workflow
        >
          {(catalog.length > 0 ? catalog.map((w) => w.workflow) : [workflowRef]).map((ref) => (
            <option key={ref} value={ref}>{ref}</option>
          ))}
        </select>
        <Button size="sm" className="h-6 text-[10px]" onClick={handleAdd} disabled={!valid || busy} data-phase-add-submit>
          {busy ? <Spinner className="size-3 mr-1" /> : null}添加
        </Button>
      </div>
      <p className="text-[9px] text-muted-foreground">
        新 phase 以绑定目录骨架预填 inputs（占位符由 server 解析）；随后可在「绑定工作流」弹窗调整。
      </p>
    </div>
  )
}

// ── 绑定弹窗（v4-phase 专用） ────────────────────────────────────────

interface WorkflowBindingDialogProps {
  task: Task
  /** 绑定的目标 phase（1-based index）。 */
  phaseIndex: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onMutated: () => void
}

type InputDefs = NonNullable<BuiltInWorkflowSummary["inputs"]>

function WorkflowBindingDialog({ task, phaseIndex, open, onOpenChange, onMutated }: WorkflowBindingDialogProps) {
  // 当前绑定（开窗快照，仅用于初始选中/预填；写回吃 S5 的重取结果）。
  const phase = (task.task_spec.phases ?? []).find((p) => p.index === phaseIndex) ?? null
  const initialRef = phase?.workflowRef ?? ""
  const initialInputs = phase?.inputValues ?? {}

  // ── 绑定目录 + 输入定义镜像（S2 修：effect 只依赖 [open]） ──
  // presets = 可选项（workflow-presets.yaml）；defs = built-in 工作流的
  // inputs 定义镜像（required/默认值渲染），**不**作可选项列表出现。
  const [presets, setPresets] = useState<WorkflowPreset[]>([])
  const [defs, setDefs] = useState<BuiltInWorkflowSummary[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  // StrictMode dev 下 setup→cleanup→setup 会双跑；ref 守卫保证「每次开窗恰
  // 一次 fetch」（AC4 网络计数），关窗复位。
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (!open) {
      fetchedRef.current = false
      return
    }
    if (fetchedRef.current) return
    fetchedRef.current = true
    setCatalogLoading(true)
    // AC-20：每次开窗恰一次 catalog fetch + 一次 defs fetch（票 10 缓存端点，
    // 热路径零 parse）。无 cancelled 清理：StrictMode 双跑下若首次 fetch 被判死，
    // ref 守卫会让第二次跳过 → 列表永远为空。setState-after-unmount 在 React 18 是 no-op。
    Promise.all([listWorkflowPresets(), listBuiltInWorkflows()])
      .then(([cat, wfDefs]) => {
        setPresets(cat.presets)
        setDefs(wfDefs)
      })
      .catch(() => {
        setPresets([])
        setDefs([])
      })
      .finally(() => setCatalogLoading(false))
  }, [open])

  const [search, setSearch] = useState("")
  const filteredPresets = useMemo(() => {
    if (!search.trim()) return presets
    const q = search.toLowerCase()
    return presets.filter(
      (w) => w.workflow.toLowerCase().includes(q) || w.name.toLowerCase().includes(q),
    )
  }, [presets, search])

  // ── 选中 + inputs 表单（定义来自 defs，初值来自目录骨架） ──
  const [selectedRef, setSelectedRef] = useState<string | null>(initialRef || null)
  const [formInputs, setFormInputs] = useState<Record<string, string>>({ ...initialInputs })

  const handleSelectWorkflow = useCallback((ref: string) => {
    setSelectedRef(ref)
    // 目录骨架预填（goal-task-dev T06 (N) 语义演进：换选不再清空，而是换上
    // 新条目自己的骨架 —— 不跨条目泄漏）。
    setFormInputs({ ...(presets.find((w) => w.workflow === ref)?.inputs ?? {}) })
  }, [presets])

  useEffect(() => {
    if (!open) {
      setSelectedRef(null)
      setFormInputs({})
      setSearch("")
      return
    }
    setSelectedRef(initialRef || null)
    setFormInputs({ ...initialInputs })
    setSearch("")
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed on open only
  }, [open])

  const selectedPreset = useMemo(
    () => presets.find((w) => w.workflow === selectedRef) ?? null,
    [presets, selectedRef],
  )
  const selectedDef = useMemo(
    () => defs.find((w) => w.ref === selectedRef) ?? null,
    [defs, selectedRef],
  )
  const inputDefs: InputDefs = selectedDef?.inputs ?? {}

  // YAML 预览 = 可选深读（默认折叠，展开时才 fetch，展开结果缓存）。
  const [yaml, setYaml] = useState<string | null>(null)
  const [yamlLoading, setYamlLoading] = useState(false)

  useEffect(() => {
    setYaml(null)
  }, [selectedRef])

  const handleYamlToggle = useCallback((el: HTMLDetailsElement) => {
    if (el.open && selectedRef && yaml === null && !yamlLoading) {
      setYamlLoading(true)
      getBuiltInWorkflowDetail(selectedRef)
        .then((d) => setYaml(d.content))
        .catch(() => setYaml(""))
        .finally(() => setYamlLoading(false))
    }
  }, [selectedRef, yaml, yamlLoading])

  // ── 保存（S5 修：写回前重取 version；phases 整数组 PUT） ──────────
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    if (!selectedRef || saving) return
    setSaving(true)
    try {
      // 只持久被编辑/预填的非空值；未动的 YAML default 不落库（default 赢）。
      const cleaned: Record<string, string> = {}
      for (const [k, v] of Object.entries(formInputs)) {
        if (v && v.trim()) cleaned[k] = v
      }
      // S5：If-Match 用重取的 version，不用开窗快照（agent spec-field 并发
      // bump / 10s 轮询换 prop 都不再 409）。fresh.phases 里没有该 index =
      // agent 改写了拆分表 → 拒绝盖写，让用户重开弹窗。
      const fresh = await getTask(task.id)
      const freshSpec = fresh.task_spec
      const basePhases: TaskPhase[] = freshSpec.phases ?? task.task_spec.phases ?? []
      const pos = basePhases.findIndex((p) => p.index === phaseIndex)
      if (pos < 0) {
        throw new Error("phase 计划已被改写（编号不存在），请关闭后重开绑定弹窗")
      }
      const nextPhases = basePhases.map((p, i) =>
        i === pos ? { ...p, workflowRef: selectedRef as TaskPhase["workflowRef"], inputValues: cleaned } : p,
      )
      await updateTask(
        task.id,
        { task_spec: { ...freshSpec, phases: nextPhases } as TaskSpec },
        fresh.version,
      )
      toast.success(`Phase ${phaseIndex} 已绑定工作流: ${selectedRef}`)
      onMutated()
      onOpenChange(false)
    } catch (err) {
      toast.error(`绑定失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }, [selectedRef, formInputs, task, phaseIndex, saving, onMutated, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-base">绑定工作流 — Phase {phaseIndex}</DialogTitle>
          <DialogDescription className="text-xs">
            <>可选项来自绑定目录（workflow-presets.yaml）。支持 {"${phase.slug}"} / {"${phase.spec_dir}"} / {"${phase.batch_rel}"} / {"${task.home}"} / {"${task_artifacts_dir}"} 占位符。</>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 min-h-0 gap-3">
          {/* 左：目录列表（选中/搜索期间永不整列重取——S2 修复后不再有 spinner 闪） */}
          <div className="flex flex-col min-h-0 w-[45%]">
            <div className="relative mb-2">
              <Search className="absolute left-2 top-1.5 size-3 text-muted-foreground" />
              <Input
                placeholder="搜索工作流…"
                className="h-7 pl-7 text-xs"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-binding-search
              />
            </div>

            <ScrollArea className="flex-1 min-h-0" data-binding-list-scroll>
              {catalogLoading && presets.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <Spinner className="size-4" />
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="text-[10px] text-muted-foreground px-1 mb-1">
                    {search ? `搜索结果 (${filteredPresets.length})` : `绑定目录 (${filteredPresets.length})`}
                  </div>
                  {filteredPresets.map((w) => (
                    <button
                      key={w.workflow}
                      className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-accent transition-colors ${
                        selectedRef === w.workflow ? "bg-accent" : ""
                      }`}
                      onClick={() => handleSelectWorkflow(w.workflow)}
                      data-workflow-item={w.workflow}
                    >
                      <div className="font-medium">{w.name}</div>
                      <div className="text-[10px] text-muted-foreground">{w.workflow}</div>
                      {w.desc && (
                        <div className="text-[9px] text-muted-foreground line-clamp-2">{w.desc}</div>
                      )}
                    </button>
                  ))}
                  {filteredPresets.length === 0 && (
                    <div className="px-2 py-4 text-[11px] text-muted-foreground">
                      绑定目录为空——编辑 task-author 的 workflow-presets.yaml 放行工作流
                    </div>
                  )}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* 右：详情（inputs 来自目录 summary）+ 折叠 YAML 预览 */}
          <div className="flex flex-col min-h-0 flex-1 border-l pl-3">
            {selectedRef ? (
              <ScrollArea className="flex-1 min-h-0">
                <div className="space-y-3">
                  <div>
                    <div className="text-sm font-medium">{selectedPreset?.name ?? selectedDef?.name ?? selectedRef}</div>
                    <div className="text-[10px] text-muted-foreground">{selectedRef}</div>
                    {selectedPreset?.desc && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">{selectedPreset.desc}</div>
                    )}
                  </div>

                  {(() => {
                    // 字段三源并集：YAML 定义（required/描述）∪ 目录骨架 ∪ 该
                    // phase 现值 —— task-home 自建流没有定义镜像也可编可见。
                    const names = Array.from(new Set([
                      ...Object.keys(inputDefs),
                      ...Object.keys(selectedPreset?.inputs ?? {}),
                      ...Object.keys(formInputs),
                    ]))
                    if (names.length === 0) return null
                    return (
                      <div className="space-y-2">
                        <div className="text-[10px] font-medium">输入</div>
                        {names.map((name) => {
                          const def = inputDefs[name]
                          return (
                            <div key={name} className="space-y-0.5">
                              <Label className="text-[10px] flex items-center gap-1">
                                {name}
                                {def?.required && <span className="text-pop-red">*</span>}
                              </Label>
                              <Input
                                className="h-6 text-xs font-mono"
                                placeholder={def?.description || (def?.required ? "必填" : "可选")}
                                value={formInputs[name] ?? def?.default ?? ""}
                                onChange={(e) =>
                                  setFormInputs((prev) => ({ ...prev, [name]: e.target.value }))
                                }
                                data-input-field={name}
                              />
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()}

                  <details
                    className="text-[10px]"
                    onToggle={(e) => handleYamlToggle(e.currentTarget)}
                  >
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      YAML 预览
                    </summary>
                    {yamlLoading ? (
                      <div className="mt-1 flex items-center gap-2 text-muted-foreground"><Spinner className="size-3" /> 读取…</div>
                    ) : (
                      <pre className="mt-1 p-2 rounded bg-muted text-[9px] overflow-x-auto max-h-40">
                        {yaml ? yaml.slice(0, 1000) + (yaml.length > 1000 ? "\n…(truncated)" : "") : ""}
                      </pre>
                    )}
                  </details>
                </div>
              </ScrollArea>
            ) : (
              <div className="flex items-center justify-center h-full text-[11px] text-muted-foreground">
                选择左侧工作流查看详情
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={!selectedRef || saving}
            onClick={() => void handleSave()}
            data-bind-save-button
          >
            {saving ? <Spinner className="size-3 mr-1" /> : null}
            {saving ? "保存中…" : "绑定"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
