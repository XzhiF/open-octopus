'use client'

// 全舱任务窗（2026-11-23 用户 #10 / #12 配套）——
//
// 全舱模式下「运行 / 规格 / 验收 / 工作流 YAML」统一开在一扇**舱系浮窗**里：
//   · 窗壳 = .ck12-twin（✕ 左置、标题、坐标、状态；标题栏可拖、右下可缩放、
//     双击标题栏全屏）；不再是 classic TaskModulesLayer / 巨大 Dialog / chat 内联展开。
//   · 入口三处共用同一个 open()：
//       1) chat 任务状态卡的 规格 / 运行 / 验收 页签（TaskStatusCard 走 surface context）
//       2) 作业详情「打开运行 →」（octopus:open-run-window 事件，由 ChatPane 转进来）
//       3) 运行中 Agent / 运行卡「打开工作流」（octopus:open-workflow 事件）
//   · 内容复用既有窗口组件（RunWindow / TaskPlanWindow / AcceptanceWindow），
//     数据源与 desktop 作业坞完全一致，不复制只读实现。
//
// Esc：每扇窗注册进舱的层栈（priority 68，压过作业面 65、低于问答窗 75）。

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react'
import { X } from 'lucide-react'
import { getTask, type TaskView } from '@/lib/tasks-api'
import { fetchExecutionDetail } from '@/lib/api-client'
import {
  TaskModuleSurfaceContext,
  type TaskModuleOpenSpec,
  type TaskModuleSurfaceApi,
} from '@/lib/task-module-surface'
import { RunWindow } from '@/components/chat-workbench/run-window'
import { TaskPlanWindow } from '@/components/chat-workbench/task-plan-window'
import { AcceptanceWindow } from '@/components/chat-workbench/acceptance-window'
import { CockpitArchivePanel } from '@/components/cockpit/face/CockpitArchivePanel'
import type { RunTarget, YamlTarget } from '@/components/chat-workbench/task-window-types'
import {
  clampCockpitRect, moveCockpitRect, resizeCockpitRect, type Viewport,
} from './geometry'
import type { CockpitRect } from '../state/cockpit-state'
import { useCockpitState } from '../state/CockpitStateProvider'
import { cn } from '@/lib/utils'

const WIN_LAYER_PRIORITY = 68
const WIN_MIN_WIDTH = 560
const WIN_MIN_HEIGHT = 360

type TwinModule = 'plan' | 'run' | 'acceptance' | 'archive' | 'yaml'

interface TwinWin {
  id: string
  module: TwinModule
  taskId: string | null
  runTarget: RunTarget | null
  yamlTarget: YamlTarget | null
  rect: CockpitRect
  z: number
}

const MODULE_META: Record<TwinModule, { emoji: string; label: string }> = {
  plan: { emoji: '▤', label: '规格' },
  run: { emoji: '⚡', label: '运行' },
  acceptance: { emoji: '✓', label: '验收' },
  archive: { emoji: '📦', label: '归档' },
  yaml: { emoji: '⚙', label: '工作流' },
}

function viewportSize(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight }
}

function defaultRect(module: TwinModule): CockpitRect {
  const vp = viewportSize()
  const widen = module === 'run' || module === 'archive'
  const w = Math.max(WIN_MIN_WIDTH, Math.min(widen ? 960 : 820, Math.round(vp.width * 0.62)))
  const h = Math.max(WIN_MIN_HEIGHT, Math.min(widen ? 620 : 560, Math.round(vp.height * 0.7)))
  // 落点：右侧偏中（不压左编队，也不盖住通讯台输入行）。
  const x = Math.max(24, Math.round(vp.width * 0.5 - w * 0.15))
  const y = Math.max(64, Math.round((vp.height - h) / 2 - 10))
  return clampCockpitRect({ x, y, w, h }, vp)
}

function idOf(spec: TaskModuleOpenSpec): string {
  const anchor = spec.runTarget?.executionId ?? spec.taskId ?? 'current'
  return `${spec.module}:${anchor}`
}

function titleOf(win: TwinWin): string {
  const meta = MODULE_META[win.module]
  if (win.module === 'yaml') {
    return `${meta.label} · ${win.yamlTarget?.workflowRef ?? win.runTarget?.workflowRef ?? '执行快照'}`
  }
  if (win.module === 'run') {
    return `${meta.label} · ${win.runTarget?.title ?? '任务当前一轮'}`
  }
  if (win.module === 'archive') {
    return `${meta.label} · 任务归档`
  }
  return `${meta.label} · 任务`
}

function coordOf(win: TwinWin): string | null {
  const src = win.runTarget ?? win.yamlTarget
  if (!src) return null
  const parts = [
    src.phaseIndex != null ? `P${src.phaseIndex}` : null,
    src.roundIndex != null ? `R${src.roundIndex}` : null,
    src.workflowRef ?? null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

// ── 任务轮询（规格 / 验收 / 运行共享；换任务清空重拉）─────────────────

function useTaskView(taskId: string | null): TaskView | null {
  const [task, setTask] = useState<TaskView | null>(null)
  useEffect(() => {
    setTask(null)
    if (!taskId) return
    let alive = true
    const load = () => {
      getTask(taskId)
        .then((next) => { if (alive) setTask(next) })
        .catch(() => { /* 保留上一份快照 */ })
    }
    load()
    const timer = window.setInterval(load, 5000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [taskId])
  return task
}

function YamlView({ target }: { target: YamlTarget | null }) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setContent(null)
    setError(null)
    if (!target) return
    let alive = true
    fetchExecutionDetail(target.workspaceId, target.executionId)
      .then((data) => { if (alive) setContent(data.workflow_content ?? '（本次执行没有 YAML 快照）') })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : String(err)) })
    return () => { alive = false }
  }, [target])
  if (error) return <div className="ck12-twin-empty">{error}</div>
  if (content == null) return <div className="ck12-twin-empty">载入执行快照…</div>
  return <pre className="ck12-twin-yaml">{content}</pre>
}

function TwinBody({ win, onOpenYaml }: { win: TwinWin; onOpenYaml: (t: YamlTarget) => void }) {
  const task = useTaskView(win.module === 'run' && win.runTarget ? null : win.taskId)
  if (win.module === 'yaml') return <YamlView target={win.yamlTarget} />
  if (win.module === 'run') {
    return (
      <RunWindow
        task={task}
        runTarget={win.runTarget}
        onOpenYaml={(target) => onOpenYaml({ ...target, from: 'run' })}
      />
    )
  }
  if (!task) return <div className="ck12-twin-empty">载入任务…</div>
  if (win.module === 'plan') return <TaskPlanWindow task={task} />
  if (win.module === 'archive') return <CockpitArchivePanel task={task} />
  return <AcceptanceWindow task={task} onMutated={() => {}} />
}

// ── 单窗壳（拖动 / 缩放 / 全屏）────────────────────────────────────

interface DragState {
  mode: 'move' | 'resize'
  pointerId: number
  startX: number
  startY: number
  rect: CockpitRect
}

function TwinWinView({
  win,
  focused,
  onFocus,
  onClose,
  onRect,
  onOpenYaml,
}: {
  win: TwinWin
  focused: boolean
  onFocus: () => void
  onClose: () => void
  onRect: (rect: CockpitRect) => void
  onOpenYaml: (t: YamlTarget) => void
}) {
  const { layer } = useCockpitState()
  const dragRef = useRef<DragState | null>(null)
  const rectRef = useRef(win.rect)
  const [maxed, setMaxed] = useState(false)
  const restoreRef = useRef<CockpitRect | null>(null)
  useEffect(() => { rectRef.current = win.rect }, [win.rect])

  useEffect(() => {
    return layer.register(`cockpit-twin-${win.id}`, WIN_LAYER_PRIORITY, onClose)
  }, [layer, win.id, onClose])

  const beginDrag = useCallback((event: ReactPointerEvent<HTMLElement>, mode: DragState['mode']) => {
    if ((event.target as HTMLElement).closest('button')) return
    if (maxed) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      mode, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, rect: rectRef.current,
    }
  }, [maxed])

  const onMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const delta = { dx: event.clientX - drag.startX, dy: event.clientY - drag.startY }
    const vp = viewportSize()
    let next = drag.mode === 'move'
      ? moveCockpitRect(drag.rect, delta, vp)
      : resizeCockpitRect(drag.rect, delta, vp)
    // 任务窗比聊天浮窗大：先把最小尺寸抬到 560×360 再夹回。
    next = clampCockpitRect(
      { ...next, w: Math.max(WIN_MIN_WIDTH, next.w), h: Math.max(WIN_MIN_HEIGHT, next.h) },
      vp,
    )
    if (window.innerWidth < WIN_MIN_WIDTH + 16) next.w = window.innerWidth - 16
    onRect(next)
  }, [onRect])

  const endDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
  }, [])

  const toggleMax = useCallback(() => {
    if (maxed) {
      const restore = restoreRef.current
      setMaxed(false)
      if (restore) onRect(restore)
      restoreRef.current = null
      return
    }
    restoreRef.current = rectRef.current
    const vp = viewportSize()
    setMaxed(true)
    onRect(clampCockpitRect({ x: 12, y: 62, w: vp.width - 24, h: vp.height - 74 }, vp))
  }, [maxed, onRect])

  const meta = MODULE_META[win.module]
  const coord = coordOf(win)

  return (
    <div
      className={cn('ck12-twin', focused && 'is-focus')}
      data-testid={`cockpit-twin-${win.module}`}
      style={{ left: win.rect.x, top: win.rect.y, width: win.rect.w, height: win.rect.h, zIndex: win.z }}
      onPointerDownCapture={onFocus}
    >
      <header
        className="ck12-twin-head"
        onPointerDown={(event) => beginDrag(event, 'move')}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest('button')) return
          toggleMax()
        }}
      >
        {/* 舱系口径：✕ 一律在容器最左。 */}
        <button
          type="button"
          className="ck12-twin-x"
          aria-label="关闭窗口"
          title="关闭（Esc）"
          onClick={onClose}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
        <span className="ck12-twin-emo" aria-hidden="true">{meta.emoji}</span>
        <span className="ck12-twin-title" title={titleOf(win)}>{titleOf(win)}</span>
        {coord && <span className="ck12-twin-coord">{coord}</span>}
        <span className="ck12-twin-sp" />
        <button
          type="button"
          className="ck12-twin-act"
          aria-label={maxed ? '还原窗口' : '全屏窗口'}
          title={maxed ? '还原' : '全屏 / 还原（双击标题栏同）'}
          onClick={toggleMax}
        >
          {maxed ? '⤡' : '⛶'}
        </button>
        <button type="button" className="ck12-twin-act is-close" aria-label="关闭" title="关闭" onClick={onClose}>
          <X className="size-3" aria-hidden="true" />
        </button>
      </header>
      <div className="ck12-twin-body">
        <TwinBody win={win} onOpenYaml={onOpenYaml} />
      </div>
      <div
        className="ck12-twin-resize"
        role="separator"
        aria-label="缩放窗口"
        onPointerDown={(event) => beginDrag(event, 'resize')}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  )
}

// ── Provider ─────────────────────────────────────────────────────────

const TwinApiContext = createContext<{ open: (spec: TaskModuleOpenSpec) => void } | null>(null)

export function CockpitTaskWindows({ children }: { children: ReactNode }) {
  const [wins, setWins] = useState<TwinWin[]>([])
  const topZ = useRef(80)

  const open = useCallback((spec: TaskModuleOpenSpec) => {
    const id = idOf(spec)
    setWins((prev) => {
      const existing = prev.find((w) => w.id === id)
      const z = ++topZ.current
      if (existing) {
        return prev.map((w) => (w.id === id
          ? {
              ...w, z,
              runTarget: spec.runTarget ?? w.runTarget,
              yamlTarget: spec.yamlTarget ?? w.yamlTarget,
            }
          : w))
      }
      const module = spec.module
      return [...prev, {
        id,
        module,
        taskId: spec.taskId ?? spec.runTarget?.taskId ?? null,
        runTarget: spec.runTarget ?? null,
        yamlTarget: spec.yamlTarget ?? null,
        rect: defaultRect(module),
        z,
      }]
    })
  }, [])

  const api = useMemo<TaskModuleSurfaceApi>(() => ({ open }), [open])

  const openYaml = useCallback((target: YamlTarget) => {
    open({ module: 'yaml', taskId: null, runTarget: null, yamlTarget: target })
  }, [open])

  const close = useCallback((id: string) => {
    setWins((prev) => prev.filter((w) => w.id !== id))
  }, [])
  const focus = useCallback((id: string) => {
    setWins((prev) => {
      const top = prev.reduce((max, w) => Math.max(max, w.z), 0)
      const hit = prev.find((w) => w.id === id)
      if (!hit || hit.z === top) return prev
      const z = ++topZ.current
      return prev.map((w) => (w.id === id ? { ...w, z } : w))
    })
  }, [])
  const setRect = useCallback((id: string, rect: CockpitRect) => {
    setWins((prev) => prev.map((w) => (w.id === id ? { ...w, rect } : w)))
  }, [])

  const focusedId = wins.length ? wins.reduce((a, b) => (a.z > b.z ? a : b)).id : null

  return (
    <TaskModuleSurfaceContext.Provider value={api}>
      <TwinApiContext.Provider value={{ open }}>
        {children}
        {wins.map((win) => (
          <TwinWinView
            key={win.id}
            win={win}
            focused={focusedId === win.id}
            onFocus={() => focus(win.id)}
            onClose={() => close(win.id)}
            onRect={(rect) => setRect(win.id, rect)}
            onOpenYaml={openYaml}
          />
        ))}
      </TwinApiContext.Provider>
    </TaskModuleSurfaceContext.Provider>
  )
}

/** 供 ChatPane 把 octopus:open-run-window / open-workflow 转成舱内浮窗。 */
export function useCockpitTaskWindows() {
  return useContext(TwinApiContext)
}
