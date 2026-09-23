"use client"

// Workspace 列表正式布局：纵向状态带（进行中/未开始/异常/完成/归档）。
// 布局样式在 app/ws-bands.css（.wsb-*）。

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Search } from "lucide-react"
import type { Workspace } from "@/lib/types"
import { formatRelativeTime } from "@/lib/format"

type BandKey = "running" | "idle" | "error" | "done" | "archive"

interface BandMeta {
  key: BandKey
  title: string
  desc: string
  paginated?: boolean
  per?: number
  defaultCollapsed?: boolean
}

const BANDS: BandMeta[] = [
  { key: "running", title: "进行中", desc: "正在跑执行的空间", defaultCollapsed: false },
  { key: "idle", title: "未开始", desc: "活跃但当前无执行", defaultCollapsed: false },
  { key: "error", title: "异常", desc: "status=error · 空则整条隐藏", defaultCollapsed: false },
  { key: "done", title: "完成", desc: "task 结束待归档", paginated: true, per: 6, defaultCollapsed: false },
  { key: "archive", title: "归档", desc: "冷存 · 单行紧凑", paginated: true, per: 8, defaultCollapsed: true },
]

type WireWs = Workspace & Record<string, unknown>

export const isTaskWs = (ws: Workspace) =>
  (ws as WireWs).source === "task" || ws.name.startsWith("task:") || ws.name.startsWith("task-")

export const isArchivedWs = (ws: Workspace) =>
  (ws as WireWs).archive_status === "archived"

export function bandOf(ws: Workspace): BandKey {
  if (isArchivedWs(ws)) return "archive"
  if (ws.status === "error") return "error"
  if ((ws.running_count ?? 0) > 0) return "running"
  if (isTaskWs(ws)) return "done"
  return "idle"
}

const updatedOf = (ws: Workspace) => String((ws as WireWs).updated_at ?? ws.updatedAt ?? "")
const whenOf = (ws: Workspace) =>
  formatRelativeTime(ws.lastActivityAt ?? updatedOf(ws) ?? ws.createdAt)

interface WorkspaceBandsProps {
  workspaces: Workspace[]
  onNew: () => void
  onDelete: (id: string) => void
  onArchive: (id: string) => void
  onViewArchive: (id: string) => void
}

interface GenieTarget {
  ws: Workspace
  rect: DOMRect
}

export function WorkspaceBands({ workspaces, onNew, onDelete, onArchive, onViewArchive }: WorkspaceBandsProps) {
  const [search, setSearch] = useState("")
  const [collapsed, setCollapsed] = useState<Record<BandKey, boolean>>(
    () => Object.fromEntries(BANDS.map((b) => [b.key, !!b.defaultCollapsed])) as Record<BandKey, boolean>,
  )
  const [page, setPage] = useState<Record<"done" | "archive", number>>({ done: 1, archive: 1 })
  const [genie, setGenie] = useState<GenieTarget | null>(null)

  const q = search.trim().toLowerCase()
  const matched = useMemo(() => {
    const list = workspaces.filter(
      (ws) =>
        !q ||
        (ws.name ?? "").toLowerCase().includes(q) ||
        (ws.org ?? "").toLowerCase().includes(q) ||
        (ws.description ?? "").toLowerCase().includes(q),
    )
    return [...list].sort((a, b) => updatedOf(b).localeCompare(updatedOf(a)))
  }, [workspaces, q])

  const bandTotals = useMemo(() => {
    const totals = { running: 0, idle: 0, error: 0, done: 0, archive: 0 } as Record<BandKey, number>
    for (const ws of workspaces) totals[bandOf(ws)] += 1
    return totals
  }, [workspaces])

  const toggleBand = (key: BandKey) => setCollapsed((c) => ({ ...c, [key]: !c[key] }))
  const setAllCollapsed = (v: boolean) =>
    setCollapsed(Object.fromEntries(BANDS.map((b) => [b.key, v])) as Record<BandKey, boolean>)

  const openGenie = (ws: Workspace, el: HTMLElement) => setGenie({ ws, rect: el.getBoundingClientRect() })

  return (
    <div data-testid="workspace-list">
      <div className="wsb-top">
        <h1>工作空间</h1>
        <span className="wsb-count">{matched.length} / {workspaces.length}</span>
        <div className="wsb-search">
          <Search className="wsb-search-icon" />
          <input
            placeholder="搜索名称 / 组织 / 描述…"
            aria-label="搜索工作空间"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button type="button" className="wsb-btn wsb-btn-ghost" onClick={() => setAllCollapsed(false)}>
          全部展开
        </button>
        <button type="button" className="wsb-btn wsb-btn-ghost" onClick={() => setAllCollapsed(true)}>
          全部收起
        </button>
        <button type="button" className="wsb-btn wsb-btn-primary" onClick={onNew} data-testid="btn-create-workspace">
          + 新建
        </button>
      </div>

      {workspaces.length === 0 ? (
        <div className="wsb-empty" style={{ padding: 32 }}>
          还没有工作空间 — 点右上角「+ 新建」创建第一个
        </div>
      ) : (
        <div className="wsb-bands">
          {BANDS.map((b) => {
            // 空带整条隐藏（含「异常为空不显示」规则）
            if (bandTotals[b.key] === 0) return null
            const items = matched.filter((ws) => bandOf(ws) === b.key)
            const isPag = !!b.paginated
            const pages = isPag ? Math.max(1, Math.ceil(items.length / (b.per ?? 6))) : 1
            const cur = isPag ? Math.min(page[b.key as "done" | "archive"], pages) : 1
            const slice = isPag
              ? items.slice((cur - 1) * (b.per ?? 6), cur * (b.per ?? 6))
              : items
            const isCollapsed = collapsed[b.key]

            return (
              <section key={b.key} className="wsb-band" data-band={b.key} data-collapsed={isCollapsed}>
                <div className="wsb-band-header" onClick={() => toggleBand(b.key)}>
                  <span className="wsb-dot" />
                  <span className="wsb-title">{b.title}</span>
                  <span className="wsb-badge">{items.length}</span>
                  <span className="wsb-band-desc">· {b.desc}</span>
                  <span className="wsb-quick">{isCollapsed ? "展开" : "收起"}</span>
                  <span className="wsb-chev">▾</span>
                </div>
                <div className="wsb-band-body">
                  <div className="wsb-band-wrap">
                    <div className="wsb-band-inner">
                      {slice.length === 0 ? (
                        <div className="wsb-empty">该分区暂无匹配</div>
                      ) : (
                        <div className="wsb-grid">
                          {slice.map((ws) => (
                            <BandCard
                              key={ws.id}
                              band={b.key}
                              ws={ws}
                              onOpen={(el) => openGenie(ws, el)}
                              onViewArchive={onViewArchive}
                            />
                          ))}
                        </div>
                      )}
                      {isPag && pages > 1 && !isCollapsed && (
                        <Pager
                          page={cur}
                          pages={pages}
                          total={items.length}
                          title={b.title}
                          onGo={(n) => setPage((p) => ({ ...p, [b.key]: n }))}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </section>
            )
          })}
        </div>
      )}

      {genie && (
        <GenieModal
          ws={genie.ws}
          rect={genie.rect}
          onClose={() => setGenie(null)}
          onArchive={(id) => { setGenie(null); onArchive(id) }}
          onDelete={(id) => { setGenie(null); onDelete(id) }}
          onViewArchive={(id) => { setGenie(null); onViewArchive(id) }}
        />
      )}
    </div>
  )
}

/* ---------------- cards: 每条带结构不同 ---------------- */

function BandCard({
  band,
  ws,
  onOpen,
  onViewArchive,
}: {
  band: BandKey
  ws: Workspace
  onOpen: (el: HTMLElement) => void
  onViewArchive: (id: string) => void
}) {
  const running = ws.running_count ?? 0
  const enter =
    band === "archive" ? (
      <button
        type="button"
        className="wsb-enter"
        onClick={(e) => { e.stopPropagation(); onViewArchive(ws.id) }}
      >
        查看 →
      </button>
    ) : (
      <Link
        className="wsb-enter"
        href={`/workspaces/${ws.id}`}
        onClick={(e) => e.stopPropagation()}
        data-testid="workspace-action-enter"
      >
        {band === "error" ? "查看 →" : "进入 →"}
      </Link>
    )

  const body = (() => {
    switch (band) {
      case "running":
        return (
          <>
            <div className="wsb-name">
              <span className="wsb-spark" />
              <span className="wsb-txt">{ws.name}</span>
              {isTaskWs(ws) && <span className="wsb-tag">task</span>}
            </div>
            <div className="wsb-desc">{ws.description || "—"}</div>
            <div className="wsb-live"><i /></div>
            <div className="wsb-live-label">{running} 个工作流正在跑</div>
            <div className="wsb-row">
              <span className="wsb-k">{ws.org}</span>
              <span className="wsb-sep">·</span>
              <span>{whenOf(ws)}</span>
              <span style={{ marginLeft: "auto" }}>{enter}</span>
            </div>
          </>
        )
      case "idle":
        return (
          <>
            <span className="wsb-ready">READY</span>
            <div className="wsb-name">
              <span className="wsb-txt">{ws.name}</span>
              {isTaskWs(ws) && <span className="wsb-tag">task</span>}
            </div>
            <div className="wsb-desc">{ws.description || "—"}</div>
            <div className="wsb-row">
              <span className="wsb-k">{ws.org}</span>
              <span className="wsb-sep">·</span>
              <span>{whenOf(ws)}</span>
              <span style={{ marginLeft: "auto" }}>{enter}</span>
            </div>
          </>
        )
      case "error":
        return (
          <>
            <div className="wsb-name">
              <span className="wsb-warn">⚠</span>
              <span className="wsb-txt">{ws.name}</span>
              <span className="wsb-err-pill">error</span>
            </div>
            <div className="wsb-desc">{ws.description || "—"}</div>
            <div className="wsb-snippet">{ws.path}</div>
            <div className="wsb-row">
              <span className="wsb-k">{ws.org}</span>
              <span className="wsb-sep">·</span>
              <span>{whenOf(ws)}</span>
              <span style={{ marginLeft: "auto" }}>{enter}</span>
            </div>
          </>
        )
      case "done":
        return (
          <>
            <span className="wsb-stamp">✔</span>
            <div className="wsb-name">
              <span className="wsb-check">✓</span>
              <span className="wsb-txt">{ws.name}</span>
              {isTaskWs(ws) && <span className="wsb-tag">task</span>}
            </div>
            <div className="wsb-row">
              <span className="wsb-k">{ws.org}</span>
              <span className="wsb-sep">·</span>
              <span>{whenOf(ws)}</span>
            </div>
            <div className="wsb-row">
              <span style={{ marginLeft: "auto" }}>{enter}</span>
            </div>
          </>
        )
      case "archive":
        return (
          <>
            <span className="wsb-ice">❄</span>
            <div className="wsb-name" style={{ minWidth: 0, flex: 1 }}>
              <span className="wsb-txt">{ws.name}</span>
            </div>
            <span className="wsb-cold">COLD</span>
            <span className="wsb-time">{whenOf(ws)}</span>
            {enter}
          </>
        )
    }
  })()

  return (
    <article
      className="wsb-card"
      data-ws-id={ws.id}
      data-testid="workspace-card"
      onClick={(e) => onOpen(e.currentTarget)}
    >
      {body}
    </article>
  )
}

/* ---------------- pager ---------------- */

function Pager({
  page,
  pages,
  total,
  title,
  onGo,
}: {
  page: number
  pages: number
  total: number
  title: string
  onGo: (n: number) => void
}) {
  const nums: (number | "gap")[] = []
  const lo = Math.max(1, page - 2)
  const hi = Math.min(pages, page + 2)
  if (lo > 1) nums.push(1)
  if (lo > 2) nums.push("gap")
  for (let n = lo; n <= hi; n++) nums.push(n)
  if (hi < pages - 1) nums.push("gap")
  if (hi < pages) nums.push(pages)

  return (
    <div className="wsb-pager">
      <button type="button" className="wsb-p" disabled={page === 1} onClick={() => onGo(page - 1)}>‹</button>
      {nums.map((n, i) =>
        typeof n === "number" ? (
          <button
            key={i}
            type="button"
            className={n === page ? "wsb-p wsb-p-cur" : "wsb-p"}
            onClick={() => onGo(n)}
          >
            {n}
          </button>
        ) : (
          <span key={i}>…</span>
        ),
      )}
      <button type="button" className="wsb-p" disabled={page === pages} onClick={() => onGo(page + 1)}>›</button>
      <span style={{ marginLeft: 6 }}>/ {total} 条 · {title}</span>
    </div>
  )
}

/* ---------------- genie modal（macOS 式缩放打开，浅色磨砂遮罩） ---------------- */

const BAND_LABEL: Record<BandKey, string> = {
  running: "进行中",
  idle: "未开始",
  error: "异常",
  done: "完成",
  archive: "归档",
}

function GenieModal({
  ws,
  rect,
  onClose,
  onArchive,
  onDelete,
  onViewArchive,
}: {
  ws: Workspace
  rect: DOMRect
  onClose: () => void
  onArchive: (id: string) => void
  onDelete: (id: string) => void
  onViewArchive: (id: string) => void
}) {
  const [entered, setEntered] = useState(false)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const close = () => {
    if (closing) return
    setClosing(true)
    setTimeout(onClose, 250)
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") close() }
    window.addEventListener("keydown", h)
    return () => window.removeEventListener("keydown", h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const band = bandOf(ws)
  const shown = entered && !closing
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const scale = shown ? 1 : closing ? 0.7 : 0.22

  return (
    <>
      <div
        className={"wsb-scrim" + (shown ? " wsb-scrim-on" : "")}
        onClick={close}
      />
      <div
        className="wsb-genie"
        role="dialog"
        aria-modal="true"
        aria-label={ws.name}
        style={{
          left: shown ? "50%" : cx,
          top: shown ? "50%" : cy,
          transform: `translate(-50%, -50%) scale(${scale})`,
          opacity: shown ? 1 : 0,
        }}
      >
        <button type="button" className="wsb-genie-close" onClick={close} aria-label="关闭">×</button>
        <div className="wsb-genie-head">📁 {ws.name}</div>
        <div className="wsb-genie-body">
          <div className="wsb-kv">
            <span className="wsb-kv-k">组织</span><span className="wsb-kv-v">{ws.org}</span>
            <span className="wsb-kv-k">状态</span><span className="wsb-kv-v">{BAND_LABEL[band]}</span>
            <span className="wsb-kv-k">类型</span><span className="wsb-kv-v">{isTaskWs(ws) ? "task-mode" : "user"}</span>
            <span className="wsb-kv-k">项目 / 工作流</span><span className="wsb-kv-v">{ws.projectCount ?? 0} / {ws.workflowCount ?? 0}</span>
            <span className="wsb-kv-k">路径</span><span className="wsb-kv-v"><code>{ws.path}</code></span>
            <span className="wsb-kv-k">最近</span><span className="wsb-kv-v">{whenOf(ws)}</span>
          </div>
          <p>{ws.description || "—"}</p>
          <div className="wsb-genie-actions">
            {band === "archive" ? (
              <button type="button" className="wsb-btn" onClick={() => onViewArchive(ws.id)}>查看归档</button>
            ) : (
              <Link className="wsb-btn wsb-btn-primary" href={`/workspaces/${ws.id}`}>进入 →</Link>
            )}
            {band !== "archive" && (
              <>
                <button type="button" className="wsb-btn" onClick={() => onArchive(ws.id)}>归档</button>
                <button type="button" className="wsb-btn" style={{ color: "var(--pop-red)", borderColor: "var(--pop-red)" }} onClick={() => onDelete(ws.id)}>删除</button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
