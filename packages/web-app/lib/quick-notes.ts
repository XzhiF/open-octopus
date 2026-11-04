// 快速便签（header 右上角浮层）的本地数据层。
//
// 便签是「随手的草稿纸」，不进入任务/知识库的数据域；沿用 ui-preferences 的
// localStorage 方案：打开即读、改完自动落盘、其它标签页通过 storage 事件同步。
// 面板几何（位置/尺寸）单独存一个 key，和内容互不影响。

export interface QuickNote {
  id: string
  /** 标题；未手动改名时 = 正文首个非空行的前 10 个字符 */
  title: string
  body: string
  /** 用户手动改过标题后为 true，此后正文变化不再覆盖标题 */
  manualTitle: boolean
  color: string
  updatedAt: number
}

export interface QuickNotesGeometry {
  left: number
  top: number
  width: number
  height: number
  /** 左侧列表栏宽度（列表 / 编辑区之间的分隔条可拖） */
  sideWidth: number
}

export const QUICK_NOTES_STORAGE_KEY = 'octopus.quick-notes.v1'
export const QUICK_NOTES_GEOMETRY_KEY = 'octopus.quick-notes.geometry.v1'
export const QUICK_NOTES_SIDE_WIDTH_KEY = 'octopus.quick-notes.side-width.v1'

/** 列表栏默认宽度（2026-11-04 用户：比原型首版的 200px 收 20%）。 */
export const QUICK_NOTES_DEFAULT_SIDE_WIDTH = 160
export const QUICK_NOTES_MIN_SIDE_WIDTH = 130
export const QUICK_NOTES_MIN_EDITOR_WIDTH = 240

export const QUICK_NOTE_COLORS = [
  '#FFC857',
  '#FF855C',
  '#7EE787',
  '#A78BFA',
  '#4FD1D9',
] as const

export const QUICK_NOTE_TITLE_LENGTH = 10

let snapshot: QuickNote[] | null = null
const listeners = new Set<() => void>()

function isQuickNoteColor(value: unknown): value is string {
  return typeof value === 'string' && (QUICK_NOTE_COLORS as readonly string[]).includes(value)
}

export function createQuickNoteId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `n_${crypto.randomUUID()}`
    }
  } catch {
    // fall through to the random suffix
  }
  return `n_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

/** 自动标题：正文首个非空行的前 10 个字符（按 Unicode 码点截，不劈开 emoji）。 */
export function deriveNoteTitle(body: string): string {
  const first =
    String(body ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  return Array.from(first).slice(0, QUICK_NOTE_TITLE_LENGTH).join('')
}

/** 字数统计：不含空白（空格/换行/制表符）；中文按字、英文按字母。 */
export function countNoteChars(body: string): number {
  return Array.from(String(body ?? '')).filter((ch) => !/\s/.test(ch)).length
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 列表里的紧凑时间：刚刚 / N分 / HH:MM / 昨天 / M/D。 */
export function relativeNoteTime(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分`
  const date = new Date(timestamp)
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  }
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** 编辑器顶部的时间戳：M月D日 HH:MM。 */
export function noteStampLabel(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function normalizeNote(raw: unknown): QuickNote | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const body = typeof input.body === 'string' ? input.body : ''
  const storedTitle = typeof input.title === 'string' ? input.title : ''
  const manualTitle =
    typeof input.manualTitle === 'boolean'
      ? input.manualTitle
      : Boolean(storedTitle.trim() && storedTitle !== deriveNoteTitle(body))
  // 缺标题（旧数据/半截写入）时按自动标题规则补上，避免列表里全是「未命名」
  const title = !manualTitle && !storedTitle.trim() ? deriveNoteTitle(body) : storedTitle
  const updatedAt = Number(input.updatedAt)
  return {
    id:
      typeof input.id === 'string' && input.id.trim()
        ? input.id
        : createQuickNoteId(),
    title,
    body,
    manualTitle,
    color: isQuickNoteColor(input.color) ? input.color : QUICK_NOTE_COLORS[0],
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now(),
  }
}

function readNotes(): QuickNote[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(QUICK_NOTES_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizeNote)
      .filter((note): note is QuickNote => note !== null)
  } catch {
    return []
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    // key === null：其它标签页 clear() 了整个 localStorage
    if (event.key !== QUICK_NOTES_STORAGE_KEY && event.key !== null) return
    snapshot = readNotes()
    for (const listener of listeners) listener()
  })
}

/** 当前内存快照；第一次访问时从 localStorage 载入。 */
export function getQuickNotes(): QuickNote[] {
  if (snapshot === null) snapshot = readNotes()
  return snapshot
}

export function subscribeQuickNotes(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 只改内存并通知订阅者；落盘由调用方决定时机（自动保存防抖）。 */
export function updateQuickNotes(updater: (notes: QuickNote[]) => QuickNote[]): void {
  snapshot = updater(getQuickNotes())
  for (const listener of listeners) listener()
}

/** 把当前快照写入 localStorage。 */
export function persistQuickNotes(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(QUICK_NOTES_STORAGE_KEY, JSON.stringify(getQuickNotes()))
  } catch {
    // 隐私模式 / 配额满：内存态继续工作
  }
}

export function loadQuickNotesGeometry(): QuickNotesGeometry | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(QUICK_NOTES_GEOMETRY_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const geometry = parsed as Record<string, unknown>
    const values = [geometry.left, geometry.top, geometry.width, geometry.height]
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      return null
    }
    const sideWidth = Number(geometry.sideWidth)
    return {
      left: geometry.left as number,
      top: geometry.top as number,
      width: geometry.width as number,
      height: geometry.height as number,
      // 旧几何没有 sideWidth：回落到新默认宽度
      sideWidth:
        Number.isFinite(sideWidth) && sideWidth > 0
          ? sideWidth
          : QUICK_NOTES_DEFAULT_SIDE_WIDTH,
    }
  } catch {
    return null
  }
}

export function saveQuickNotesGeometry(geometry: QuickNotesGeometry): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(QUICK_NOTES_GEOMETRY_KEY, JSON.stringify(geometry))
  } catch {
    // ignore
  }
}

/** 列表栏宽度：窗口的位置/尺寸现在由桌面窗口管理器负责，只剩这一项需要自己存。 */
export function loadQuickNotesSideWidth(): number {
  if (typeof window === 'undefined') return QUICK_NOTES_DEFAULT_SIDE_WIDTH
  try {
    const raw = window.localStorage.getItem(QUICK_NOTES_SIDE_WIDTH_KEY)
    if (raw !== null) {
      const width = Number(raw)
      if (Number.isFinite(width) && width > 0) return width
    }
  } catch {
    // storage unavailable：回落到默认值
  }
  // 旧版把列表宽度存在整块几何里，首次升级时沿用
  return loadQuickNotesGeometry()?.sideWidth ?? QUICK_NOTES_DEFAULT_SIDE_WIDTH
}

export function saveQuickNotesSideWidth(width: number): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(QUICK_NOTES_SIDE_WIDTH_KEY, String(width))
  } catch {
    // ignore
  }
}

/** Test seam: drop the cached snapshot and subscribers between tests. */
export function __resetQuickNotesForTests(): void {
  snapshot = null
  listeners.clear()
}
