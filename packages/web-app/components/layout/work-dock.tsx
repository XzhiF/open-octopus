"use client"

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Archive,
  ArrowUpRight,
  ChevronRight,
  Clock3,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useNavHistory } from "@/hooks/use-nav-history"
import { useActiveTasks } from "@/hooks/use-active-tasks"

const DOCK_WIDTH_KEY = "octopus.dock.width"
const DOCK_COLLAPSED_KEY = "octopus.dock.collapsed"
const DEFAULT_WIDTH = 240
const MIN_WIDTH = 200
const MAX_WIDTH = 360
const COLLAPSED_WIDTH = 44

const JOB_STATUS_LABEL: Record<string, string> = {
  running: "执行中",
  paused: "已暂停",
  awaiting_review: "待验收",
  archiving: "归档中",
}

const JOB_STATUS_TONE: Record<string, string> = {
  running: "bg-pop-purple-soft text-pop-purple",
  paused: "bg-pop-idle text-pop-dim",
  awaiting_review: "bg-pop-yellow-soft text-pop-amber",
  archiving: "bg-pop-amber-soft text-pop-amber",
}

function JobStatusIcon({ status }: { status: string }) {
  const Icon =
    status === "running"
      ? Play
      : status === "paused"
        ? Pause
        : status === "awaiting_review"
          ? Clock3
          : Archive
  return <Icon className="h-3 w-3 shrink-0" aria-hidden />
}

export function WorkDock() {
  const pathname = usePathname()
  const { entries, total: navTotal, remove } = useNavHistory()
  const { tasks, total: taskTotal, loading } = useActiveTasks()

  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [collapsed, setCollapsed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const widthRef = useRef(DEFAULT_WIDTH)
  const dragStartRef = useRef<{ x: number; width: number } | null>(null)

  useEffect(() => {
    try {
      const storedWidth = Number(window.localStorage.getItem(DOCK_WIDTH_KEY))
      if (
        Number.isFinite(storedWidth) &&
        storedWidth >= MIN_WIDTH &&
        storedWidth <= MAX_WIDTH
      ) {
        setWidth(storedWidth)
        widthRef.current = storedWidth
      }
      const storedCollapsed = window.localStorage.getItem(DOCK_COLLAPSED_KEY)
      if (storedCollapsed !== null) {
        setCollapsed(storedCollapsed === "1")
      } else {
        // 1024–1279 defaults to collapsed; wider desktops start expanded.
        setCollapsed(window.matchMedia("(max-width: 1279px)").matches)
      }
    } catch {
      /* storage unavailable — keep defaults */
    }
  }, [])

  useEffect(() => {
    widthRef.current = width
  }, [width])

  const toggleCollapsed = () => {
    setCollapsed((previous) => {
      const next = !previous
      try {
        window.localStorage.setItem(DOCK_COLLAPSED_KEY, next ? "1" : "0")
      } catch {
        /* storage unavailable */
      }
      return next
    })
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragStartRef.current = { x: event.clientX, width: widthRef.current }
    setDragging(true)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer capture unavailable */
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current
    if (!start) return
    const next = Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, start.width + (start.x - event.clientX)),
    )
    widthRef.current = next
    setWidth(next)
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStartRef.current) return
    dragStartRef.current = null
    setDragging(false)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer capture unavailable */
    }
    try {
      window.localStorage.setItem(DOCK_WIDTH_KEY, String(widthRef.current))
    } catch {
      /* storage unavailable */
    }
  }

  return (
    <aside
      aria-label="作业坞"
      className={cn(
        "relative hidden shrink-0 flex-col border-l-[1.5px] border-pop-bd bg-pop-paper lg:flex",
        !dragging && "transition-[width] duration-200",
      )}
      style={{ width: collapsed ? COLLAPSED_WIDTH : width }}
    >
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整作业坞宽度"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="absolute inset-y-0 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize bg-transparent transition-colors hover:bg-pop-cyan/50"
        />
      )}

      <div
        className={cn(
          "flex h-12 shrink-0 items-center border-b-[1.5px] border-pop-bd",
          collapsed ? "justify-center" : "gap-2 px-3",
        )}
      >
        {collapsed ? (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="展开作业坞"
            title="展开作业坞"
            className="grid size-8 place-items-center rounded-lg text-pop-dim transition-colors hover:bg-accent hover:text-pop-ink"
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
        ) : (
          <>
            <span className="text-[10px] font-black tracking-[0.2em] text-pop-dim">
              作业坞
            </span>
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="收起作业坞"
              title="收起作业坞"
              className="ml-auto grid size-7 place-items-center rounded-lg text-pop-dim transition-colors hover:bg-accent hover:text-pop-ink"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      {collapsed ? (
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex flex-1 flex-col items-center gap-2 py-4 text-pop-dim transition-colors hover:bg-accent hover:text-pop-ink"
          title="展开作业坞"
        >
          <span className="text-[10px] font-black tracking-[0.2em] [writing-mode:vertical-rl]">
            作业坞
          </span>
          {taskTotal > 0 && (
            <span className="rounded-full bg-pop-purple-soft px-1.5 py-0.5 font-mono text-[9px] text-pop-purple">
              {taskTotal}
            </span>
          )}
        </button>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <section className="border-b-[1.5px] border-pop-bd px-3 py-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-black tracking-[0.2em] text-pop-dim">
                导航
              </span>
              <span className="font-mono text-[10px] text-pop-dim">{navTotal}</span>
            </div>
            {entries.length === 0 ? (
              <p className="px-1 py-2 text-[11px] text-pop-dim">暂无导航记录</p>
            ) : (
              <div className="space-y-1">
                {entries.map((entry) => {
                  const active = pathname === entry.href
                  return (
                    <div
                      key={entry.href}
                      className="group flex items-center gap-1 rounded-lg hover:bg-accent"
                    >
                      <Link
                        href={entry.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5",
                          active && "bg-pop-purple-soft",
                        )}
                      >
                        <span
                          className={cn(
                            "grid size-6 shrink-0 place-items-center rounded-md border-[1.5px] border-pop-bd",
                            active
                              ? "bg-pop-yellow text-pop-bg"
                              : "bg-pop-idle text-pop-dim",
                          )}
                        >
                          <ChevronRight className="h-3 w-3" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-bold text-pop-ink">
                            {entry.label}
                          </span>
                          <span className="block truncate font-mono text-[9px] text-pop-dim">
                            {entry.sub}
                          </span>
                        </span>
                      </Link>
                      <button
                        type="button"
                        onClick={() => remove(entry.href)}
                        aria-label={`移除导航 ${entry.label}`}
                        title="移除"
                        className="mr-1 grid size-5 shrink-0 place-items-center rounded text-pop-dim opacity-0 transition-opacity hover:bg-pop-idle hover:text-pop-ink group-hover:opacity-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section className="px-3 py-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-black tracking-[0.2em] text-pop-dim">
                作业
              </span>
              <span className="font-mono text-[10px] text-pop-dim">{taskTotal}</span>
            </div>
            {loading ? (
              <p className="px-1 py-2 text-[11px] text-pop-dim">加载中…</p>
            ) : tasks.length === 0 ? (
              <div className="px-1 py-2">
                <p className="text-[11px] text-pop-dim">暂无活跃作业</p>
                <Link
                  href="/tasks"
                  className="mt-1 inline-flex items-center gap-1 text-[11px] font-bold text-pop-cyan hover:underline"
                >
                  去任务看板
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            ) : (
              <div className="space-y-1">
                {tasks.map((task) => {
                  const tone =
                    JOB_STATUS_TONE[task.status] ?? "bg-pop-idle text-pop-dim"
                  const label = JOB_STATUS_LABEL[task.status] ?? task.status
                  return (
                    <Link
                      key={task.id}
                      href={`/tasks?task=${encodeURIComponent(task.id)}`}
                      className="group flex flex-col gap-1 rounded-lg border-[1.5px] border-transparent px-2 py-1.5 transition-colors hover:border-pop-bd hover:bg-accent"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <JobStatusIcon status={task.status} />
                        <span className="min-w-0 flex-1 truncate text-xs font-bold text-pop-ink">
                          {task.name}
                        </span>
                        <ArrowUpRight className="h-3 w-3 shrink-0 text-pop-dim opacity-0 transition-opacity group-hover:opacity-100" />
                      </span>
                      <span className="flex min-w-0 items-center gap-2 pl-5">
                        <span
                          className={cn(
                            "shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[9px] font-black",
                            tone,
                          )}
                        >
                          {label}
                        </span>
                        <span className="min-w-0 truncate font-mono text-[9px] text-pop-dim">
                          {task.id}
                        </span>
                      </span>
                    </Link>
                  )
                })}
                {taskTotal > tasks.length && (
                  <Link
                    href="/tasks"
                    className="flex items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-[10px] font-bold text-pop-dim hover:bg-accent hover:text-pop-ink"
                  >
                    查看全部 {taskTotal} 项
                    <ArrowUpRight className="h-3 w-3" />
                  </Link>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </aside>
  )
}
