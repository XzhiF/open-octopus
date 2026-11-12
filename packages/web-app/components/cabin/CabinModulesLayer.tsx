'use client'

// 舱浮窗层 P3（原型 win-layer / openWin / drag+resize 全几何）：
// 级联居中落位、标题栏拖拽、右下 resize、max/min/close、焦点序 z。
// 灯组居左、标题居中（含舱名）、body 16px 内边距 —— 逐字对照原型 .win chrome。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { LayoutGrid, Maximize2, Minus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCabinContext } from './cabin-provider'
import { CABIN_MODULE_PHASE, CABIN_WIN_TITLE } from './cabin-meta'
import { CabinOverview } from './CabinOverview'
import { CabinQueue } from './modules/CabinQueue'
import { CabinRepos } from './modules/CabinRepos'
import { CabinWorktrees } from './modules/CabinWorktrees'
import { CabinIterations } from './modules/CabinIterations'
import { CabinTasks } from './modules/CabinTasks'
import { CabinJobs } from './modules/CabinJobs'
import { CabinTrace } from './modules/CabinTrace'
import { CabinRun } from './modules/CabinRun'
import { CabinChanges } from './modules/CabinChanges'
import { CabinAcceptance } from './modules/CabinAcceptance'
import { CabinKnowledge } from './modules/CabinKnowledge'
import { CabinUsage } from './modules/CabinUsage'
import { CabinMissions } from './modules/CabinMissions'
import { CabinTuning } from './modules/CabinTuning'
import { CabinGallery } from './modules/CabinGallery'
import { CabinArchive } from './modules/CabinArchive'

function ModuleBody({ id, onNewTask }: { id: string; onNewTask?: () => void }) {
  switch (id) {
    case 'overview': return <CabinOverview />
    case 'queue': return <CabinQueue />
    case 'repos': return <CabinRepos />
    case 'worktree': return <CabinWorktrees />
    case 'iterations': return <CabinIterations />
    case 'tasks': return <CabinTasks onNewTask={onNewTask} />
    case 'jobs': return <CabinJobs />
    case 'trace': return <CabinTrace />
    case 'run': return <CabinRun />
    case 'changes': return <CabinChanges />
    case 'acceptance': return <CabinAcceptance />
    case 'knowledge': return <CabinKnowledge />
    case 'usage': return <CabinUsage />
    case 'missions': return <CabinMissions />
    case 'tuning': return <CabinTuning />
    case 'gallery': return <CabinGallery />
    case 'archive': return <CabinArchive />
    default:
      return (
        <div className="grid h-full min-h-40 place-items-center text-center" data-testid="cabin-module-placeholder">
          <div>
            <div className="text-[13px] font-bold text-pop-ink">{CABIN_WIN_TITLE[id] ?? id}</div>
            <div className="mt-1 text-[11.5px] text-pop-dim">
              该模块将在 {CABIN_MODULE_PHASE[id] ?? '后续阶段'} 上线 · 现在可以直接在主对话里吩咐调度者
            </div>
          </div>
        </div>
      )
  }
}

interface DragState {
  id: string
  mode: 'move' | 'resize'
  sx: number
  sy: number
  ox: number
  oy: number
}

export function CabinModulesLayer({ onNewTask }: { onNewTask?: () => void }) {
  const {
    cabin, openWindows, windows, focusedWindow,
    closeModule, minimizeModule, focusModule, toggleMaxModule,
    placeModule, moveModule, resizeModule,
  } = useCabinContext()
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const dragRef = useRef<DragState | null>(null)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // 首帧落位（原型 openWin：居中 + 级联偏移，尺寸不超过容器-40）。
  useLayoutEffect(() => {
    if (size.width === 0) return
    openWindows.forEach((id, n) => {
      const w = windows[id]
      if (!w || w.placed) return
      const cw = Math.min(w.w, size.width - 40)
      const ch = Math.min(w.h, size.height - 40)
      const x = Math.max(20, (size.width - cw) / 2 + (n % 5) * 24)
      const y = Math.max(16, (size.height - ch) / 2 + (n % 5) * 20)
      if (cw !== w.w || ch !== w.h) resizeModule(id, cw, ch)
      placeModule(id, x, y)
    })
  }, [openWindows, windows, size, placeModule, resizeModule])

  const onBarPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return
    const w = windows[id]
    if (!w || w.max) return
    focusModule(id)
    dragRef.current = { id, mode: 'move', sx: e.clientX, sy: e.clientY, ox: w.x, oy: w.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }, [windows, focusModule])

  const onResizePointerDown = useCallback((e: React.PointerEvent, id: string) => {
    const w = windows[id]
    if (!w) return
    focusModule(id)
    dragRef.current = { id, mode: 'resize', sx: e.clientX, sy: e.clientY, ox: w.w, oy: w.h }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
    e.stopPropagation()
  }, [windows, focusModule])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.mode === 'resize') {
      resizeModule(drag.id, drag.ox + e.clientX - drag.sx, drag.oy + e.clientY - drag.sy)
    } else {
      moveModule(drag.id, drag.ox + e.clientX - drag.sx, Math.max(0, drag.oy + e.clientY - drag.sy))
    }
  }, [moveModule, resizeModule])

  const onPointerUp = useCallback(() => { dragRef.current = null }, [])

  const visible = openWindows.filter((id) => windows[id] && !windows[id].min)
  if (!cabin) return null

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 z-40" data-testid="cabin-win-layer">
      {visible.map((id, index) => {
        const w = windows[id]
        const focused = focusedWindow === id
        const rect = w.max
          ? { left: 0, top: 0, width: '100%', height: '100%' }
          : { left: w.x, top: w.y, width: w.w, height: w.h }
        return (
          <div
            key={id}
            data-testid="cabin-window"
            data-win={id}
            data-focused={focused ? 'true' : undefined}
            onPointerDownCapture={() => { if (!focused) focusModule(id) }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            className={cn(
              'pointer-events-auto absolute flex flex-col overflow-hidden rounded-[14px] border-[1.5px] border-pop-bd bg-pop-paper',
              focused ? 'shadow-pop-lg' : 'shadow-pop',
            )}
            style={{ ...rect, zIndex: 20 + index }}
          >
            <div
              className={cn(
                'relative flex h-9 shrink-0 cursor-grab items-center border-b-[1.5px] border-pop-bd active:cursor-grabbing',
                focused ? 'bg-pop-paper' : 'bg-pop-idle',
              )}
              onPointerDown={(e) => onBarPointerDown(e, id)}
            >
              <div className="group/lights flex h-full items-center gap-2 pl-3 pr-2" data-no-drag>
                <button
                  type="button"
                  aria-label={`关闭${CABIN_WIN_TITLE[id] ?? id}`}
                  data-testid={`cabin-win-close-${id}`}
                  onClick={() => closeModule(id)}
                  className={cn(
                    'grid size-3 place-items-center rounded-full border border-pop-bd transition-colors',
                    focused ? 'border-transparent bg-pop-red' : 'bg-pop-idle hover:bg-pop-red/70',
                  )}
                >
                  <X className="size-2 text-pop-bg opacity-0 transition-opacity group-hover/lights:opacity-80" />
                </button>
                <button
                  type="button"
                  aria-label={`最小化${CABIN_WIN_TITLE[id] ?? id}`}
                  data-testid={`cabin-win-min-${id}`}
                  onClick={() => minimizeModule(id)}
                  className={cn(
                    'grid size-3 place-items-center rounded-full border border-pop-bd transition-colors',
                    focused ? 'border-transparent bg-pop-amber' : 'bg-pop-idle hover:bg-pop-amber/70',
                  )}
                >
                  <Minus className="size-2 text-pop-bg opacity-0 transition-opacity group-hover/lights:opacity-80" />
                </button>
                <button
                  type="button"
                  aria-label={`${w.max ? '还原' : '最大化'}${CABIN_WIN_TITLE[id] ?? id}`}
                  data-testid={`cabin-win-max-${id}`}
                  onClick={() => toggleMaxModule(id)}
                  className={cn(
                    'grid size-3 place-items-center rounded-full border border-pop-bd transition-colors',
                    focused ? 'border-transparent bg-pop-green' : 'bg-pop-idle hover:bg-pop-green/70',
                  )}
                >
                  <Maximize2 className="size-2 text-pop-bg opacity-0 transition-opacity group-hover/lights:opacity-80" />
                </button>
              </div>
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5 px-16">
                <b className={cn('truncate text-[11px] font-bold', focused ? 'text-pop-ink' : 'text-pop-dim')}>
                  {CABIN_WIN_TITLE[id] ?? id} · {cabin.name}
                </b>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid={`cabin-win-body-${id}`}>
              <ModuleBody id={id} onNewTask={onNewTask} />
            </div>
            {!w.max && (
              <div
                data-testid={`cabin-win-resize-${id}`}
                onPointerDown={(e) => onResizePointerDown(e, id)}
                className="absolute bottom-0 right-0 z-5 size-4 cursor-nwse-resize after:absolute after:bottom-1 after:right-1 after:size-[7px] after:border-b-[1.5px] after:border-r-[1.5px] after:border-pop-dim after:opacity-50"
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 顶栏 winstrip（原型 renderWinstrip）：打开的舱窗图标条，最小化带角标。 */
export function CabinWinstrip() {
  const { openWindows, windows, focusedWindow, openModule } = useCabinContext()
  if (openWindows.length === 0) return null
  return (
    <div className="flex items-center gap-0.5" data-testid="cabin-winstrip">
      {openWindows.map((id) => {
        const w = windows[id]
        if (!w) return null
        const active = focusedWindow === id && !w.min
        return (
          <button
            key={id}
            type="button"
            data-winstrip={id}
            title={CABIN_WIN_TITLE[id] ?? id}
            aria-label={w.min ? `${CABIN_WIN_TITLE[id]}（已最小化）` : CABIN_WIN_TITLE[id]}
            onClick={() => openModule(id)}
            className={cn(
              'relative grid size-6 shrink-0 place-items-center rounded-md transition-colors',
              active ? 'bg-pop-yellow text-pop-bg' : 'text-pop-dim hover:bg-white/[0.07] hover:text-pop-ink',
            )}
          >
            <LayoutGrid className="size-3.5" />
            {w.min && <span className="absolute bottom-0.5 right-1 size-1 rounded-full bg-pop-amber" />}
          </button>
        )
      })}
    </div>
  )
}
