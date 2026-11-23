'use client'

// 便签窗（2026-11-23 用户 #3）：classic 快速便签迁入全舱。
//
//   · 数据层复用 lib/quick-notes（localStorage octopus.quick-notes.v1）——
//     与 classic 的快速便签是同一份内容，两个壳打开看到同一批便签。
//   · 壳 = 目录窗 / 文档窗同一套（.ck12-treewin）：✕ 左置、玻璃底、顶部渐变发丝线、
//     标题栏可拖、双击 / ⛶ 全屏；Esc 走层栈（67：先收便签，再收 dossier）。
//   · 左列表（搜索 / ＋新建 / 删除 5s 撤销）+ 右草稿纸（正文首行前 10 字自动标题、
//     5 色标签、620ms 自动保存、字数）。本地草稿纸，不进入任务 / 知识数据域。
//   · 入口 = HUD 最右「✎ 便签」，带条数徽标；⌘N 新建 / ⌘F 搜索 / ⌘Z 撤销删除。

import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react'
import { cabinAudio } from '@/lib/cabin-audio'
import {
  QUICK_NOTE_COLORS, countNoteChars, createQuickNoteId, deriveNoteTitle,
  getQuickNotes, noteStampLabel, persistQuickNotes, relativeNoteTime,
  subscribeQuickNotes, updateQuickNotes, type QuickNote,
} from '@/lib/quick-notes'
import { useCockpitState } from '../state/CockpitStateProvider'
import { CockpitFaceHead } from '../face/CockpitFaceHead'
import { DossierWindowContext, type DossierWindowApi } from '../face/dossier-window'
import { setCockpitNotesOpen, useCockpitNotesOpen } from './notes-store'

const NOTES_LAYER_ID = 'cockpit-notes'
/** 高于 dossier（65）/ 目录窗（68）之下：Esc 先收目录 / 文档窗，再收便签。 */
const NOTES_LAYER_PRIORITY = 67

const SAVE_DELAY = 620
const UNDO_MS = 5000

const EMPTY_NOTES: QuickNote[] = []
function getServerSnapshot(): QuickNote[] {
  return EMPTY_NOTES
}

interface NotesGeo {
  x: number
  y: number
  w: number
  h: number
}
/** 原型 state.notesGeo / notesMax：会话内保留，关掉再开仍回上次几何。 */
let savedGeo: NotesGeo | null = null
let savedMax = false

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

function noteLabel(note: QuickNote): string {
  return note.title.trim() || '未命名便签'
}

export function CockpitNotesWindow() {
  const { layer } = useCockpitState()
  const open = useCockpitNotesOpen()
  const notes = useSyncExternalStore(subscribeQuickNotes, getQuickNotes, getServerSnapshot)

  const [activeId, setActiveId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved')
  const [pending, setPending] = useState<{ note: QuickNote; index: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const [geo, setGeo] = useState<NotesGeo | null>(savedGeo)
  const [maxed, setMaxed] = useState(savedMax)
  const [viewport, setViewport] = useState(() => ({
    w: typeof window === 'undefined' ? 1600 : window.innerWidth,
    h: typeof window === 'undefined' ? 900 : window.innerHeight,
  }))

  const winRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const undoTimerRef = useRef<number | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const pendingRef = useRef<{ note: QuickNote; index: number } | null>(null)
  const wasOpenRef = useRef(false)
  const dragCleanupRef = useRef<(() => void) | null>(null)

  const activeNote = useMemo(
    () => notes.find((note) => note.id === activeId) ?? null,
    [notes, activeId],
  )

  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return notes
    return notes.filter((note) => `${note.title} ${note.body}`.toLowerCase().includes(q))
  }, [notes, query])

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  // 当前选中项被删掉 / 清空后，回落到第一条。
  useEffect(() => {
    if (!open) return
    if (activeId && notes.some((note) => note.id === activeId)) return
    setActiveId(notes[0]?.id ?? null)
  }, [open, notes, activeId])

  // 列表里的相对时间（刚刚 / N分）自己往前走。
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

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

  const clearPending = useCallback(() => {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current)
      undoTimerRef.current = null
    }
    pendingRef.current = null
    setPending(null)
  }, [])

  const close = useCallback(() => {
    setCockpitNotesOpen(false)
    cabinAudio.blip(520, 0.04)
  }, [])

  const focusBody = useCallback(() => {
    window.requestAnimationFrame(() => {
      const element = bodyRef.current
      if (!element) return
      element.focus({ preventScroll: true })
      element.setSelectionRange(element.value.length, element.value.length)
    })
  }, [])

  const createNote = useCallback(() => {
    flushSave()
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
    clearPending()
    persistQuickNotes()
    cabinAudio.blip(700, 0.04)
    focusBody()
  }, [flushSave, clearPending, focusBody])

  const selectNote = useCallback((id: string) => {
    if (id === activeIdRef.current) return
    flushSave()
    setActiveId(id)
    const note = getQuickNotes().find((item) => item.id === id)
    if (note) focusBody()
    cabinAudio.blip(660, 0.04)
  }, [flushSave, focusBody])

  const deleteNote = useCallback((id: string) => {
    const list = getQuickNotes()
    const index = list.findIndex((note) => note.id === id)
    const note = list[index]
    if (!note) return
    const next = list[index + 1] ?? list[index - 1] ?? null
    updateQuickNotes((current) => current.filter((item) => item.id !== id))
    setActiveId(next?.id ?? null)
    persistQuickNotes()

    pendingRef.current = { note, index }
    setPending({ note, index })
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current)
    undoTimerRef.current = window.setTimeout(() => {
      undoTimerRef.current = null
      pendingRef.current = null
      setPending(null)
    }, UNDO_MS)
    cabinAudio.blip(520, 0.04)
  }, [])

  const undoDelete = useCallback(() => {
    const current = pendingRef.current
    if (!current) return
    updateQuickNotes((list) => {
      if (list.some((note) => note.id === current.note.id)) return list
      const next = [...list]
      next.splice(Math.min(current.index, list.length), 0, current.note)
      return next
    })
    setActiveId(current.note.id)
    persistQuickNotes()
    clearPending()
    cabinAudio.blip(780, 0.05)
  }, [clearPending])

  const updateActiveNote = useCallback((updater: (note: QuickNote) => QuickNote) => {
    const id = activeIdRef.current
    if (!id) return
    updateQuickNotes((list) => list.map((note) => (note.id === id ? updater(note) : note)))
  }, [])

  const onTitleChange = useCallback((value: string) => {
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
  }, [scheduleSave, updateActiveNote])

  const onBodyChange = useCallback((value: string) => {
    updateActiveNote((note) => ({
      ...note,
      body: value,
      title: note.manualTitle ? note.title : deriveNoteTitle(value),
      updatedAt: Date.now(),
    }))
    scheduleSave()
  }, [scheduleSave, updateActiveNote])

  const onColorChange = useCallback((color: string) => {
    updateActiveNote((note) => ({ ...note, color, updatedAt: Date.now() }))
    flushSave()
    cabinAudio.blip(640, 0.03)
  }, [flushSave, updateActiveNote])

  // ── 关窗（含壳卸载）：落盘并丢掉没写任何内容的空便签 ──────────────────
  useEffect(() => {
    const wasOpen = wasOpenRef.current
    wasOpenRef.current = open
    if (!open) {
      if (!wasOpen) return
      flushSave()
      const id = activeIdRef.current
      const current = id ? getQuickNotes().find((note) => note.id === id) : null
      if (current && !current.title.trim() && !current.body.trim()) {
        updateQuickNotes((list) => list.filter((note) => note.id !== id))
        if (pendingRef.current?.note.id === id) clearPending()
        setActiveId(getQuickNotes()[0]?.id ?? null)
      }
      persistQuickNotes()
    }
  }, [open, flushSave, clearPending])

  useEffect(() => () => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current)
    dragCleanupRef.current?.()
    persistQuickNotes()
  }, [])

  // Esc：层栈 67 —— 先收便签，再收目录 / 文档窗，最后 dossier。
  useEffect(() => {
    if (!open) return
    return layer.register(NOTES_LAYER_ID, NOTES_LAYER_PRIORITY, close)
  }, [open, layer, close])

  // ⌘N 新建 / ⌘F 搜索 / ⌘Z 撤销删除（窗开着才抢键）。
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey
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
      if (key === 'z' && pendingRef.current) {
        event.preventDefault()
        event.stopPropagation()
        undoDelete()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, createNote, undoDelete])

  // ── 窗口化：拖标题栏 / 双击或 ⛶ 全屏（与目录窗同一套 clamp）──────────
  const toggleMax = useCallback(() => {
    if (!maxed) {
      const el = winRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        const snapshot = {
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        }
        savedGeo = snapshot
        setGeo(snapshot)
      }
      savedMax = true
      setMaxed(true)
    } else {
      savedMax = false
      setMaxed(false)
    }
    cabinAudio.blip(660, 0.03)
  }, [maxed])

  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (maxed) return
    const target = event.target as HTMLElement
    if (target.closest('button, textarea, input, select, a, [data-no-drag]')) return
    if (!target.closest('.ck12-dh')) return
    const el = winRef.current
    if (!el) return
    event.preventDefault()
    const r = el.getBoundingClientRect()
    const start = { x: r.left, y: r.top, w: r.width, h: r.height }
    const sx = event.clientX
    const sy = event.clientY
    const move = (ev: PointerEvent) => {
      const next = {
        x: clamp(start.x + ev.clientX - sx, 4, Math.max(4, window.innerWidth - start.w - 4)),
        y: clamp(start.y + ev.clientY - sy, 52, Math.max(52, window.innerHeight - start.h - 4)),
        w: start.w,
        h: start.h,
      }
      savedGeo = next
      setGeo(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      dragCleanupRef.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    dragCleanupRef.current = up
  }, [maxed])

  const onHeaderDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('button, textarea, input, select, a')) return
    if (!target.closest('.ck12-dh')) return
    toggleMax()
  }, [toggleMax])

  const winApi = useMemo<DossierWindowApi>(
    () => ({ maximized: maxed, toggleMax }),
    [maxed, toggleMax],
  )

  if (!open) return null

  const panelStyle: CSSProperties | undefined = maxed
    ? {
      left: 5,
      top: 52,
      width: Math.max(420, viewport.w - 10),
      height: Math.max(300, viewport.h - 58),
      transform: 'none',
    }
    : geo
      ? { left: geo.x, top: geo.y, width: geo.w, height: geo.h, transform: 'none' }
      : undefined

  const statusLabel = saveState === 'saving'
    ? '保存中…'
    : activeNote
      ? `已保存 · ${relativeNoteTime(activeNote.updatedAt, now)}`
      : '已保存'

  return (
    <div
      ref={winRef}
      className={`ck12-treewin ck12-noteswin${maxed || geo ? ' is-geo' : ''}`}
      style={panelStyle}
      role="dialog"
      aria-label="便签 · 快速记事"
      data-testid="cockpit-noteswin"
      data-maximized={maxed ? '1' : undefined}
      onPointerDownCapture={startDrag}
      onDoubleClick={onHeaderDoubleClick}
    >
      <DossierWindowContext.Provider value={winApi}>
        <CockpitFaceHead
          testId="cockpit-noteswin-head"
          closeTestId="cockpit-notes-close"
          glyph="✎"
          title="便签 · 快速记事"
          sub="NOTES · 本地自动保存 · 不上传"
          onClose={close}
          closeLabel="关闭便签"
        />
      </DossierWindowContext.Provider>

      <div className="ck12-noteswin-b">
        <div className="ck12-ntw">
          <aside className="ck12-nt-side">
            <div className="ck12-nt-search">
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索便签"
                aria-label="搜索便签"
                autoComplete="off"
                spellCheck={false}
              />
              {!query && <span className="ck12-nt-kbd" aria-hidden="true">⌘F</span>}
              <button
                type="button"
                className="ck12-nt-new"
                title="新建便签（⌘N）"
                aria-label="新建便签"
                data-testid="cockpit-note-new"
                onClick={createNote}
              >
                ＋
              </button>
            </div>

            <div className="ck12-nt-list" role="listbox" aria-label="便签列表">
              {filteredNotes.length === 0 ? (
                <div className="ck12-nt-empty" style={{ minHeight: 120 }}>
                  <span className="big" aria-hidden="true">⌕</span>
                  <b>{notes.length ? '没有匹配的便签' : '暂无便签'}</b>
                </div>
              ) : (
                filteredNotes.map((note) => {
                  const on = note.id === activeId
                  return (
                    <div
                      key={note.id}
                      className={`ck12-nt-row${on ? ' on' : ''}`}
                      role="option"
                      aria-selected={on}
                      tabIndex={0}
                      data-testid={`cockpit-note-row-${note.id}`}
                      onClick={() => selectNote(note.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          selectNote(note.id)
                        }
                      }}
                    >
                      <i className="dot" style={{ background: note.color }} aria-hidden="true" />
                      <span className="tt">{noteLabel(note)}</span>
                      <span className="tm">{relativeNoteTime(note.updatedAt, now)}</span>
                      <button
                        type="button"
                        className="dx"
                        title="删除便签"
                        aria-label="删除便签"
                        onClick={(event) => {
                          event.stopPropagation()
                          deleteNote(note.id)
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  )
                })
              )}
            </div>
          </aside>

          <section className="ck12-nt-main">
            {activeNote ? (
              <>
                <div className="ck12-nt-head">
                  <input
                    className="ck12-nt-title"
                    value={activeNote.title}
                    onChange={(event) => onTitleChange(event.target.value)}
                    placeholder="自动取内容前 10 字"
                    aria-label="便签标题"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="ck12-nt-stamp">{noteStampLabel(activeNote.updatedAt)}</span>
                  <div className="ck12-nt-colors" role="group" aria-label="便签颜色">
                    {QUICK_NOTE_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        data-color={color}
                        className={activeNote.color === color ? 'on' : ''}
                        style={{ background: color, color }}
                        aria-label={`颜色 ${color}`}
                        aria-pressed={activeNote.color === color}
                        onClick={() => onColorChange(color)}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    className="ck12-nt-del"
                    title="删除便签"
                    aria-label="删除便签"
                    onClick={() => deleteNote(activeNote.id)}
                  >
                    🗑
                  </button>
                </div>

                <textarea
                  ref={bodyRef}
                  className="ck12-nt-body"
                  value={activeNote.body}
                  onChange={(event) => onBodyChange(event.target.value)}
                  placeholder={'写点什么…\n\n自动保存，随时点开继续写。'}
                  aria-label="便签内容"
                  spellCheck={false}
                />

                <div className="ck12-nt-foot">
                  <span className={`ck12-nt-st${saveState === 'saving' ? ' is-saving' : ''}`} data-testid="cockpit-note-save">
                    <i aria-hidden="true" />
                    {statusLabel}
                  </span>
                  <span className="sp" />
                  <span className="keys">⌘N 新建 · ⌘F 搜索 · Esc 关闭</span>
                  <span className="n" data-testid="cockpit-note-count">
                    {countNoteChars(activeNote.body)} 字
                  </span>
                </div>
              </>
            ) : (
              <div className="ck12-nt-empty">
                <span className="big" aria-hidden="true">✎</span>
                <b>还没有便签</b>
                <span>记一句待办、一个想法，随手就写。</span>
                <button type="button" data-testid="cockpit-note-empty-new" onClick={createNote}>
                  ＋ 新建便签
                </button>
              </div>
            )}
          </section>
        </div>

        {pending && (
          <div className="ck12-nt-undo" role="status">
            已删除「{noteLabel(pending.note)}」
            <button type="button" onClick={undoDelete}>撤销</button>
          </div>
        )}
      </div>
    </div>
  )
}
