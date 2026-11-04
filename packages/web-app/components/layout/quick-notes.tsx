'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Plus, Search, StickyNote, Trash2 } from 'lucide-react'
import { useOptionalDesktopWindows } from '@/lib/desktop-windows'
import {
  QUICK_NOTE_COLORS,
  QUICK_NOTES_DEFAULT_SIDE_WIDTH,
  QUICK_NOTES_MIN_EDITOR_WIDTH,
  QUICK_NOTES_MIN_SIDE_WIDTH,
  countNoteChars,
  createQuickNoteId,
  deriveNoteTitle,
  getQuickNotes,
  loadQuickNotesSideWidth,
  noteStampLabel,
  persistQuickNotes,
  relativeNoteTime,
  saveQuickNotesSideWidth,
  subscribeQuickNotes,
  updateQuickNotes,
  type QuickNote,
} from '@/lib/quick-notes'
import { cn } from '@/lib/utils'

const EMPTY_NOTES: QuickNote[] = []

const SAVE_DELAY = 620
const TOAST_MS = 5000
const NOTES_WINDOW_PATH = '/notes'

function getSnapshot(): QuickNote[] {
  return getQuickNotes()
}

function getServerSnapshot(): QuickNote[] {
  return EMPTY_NOTES
}

function useQuickNotes(): QuickNote[] {
  return useSyncExternalStore(subscribeQuickNotes, getSnapshot, getServerSnapshot)
}

function clampSideWidth(width: number, rowWidth: number): number {
  if (rowWidth <= 0) return Math.max(width, QUICK_NOTES_MIN_SIDE_WIDTH)
  const max = Math.max(
    QUICK_NOTES_MIN_SIDE_WIDTH,
    rowWidth - QUICK_NOTES_MIN_EDITOR_WIDTH - 7,
  )
  return Math.min(Math.max(width, QUICK_NOTES_MIN_SIDE_WIDTH), max)
}

interface DragCandidate {
  id: string
  startX: number
  startY: number
  grabX: number
  grabY: number
  rect: DOMRect
  started: boolean
}

interface GhostState {
  note: QuickNote
  left: number
  top: number
  width: number
  height: number
}

function NoteRowBody({ note, now }: { note: QuickNote; now: number }) {
  return (
    <>
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: note.color }}
      />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-pop-ink">
        {note.title.trim() || '未命名便签'}
      </span>
      <span className="shrink-0 font-mono text-[9px] text-pop-dim opacity-70">
        {relativeNoteTime(note.updatedAt, now)}
      </span>
    </>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-b-[1.5px] border-pop-bd bg-white/[0.03] px-1 py-0.5 font-mono text-[9px] leading-none text-pop-dim">
      {children}
    </kbd>
  )
}

/** 窗口标题栏上的便签数量徽标。 */
export function QuickNotesCountBadge() {
  const notes = useQuickNotes()
  return (
    <span
      data-testid="quick-notes-count"
      className="rounded-full border border-white/[0.14] px-1.5 py-px font-mono text-[10px] text-pop-dim"
    >
      {notes.length}
    </span>
  )
}

/**
 * 快速便签窗口内容。
 *
 * 便签是桌面上的一等窗口：标题栏、拖拽、四边缩放、最大化、最小化、层级都由
 * AppWindow 提供，和知识中心窗口走同一条代码路径。这里只负责「草稿纸」本身：
 * 多条便签、正文自动保存、标题自动取前 10 字、手动拖拽排序、列表栏分栏。
 */
export function QuickNotesWindow() {
  const notes = useQuickNotes()

  const [activeId, setActiveId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved')
  const [now, setNow] = useState(() => Date.now())
  const [toast, setToast] = useState<{ message: string } | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [ghost, setGhost] = useState<GhostState | null>(null)
  const [previewIds, setPreviewIds] = useState<string[] | null>(null)
  const [splitting, setSplitting] = useState(false)
  const [lineTops, setLineTops] = useState<number[]>([0])
  const [sideWidth, setSideWidth] = useState(() => loadQuickNotesSideWidth())

  const rowRef = useRef<HTMLDivElement>(null)
  const asideRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const saveTimerRef = useRef<number | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const ghostTimerRef = useRef<number | null>(null)
  const splitRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const sideWidthRef = useRef(sideWidth)
  const dragRef = useRef<DragCandidate | null>(null)
  const previewRef = useRef<string[] | null>(null)
  const suppressClickRef = useRef(false)
  const pendingDeleteRef = useRef<{ note: QuickNote; index: number } | null>(null)
  const activeIdRef = useRef<string | null>(null)

  const activeNote = useMemo(
    () => notes.find((note) => note.id === activeId) ?? null,
    [notes, activeId],
  )
  const bodyLines = useMemo(
    () => (activeNote?.body ?? '').split('\n'),
    [activeNote?.body],
  )
  const charCount = activeNote ? countNoteChars(activeNote.body) : 0

  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return notes
    return notes.filter((note) => `${note.title} ${note.body}`.toLowerCase().includes(q))
  }, [notes, query])

  const visibleNotes = useMemo(() => {
    if (!previewIds) return filteredNotes
    const byId = new Map(filteredNotes.map((note) => [note.id, note]))
    const ordered = previewIds
      .map((id) => byId.get(id))
      .filter((note): note is QuickNote => Boolean(note))
    for (const note of filteredNotes) {
      if (!previewIds.includes(note.id)) ordered.push(note)
    }
    return ordered
  }, [filteredNotes, previewIds])

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  // 列表里的相对时间（刚刚 / N分）自己往前走
  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  // 当前选中项被删掉/清空后，回落到第一条
  useEffect(() => {
    if (activeId && notes.some((note) => note.id === activeId)) return
    setActiveId(notes[0]?.id ?? null)
  }, [notes, activeId])

  const flushSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    persistQuickNotes()
    setSaveState('saved')
  }, [])

  const scheduleSave = useCallback(() => {
    setSaveState('saving')
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      persistQuickNotes()
      setSaveState('saved')
    }, SAVE_DELAY)
  }, [])

  const clearToast = useCallback(() => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current)
      toastTimerRef.current = null
    }
    pendingDeleteRef.current = null
    setToast(null)
  }, [])

  /** 空便签在切换窗口时自动丢弃，避免留下空白条目。 */
  const pruneBlank = useCallback(() => {
    const id = activeIdRef.current
    if (!id) return
    const current = getQuickNotes().find((note) => note.id === id)
    if (!current || current.title.trim() || current.body.trim()) return
    updateQuickNotes((list) => list.filter((note) => note.id !== id))
    if (pendingDeleteRef.current?.note.id === id) clearToast()
    setActiveId(getQuickNotes()[0]?.id ?? null)
  }, [clearToast])

  const focusBody = useCallback((position: number) => {
    window.requestAnimationFrame(() => {
      const element = bodyRef.current
      if (!element) return
      element.focus({ preventScroll: true })
      element.setSelectionRange(position, position)
      const gutter = gutterRef.current
      if (gutter) gutter.style.transform = `translateY(${-element.scrollTop}px)`
    })
  }, [])

  const selectNote = useCallback(
    (id: string) => {
      if (id === activeIdRef.current) return
      flushSave()
      pruneBlank()
      setActiveId(id)
      const note = getQuickNotes().find((item) => item.id === id)
      if (note) focusBody(note.body.length)
    },
    [flushSave, pruneBlank, focusBody],
  )

  const createNote = useCallback(() => {
    flushSave()
    pruneBlank()
    const list = getQuickNotes()
    const note: QuickNote = {
      id: createQuickNoteId(),
      title: '',
      body: '',
      manualTitle: false,
      color: QUICK_NOTE_COLORS[list.length % QUICK_NOTE_COLORS.length],
      updatedAt: Date.now(),
    }
    updateQuickNotes((current) => [note, ...current])
    setActiveId(note.id)
    setQuery('')
    persistQuickNotes()
    focusBody(0)
  }, [flushSave, pruneBlank, focusBody])

  const deleteNote = useCallback((id: string) => {
    const list = getQuickNotes()
    const index = list.findIndex((note) => note.id === id)
    const note = list[index]
    if (!note) return
    const next = list[index + 1] ?? list[index - 1] ?? null
    updateQuickNotes((current) => current.filter((item) => item.id !== id))
    setActiveId(next?.id ?? null)
    persistQuickNotes()

    pendingDeleteRef.current = { note, index }
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    setToast({ message: `已删除「${note.title.trim() || '未命名便签'}」` })
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null
      pendingDeleteRef.current = null
      setToast(null)
    }, TOAST_MS)
  }, [])

  const undoDelete = useCallback(() => {
    const pending = pendingDeleteRef.current
    if (!pending) return
    updateQuickNotes((list) => {
      if (list.some((note) => note.id === pending.note.id)) return list
      const next = [...list]
      next.splice(Math.min(pending.index, list.length), 0, pending.note)
      return next
    })
    setActiveId(pending.note.id)
    persistQuickNotes()
    clearToast()
  }, [clearToast])

  const updateActiveNote = useCallback((updater: (note: QuickNote) => QuickNote) => {
    const id = activeIdRef.current
    if (!id) return
    updateQuickNotes((list) => list.map((note) => (note.id === id ? updater(note) : note)))
  }, [])

  const onTitleChange = useCallback(
    (value: string) => {
      updateActiveNote((note) => {
        const derived = deriveNoteTitle(note.body)
        const manualTitle = value.trim() !== '' && value !== derived
        return {
          ...note,
          title: manualTitle ? value : derived,
          manualTitle,
          updatedAt: Date.now(),
        }
      })
      scheduleSave()
    },
    [scheduleSave, updateActiveNote],
  )

  const onBodyChange = useCallback(
    (value: string) => {
      updateActiveNote((note) => ({
        ...note,
        body: value,
        title: note.manualTitle ? note.title : deriveNoteTitle(value),
        updatedAt: Date.now(),
      }))
      scheduleSave()
    },
    [scheduleSave, updateActiveNote],
  )

  const onColorChange = useCallback(
    (color: string) => {
      updateActiveNote((note) => ({ ...note, color, updatedAt: Date.now() }))
      flushSave()
    },
    [flushSave, updateActiveNote],
  )

  /* ── 列表拖拽排序（按下即拖；浮起卡片跟随指针） ───────────────────────── */

  const finishDrag = useCallback((commit: boolean) => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag?.started) return

    if (commit && previewRef.current) {
      const ids = previewRef.current
      updateQuickNotes((list) => {
        const byId = new Map(list.map((note) => [note.id, note]))
        const ordered = ids
          .map((id) => byId.get(id))
          .filter((note): note is QuickNote => Boolean(note))
        for (const note of list) {
          if (!ids.includes(note.id)) ordered.push(note)
        }
        return ordered
      })
      persistQuickNotes()
    }

    const slot = listRef.current?.querySelector<HTMLElement>(
      `[data-note-id="${drag.id}"]`,
    )
    const ghostElement = ghostRef.current
    if (ghostElement && slot) {
      const target = slot.getBoundingClientRect()
      ghostElement.style.transition =
        'left .18s cubic-bezier(.2,.8,.2,1), top .18s cubic-bezier(.2,.8,.2,1), opacity .18s'
      ghostElement.style.left = `${target.left}px`
      ghostElement.style.top = `${target.top}px`
      ghostElement.style.opacity = '0'
      if (ghostTimerRef.current !== null) window.clearTimeout(ghostTimerRef.current)
      ghostTimerRef.current = window.setTimeout(() => {
        ghostTimerRef.current = null
        setGhost(null)
      }, 220)
    } else {
      setGhost(null)
    }

    setDraggingId(null)
    setPreviewIds(null)
    previewRef.current = null
    suppressClickRef.current = true
    window.setTimeout(() => {
      suppressClickRef.current = false
    }, 300)
  }, [])

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current
      if (drag) {
        if (!drag.started) {
          if (
            Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5
          ) {
            return
          }
          drag.started = true
          const note = getQuickNotes().find((item) => item.id === drag.id) ?? null
          const ids = getQuickNotes().map((item) => item.id)
          previewRef.current = ids
          setPreviewIds(ids)
          setDraggingId(drag.id)
          if (note) {
            setGhost({
              note,
              left: drag.rect.left,
              top: drag.rect.top,
              width: drag.rect.width,
              height: drag.rect.height,
            })
          }
        }

        const ghostElement = ghostRef.current
        if (ghostElement) {
          ghostElement.style.left = `${event.clientX - drag.grabX}px`
          ghostElement.style.top = `${event.clientY - drag.grabY}px`
        }

        const listElement = listRef.current
        if (!listElement) return

        const box = listElement.getBoundingClientRect()
        if (event.clientY < box.top + 16) listElement.scrollTop -= 10
        else if (event.clientY > box.bottom - 16) listElement.scrollTop += 10

        const rows = Array.from(
          listElement.querySelectorAll<HTMLElement>('[data-note-id]'),
        ).filter((row) => row.dataset.noteId !== drag.id)

        let beforeId: string | null = null
        for (const row of rows) {
          const rect = row.getBoundingClientRect()
          if (event.clientY < rect.top + rect.height / 2) {
            beforeId = row.dataset.noteId ?? null
            break
          }
        }

        const base = previewRef.current ?? getQuickNotes().map((item) => item.id)
        const without = base.filter((id) => id !== drag.id)
        const rawIndex = beforeId ? without.indexOf(beforeId) : without.length
        const insertAt = rawIndex < 0 ? without.length : rawIndex
        const next = [...without]
        next.splice(insertAt, 0, drag.id)
        if (next.join('|') !== base.join('|')) {
          previewRef.current = next
          setPreviewIds(next)
        }
      }
    }

    const onPointerUp = () => {
      if (dragRef.current?.started) finishDrag(true)
      else dragRef.current = null
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }, [finishDrag])

  const onRowPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, id: string) => {
      if (event.button !== 0 || query.trim()) return
      // 正在等待自动保存时，先落盘并取消回调：否则回调里的列表重建会换掉
      // 手里正在拖的 DOM 节点。
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        persistQuickNotes()
        setSaveState('saved')
      }
      const rect = event.currentTarget.getBoundingClientRect()
      dragRef.current = {
        id,
        startX: event.clientX,
        startY: event.clientY,
        grabX: event.clientX - rect.left,
        grabY: event.clientY - rect.top,
        rect,
        started: false,
      }
    },
    [query],
  )

  const onRowKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, id: string) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        selectNote(id)
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const ids = notes.map((note) => note.id)
      const index = ids.indexOf(id)
      if (index < 0) return
      event.preventDefault()
      const nextId = event.key === 'ArrowDown' ? ids[index + 1] : ids[index - 1]
      if (nextId) selectNote(nextId)
    },
    [notes, selectNote],
  )

  /* ── 列表 / 编辑区分栏 ────────────────────────────────────────────────── */

  const applySideWidth = useCallback((width: number, commit: boolean) => {
    const rowWidth = rowRef.current?.clientWidth ?? 0
    const next = Math.round(clampSideWidth(width, rowWidth))
    sideWidthRef.current = next
    if (asideRef.current) asideRef.current.style.width = `${next}px`
    if (commit) {
      setSideWidth(next)
      saveQuickNotesSideWidth(next)
    }
  }, [])

  const finishSplit = useCallback(() => {
    if (!splitRef.current) return
    splitRef.current = null
    applySideWidth(sideWidthRef.current, true)
    setSplitting(false)
  }, [applySideWidth])

  const onSplitPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    splitRef.current = { startX: event.clientX, startWidth: sideWidthRef.current }
    setSplitting(true)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer capture unavailable */
    }
  }, [])

  const onSplitPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const split = splitRef.current
      if (!split) return
      applySideWidth(split.startWidth + (event.clientX - split.startX), false)
    },
    [applySideWidth],
  )

  const onSplitPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (splitRef.current) {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch {
          /* pointer capture unavailable */
        }
      }
      finishSplit()
    },
    [finishSplit],
  )

  const resetSideWidth = useCallback(() => {
    applySideWidth(QUICK_NOTES_DEFAULT_SIDE_WIDTH, true)
  }, [applySideWidth])

  // 窗口变窄时把列表栏收回可用范围
  useEffect(() => {
    const row = rowRef.current
    if (!row || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const next = Math.round(clampSideWidth(sideWidthRef.current, row.clientWidth))
      if (next === sideWidthRef.current) return
      sideWidthRef.current = next
      setSideWidth(next)
      saveQuickNotesSideWidth(next)
    })
    observer.observe(row)
    return () => observer.disconnect()
  }, [])

  /* ── 行号 ─────────────────────────────────────────────────────────────── */

  /** 用不可见镜像量每条逻辑行（含软换行）的起始 y，行号只标逻辑行。 */
  const measureLines = useCallback(() => {
    const textarea = bodyRef.current
    const mirror = mirrorRef.current
    if (!textarea || !mirror) return
    const style = window.getComputedStyle(textarea)
    const padLeft = Number.parseFloat(style.paddingLeft) || 0
    const padRight = Number.parseFloat(style.paddingRight) || 0
    mirror.style.left = `${textarea.offsetLeft + padLeft}px`
    mirror.style.width = `${Math.max(0, textarea.clientWidth - padLeft - padRight)}px`
    const tops = Array.from(
      mirror.children,
      (child) => (child as HTMLElement).offsetTop,
    )
    setLineTops((previous) =>
      previous.length === tops.length &&
      previous.every((value, index) => value === tops[index])
        ? previous
        : tops,
    )
    const gutter = gutterRef.current
    if (gutter) gutter.style.transform = `translateY(${-textarea.scrollTop}px)`
  }, [])

  const syncGutter = useCallback(() => {
    const gutter = gutterRef.current
    const textarea = bodyRef.current
    if (gutter && textarea) {
      gutter.style.transform = `translateY(${-textarea.scrollTop}px)`
    }
  }, [])

  useLayoutEffect(() => {
    if (!activeNote) return
    measureLines()
  }, [activeNote, bodyLines, sideWidth, measureLines])

  // 窗口缩放不经过 React：直接用 ResizeObserver 重排行号
  useEffect(() => {
    const textarea = bodyRef.current
    if (!textarea || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measureLines())
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [activeNote?.id, measureLines])

  /* ── 键盘 ─────────────────────────────────────────────────────────────── */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey
      if (event.key === 'Escape') {
        // 只处理分栏拖动；关闭窗口交给桌面窗口管理器的 Esc
        if (!splitting) return
        event.preventDefault()
        event.stopPropagation()
        finishSplit()
        return
      }
      if (!meta || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'n' && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        createNote()
        return
      }
      if (key === 'f' && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (key === 'z' && pendingDeleteRef.current) {
        event.preventDefault()
        event.stopPropagation()
        undoDelete()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [createNote, finishSplit, splitting, undoDelete])

  // 窗口关闭（内容卸载）时落盘，并丢掉没写任何内容的空便签
  useEffect(() => {
    const onPageHide = () => persistQuickNotes()
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
      if (ghostTimerRef.current !== null) window.clearTimeout(ghostTimerRef.current)
      const id = activeIdRef.current
      if (id) {
        const current = getQuickNotes().find((note) => note.id === id)
        if (current && !current.title.trim() && !current.body.trim()) {
          updateQuickNotes((list) => list.filter((note) => note.id !== id))
        }
      }
      persistQuickNotes()
    }
  }, [])

  const statusLabel = saveState === 'saving'
    ? '保存中…'
    : activeNote
      ? `已保存 · ${relativeNoteTime(activeNote.updatedAt, now)}`
      : '已保存'

  const ghostPortal = ghost
    ? createPortal(
        <div
          ref={ghostRef}
          data-testid="quick-notes-drag-ghost"
          className="animate-in fade-in-0 pointer-events-none fixed z-[95] duration-150"
          style={{
            left: ghost.left,
            top: ghost.top,
            width: ghost.width,
            height: ghost.height,
          }}
        >
          <div className="flex h-full w-full scale-[1.03] rotate-[-1.5deg] items-center gap-1.5 rounded-lg border border-pop-yellow/45 bg-[#24242b] px-2 shadow-[0_22px_44px_-12px_rgba(0,0,0,.85),0_6px_16px_rgba(0,0,0,.5)]">
            <NoteRowBody note={ghost.note} now={now} />
          </div>
        </div>,
        document.body,
      )
    : null

  return (
    <div
      data-testid="quick-notes-window"
      className="relative flex h-full w-full min-h-0 min-w-0 flex-col"
    >
      <div ref={rowRef} className="flex min-h-0 flex-1">
        <aside
          ref={asideRef}
          data-testid="quick-notes-sidebar"
          className="flex min-h-0 flex-none flex-col bg-black/[0.14]"
          style={{ width: sideWidth }}
        >
          <div className="mx-2 mb-1 mt-2 flex h-7 flex-none items-center gap-1.5">
            <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-[7px] border border-transparent bg-white/[0.045] px-[7px] text-pop-dim transition-colors focus-within:border-pop-bd focus-within:bg-white/[0.06]">
              <Search className="size-3 flex-none" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索便签"
                aria-label="搜索便签"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[11.5px] text-pop-ink outline-none placeholder:text-pop-dim"
              />
              {!query && <Kbd>⌘F</Kbd>}
            </div>
            <button
              type="button"
              title="新建便签 (⌘N)"
              aria-label="新建便签"
              onClick={createNote}
              className="grid size-7 flex-none place-items-center rounded-[7px] border border-pop-yellow/25 bg-pop-yellow/[0.07] text-pop-yellow transition-colors hover:border-pop-yellow/40 hover:bg-pop-yellow/[0.14]"
            >
              <Plus className="size-[15px]" />
            </button>
          </div>
          <div
            ref={listRef}
            role="listbox"
            aria-label="便签列表"
            data-filtered={query.trim() ? 'true' : 'false'}
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2 pt-0.5 [scrollbar-color:#3a3a45_transparent] [scrollbar-width:thin]"
          >
            {visibleNotes.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] leading-relaxed text-pop-dim">
                {notes.length === 0 ? (
                  <>
                    <StickyNote className="mx-auto mb-1 size-[18px] opacity-50" />
                    暂无便签
                  </>
                ) : (
                  <>
                    <Search className="mx-auto mb-1 size-[18px] opacity-50" />
                    没有匹配的便签
                  </>
                )}
              </div>
            ) : (
              visibleNotes.map((note) => {
                const isActive = note.id === activeId
                const isDragging = note.id === draggingId
                return (
                  <div
                    key={note.id}
                    data-note-id={note.id}
                    role="option"
                    aria-selected={isActive}
                    tabIndex={0}
                    onPointerDown={(event) => onRowPointerDown(event, note.id)}
                    onClick={() => {
                      if (suppressClickRef.current) {
                        suppressClickRef.current = false
                        return
                      }
                      selectNote(note.id)
                    }}
                    onKeyDown={(event) => onRowKeyDown(event, note.id)}
                    className={cn(
                      'group relative mt-px block w-full select-none rounded-[7px] border px-2 py-2 text-left transition-colors first:mt-0 outline-none focus-visible:border-pop-yellow/30',
                      !query.trim() && 'cursor-grab active:cursor-grabbing',
                      isActive
                        ? 'border-pop-yellow/20 bg-[linear-gradient(180deg,rgba(255,200,87,.13),rgba(255,200,87,.075))]'
                        : 'border-transparent hover:bg-white/[0.045]',
                      isDragging &&
                        'border-dashed border-pop-yellow/40 bg-pop-yellow/[0.05]',
                    )}
                  >
                    <span
                      className={cn(
                        'flex items-center gap-1.5',
                        isDragging && 'opacity-0',
                      )}
                    >
                      <span
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ background: note.color }}
                      />
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-pop-ink">
                        {note.title.trim() || '未命名便签'}
                      </span>
                      <span className="shrink-0 font-mono text-[9px] text-pop-dim opacity-85 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                        {relativeNoteTime(note.updatedAt, now)}
                      </span>
                    </span>
                    {!isDragging && (
                      <button
                        type="button"
                        aria-label="删除便签"
                        title="删除"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation()
                          deleteNote(note.id)
                        }}
                        className="pointer-events-none absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-[5px] border border-transparent text-pop-dim opacity-0 transition-all hover:border-pop-red/40 hover:bg-pop-red/10 hover:text-pop-red group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 focus:pointer-events-auto focus:opacity-100"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </aside>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整列表宽度"
          title="拖动调整列表宽度 · 双击恢复默认"
          data-testid="quick-notes-divider"
          onPointerDown={onSplitPointerDown}
          onPointerMove={onSplitPointerMove}
          onPointerUp={onSplitPointerUp}
          onPointerCancel={onSplitPointerUp}
          onDoubleClick={resetSideWidth}
          className="group relative -mr-1.5 flex w-1.5 flex-none cursor-col-resize touch-none select-none items-stretch"
        >
          <span
            className={cn(
              'absolute inset-y-0 left-1/2 -translate-x-1/2 bg-white/[0.08] transition-all',
              splitting
                ? 'w-0.5 bg-pop-yellow/50'
                : 'w-px group-hover:w-0.5 group-hover:bg-pop-yellow/50',
            )}
          />
        </div>

        {activeNote ? (
          <section className="flex min-h-0 min-w-0 flex-1 flex-col px-[18px] pb-3 pt-2.5">
            <div className="-ml-3 mb-1.5 flex h-[26px] flex-none items-center gap-2">
              <StickyNote
                aria-hidden
                className="size-3.5 flex-none"
                style={{ color: activeNote.color }}
              />
              <input
                value={activeNote.title}
                onChange={(event) => onTitleChange(event.target.value)}
                placeholder="自动取内容前 10 字"
                aria-label="便签标题（自动取内容前 10 字）"
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent p-0 text-[16px] font-bold leading-[22px] tracking-[0.005em] text-pop-ink outline-none placeholder:font-bold placeholder:text-pop-dim/55"
              />
              <span className="flex-none whitespace-nowrap font-mono text-[9.5px] tracking-[0.03em] text-pop-dim">
                {noteStampLabel(activeNote.updatedAt)}
              </span>
              <div className="flex items-center gap-1.5 px-1" role="group" aria-label="便签颜色">
                {QUICK_NOTE_COLORS.map((color) => {
                  const isActive = activeNote.color === color
                  return (
                    <button
                      key={color}
                      type="button"
                      title="标签颜色"
                      aria-label={`标签颜色 ${color}`}
                      aria-pressed={isActive}
                      onClick={() => onColorChange(color)}
                      className={cn(
                        'size-[9px] rounded-full border border-white/20 transition-transform hover:scale-110',
                        isActive ? 'opacity-100' : 'opacity-55 hover:opacity-100',
                      )}
                      style={{
                        background: color,
                        boxShadow: isActive
                          ? `0 0 0 2px #1c1c22, 0 0 0 3px ${color}`
                          : undefined,
                      }}
                    />
                  )
                })}
              </div>
              <button
                type="button"
                title="删除便签"
                aria-label="删除便签"
                onClick={() => deleteNote(activeNote.id)}
                className="grid size-[22px] flex-none place-items-center rounded-md border border-transparent text-pop-dim opacity-55 transition-colors hover:border-pop-red/30 hover:bg-pop-red/[0.08] hover:text-pop-red hover:opacity-100"
              >
                <Trash2 className="size-[13px]" />
              </button>
            </div>

            <div className="relative -ml-3 flex min-h-0 flex-1 border-t border-white/[0.08]">
              <div className="relative w-5 flex-none overflow-hidden" aria-hidden>
                <div
                  ref={gutterRef}
                  data-testid="quick-notes-gutter"
                  className={cn(
                    'absolute inset-x-0 top-2 transition-opacity duration-100',
                    splitting && 'opacity-0',
                  )}
                >
                  {lineTops.map((top, index) => (
                    <span
                      key={index}
                      className="absolute left-0.5 font-mono text-[9.5px] leading-[22px] text-pop-dim/50"
                      style={{ top }}
                    >
                      {index + 1}
                    </span>
                  ))}
                </div>
              </div>
              <div
                ref={mirrorRef}
                aria-hidden
                className="invisible pointer-events-none absolute left-0 top-2 whitespace-pre-wrap break-words font-sans text-[14px] leading-[22px]"
              >
                {bodyLines.map((line, index) => (
                  <div key={index} className="min-h-[22px]">
                    {line}
                  </div>
                ))}
              </div>
              <textarea
                ref={bodyRef}
                value={activeNote.body}
                onChange={(event) => onBodyChange(event.target.value)}
                onScroll={syncGutter}
                placeholder={'写点什么…\n\n便签会自动保存，随时点开继续写。'}
                aria-label="便签内容"
                spellCheck={false}
                className="min-h-0 flex-1 resize-none bg-transparent pb-0 pl-1.5 pt-2 text-[14px] leading-[22px] text-pop-ink/90 outline-none placeholder:text-pop-dim/50 [scrollbar-color:#3a3a45_transparent] [scrollbar-width:thin]"
              />
            </div>
          </section>
        ) : (
          <section className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2.5 px-6 pb-[18px] text-center">
            <span className="grid size-[52px] place-items-center rounded-[14px] border-[1.5px] border-dashed border-pop-yellow/30 bg-pop-yellow/[0.05] text-pop-yellow/75">
              <StickyNote className="size-[22px]" />
            </span>
            <h2 className="text-[13px] font-bold text-pop-ink">还没有便签</h2>
            <p className="text-[11px] text-pop-dim">记一句待办、一个想法，随手就写。</p>
            <button
              type="button"
              onClick={createNote}
              className="mt-0.5 inline-flex items-center gap-1.5 rounded-[7px] border border-pop-yellow/30 bg-pop-yellow/10 px-3 py-1 text-[11.5px] font-semibold text-pop-yellow transition-colors hover:border-pop-yellow/50 hover:bg-pop-yellow/[0.17]"
            >
              <Plus className="size-[13px]" />
              新建便签
            </button>
          </section>
        )}
      </div>

      <div className="flex h-[34px] flex-none items-center gap-2.5 border-t border-white/[0.08] bg-black/[0.12] pl-3.5 pr-3 text-[10.5px] text-pop-dim">
        <div className="flex min-w-0 items-center gap-1.5" data-state={saveState}>
          <span
            className={cn(
              'size-1.5 flex-none rounded-full',
              saveState === 'saving'
                ? 'animate-pulse bg-pop-yellow'
                : 'bg-pop-green shadow-[0_0_6px_rgba(126,231,135,.45)]',
            )}
          />
          <span className="truncate">{statusLabel}</span>
        </div>
        <span className="flex-1" />
        <div className="hidden flex-none items-center gap-1.5 sm:flex">
          <Kbd>⌘N</Kbd>
          <span>新建</span>
          <span className="opacity-35">·</span>
          <Kbd>⌘F</Kbd>
          <span>搜索</span>
          <span className="opacity-35">·</span>
          <Kbd>Esc</Kbd>
          <span>关闭</span>
        </div>
        <span
          data-testid="quick-notes-char-count"
          title="字数（不含空白字符）"
          className="flex-none whitespace-nowrap border-l border-white/[0.14] pl-2.5 font-mono text-[9.5px] text-pop-dim"
        >
          {charCount} 字
        </span>
      </div>

      {toast && (
        <div
          role="status"
          className="animate-in fade-in-0 slide-in-from-bottom-1 absolute bottom-11 left-1/2 flex -translate-x-1/2 items-center gap-2.5 whitespace-nowrap rounded-lg border border-white/[0.14] bg-[#26262e] py-1.5 pl-3 pr-2 text-[11.5px] text-pop-ink shadow-[0_10px_26px_rgba(0,0,0,.55)] duration-150"
        >
          <span>{toast.message}</span>
          <button
            type="button"
            onClick={undoDelete}
            className="rounded-[5px] border border-pop-yellow/30 bg-pop-yellow/[0.08] px-2 py-[3px] text-[11.5px] font-semibold text-pop-yellow transition-colors hover:bg-pop-yellow/[0.16]"
          >
            撤销
          </button>
        </div>
      )}

      {ghostPortal}
    </div>
  )
}

/** header 入口：把便签作为桌面窗口打开 / 聚焦 / 收起（和知识中心窗口同一套窗口管理）。 */
export function QuickNotes() {
  const desktop = useOptionalDesktopWindows()
  const record = desktop?.state.windows.notes ?? null
  const open = record !== null
  const focused = desktop?.state.focused === 'notes'

  const toggle = useCallback(() => {
    if (!desktop) return
    if (!record) {
      desktop.navigateWindow('desktop', NOTES_WINDOW_PATH)
      return
    }
    if (!focused) {
      desktop.focusWindow('notes')
      return
    }
    desktop.closeWindow('notes')
  }, [desktop, focused, record])

  return (
    <button
      type="button"
      aria-label="快速便签"
      title="快速便签"
      aria-pressed={open}
      data-testid="quick-notes-button"
      onClick={toggle}
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-md border-[1.5px] transition-colors',
        focused
          ? 'border-pop-bd bg-pop-yellow text-pop-bg'
          : 'border-transparent text-pop-dim hover:border-pop-bd hover:bg-accent hover:text-pop-ink',
      )}
    >
      <StickyNote className="size-3.5" />
    </button>
  )
}
