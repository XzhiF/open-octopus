import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  QUICK_NOTE_COLORS,
  QUICK_NOTES_DEFAULT_SIDE_WIDTH,
  QUICK_NOTES_GEOMETRY_KEY,
  QUICK_NOTES_SIDE_WIDTH_KEY,
  QUICK_NOTES_STORAGE_KEY,
  __resetQuickNotesForTests,
  countNoteChars,
  deriveNoteTitle,
  getQuickNotes,
  loadQuickNotesGeometry,
  loadQuickNotesSideWidth,
  noteStampLabel,
  persistQuickNotes,
  relativeNoteTime,
  saveQuickNotesGeometry,
  saveQuickNotesSideWidth,
  subscribeQuickNotes,
  updateQuickNotes,
} from '../quick-notes'

beforeEach(() => {
  localStorage.clear()
  __resetQuickNotesForTests()
})

describe('快速便签 · 自动标题', () => {
  it('取正文首个非空行的前 10 个字符', () => {
    expect(deriveNoteTitle('  今天先把便签交互改完再吃晚饭\n第二行')).toBe('今天先把便签交互改完')
    expect(deriveNoteTitle('\n\n买咖啡')).toBe('买咖啡')
    expect(deriveNoteTitle('')).toBe('')
  })

  it('按码点截断，不劈开 emoji', () => {
    const emoji = '🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂'
    expect(Array.from(deriveNoteTitle(emoji))).toHaveLength(10)
  })
})

describe('快速便签 · 列表时间', () => {
  const now = new Date(2026, 10, 4, 15, 30, 0).getTime()

  it('刚刚 / N分 / 当天时刻 / 昨天 / 月日', () => {
    expect(relativeNoteTime(now - 20_000, now)).toBe('刚刚')
    expect(relativeNoteTime(now - 6 * 60_000, now)).toBe('6分')
    expect(relativeNoteTime(new Date(2026, 10, 4, 9, 5).getTime(), now)).toBe('09:05')
    expect(relativeNoteTime(new Date(2026, 10, 3, 22, 0).getTime(), now)).toBe('昨天')
    expect(relativeNoteTime(new Date(2026, 9, 28, 8, 0).getTime(), now)).toBe('10/28')
  })

  it('编辑器时间戳', () => {
    expect(noteStampLabel(new Date(2026, 10, 4, 9, 5).getTime())).toBe('11月4日 09:05')
  })
})

describe('快速便签 · 字数', () => {
  it('不含空白；中文按字、英文按字母、emoji 按码点', () => {
    expect(countNoteChars('a b\n中')).toBe(3)
    expect(countNoteChars('   \n\t')).toBe(0)
    expect(countNoteChars('🙂a')).toBe(2)
  })
})

describe('快速便签 · 数据层', () => {
  it('更新后落盘，重新载入内容一致', () => {
    updateQuickNotes(() => [
      {
        id: 'n1',
        title: '测试',
        body: '内容',
        manualTitle: true,
        color: QUICK_NOTE_COLORS[1],
        updatedAt: 1,
      },
    ])
    persistQuickNotes()

    const raw = localStorage.getItem(QUICK_NOTES_STORAGE_KEY)
    expect(raw).toContain('"id":"n1"')

    __resetQuickNotesForTests()
    expect(getQuickNotes()).toHaveLength(1)
    expect(getQuickNotes()[0].manualTitle).toBe(true)
  })

  it('脏数据被规范化：缺色回落到默认色，缺时间补当前时间', () => {
    localStorage.setItem(
      QUICK_NOTES_STORAGE_KEY,
      JSON.stringify([
        { id: 'a', body: '第一行内容很长很长很长', color: 'not-a-color' },
        { body: '' },
        null,
        'garbage',
      ]),
    )
    __resetQuickNotesForTests()
    const notes = getQuickNotes()
    expect(notes).toHaveLength(2)
    expect(notes[0].color).toBe(QUICK_NOTE_COLORS[0])
    expect(notes[0].manualTitle).toBe(false)
    expect(notes[0].title).toBe('第一行内容很长很长很')
    expect(notes[0].updatedAt).toBeGreaterThan(0)
    expect(notes[1].id).toBeTruthy()
  })

  it('其它标签页写入（storage 事件）会刷新并通知订阅者', () => {
    const listener = vi.fn()
    const off = subscribeQuickNotes(listener)
    localStorage.setItem(
      QUICK_NOTES_STORAGE_KEY,
      JSON.stringify([{ id: 'x', title: '外部', body: '', updatedAt: 1 }]),
    )
    window.dispatchEvent(new StorageEvent('storage', { key: QUICK_NOTES_STORAGE_KEY }))

    expect(listener).toHaveBeenCalledTimes(1)
    expect(getQuickNotes()[0].title).toBe('外部')
    off()
  })

  it('面板几何可保存/读取，非法值丢弃', () => {
    expect(loadQuickNotesGeometry()).toBeNull()
    saveQuickNotesGeometry({ left: 10, top: 40, width: 600, height: 400, sideWidth: 180 })
    expect(loadQuickNotesGeometry()).toEqual({
      left: 10,
      top: 40,
      width: 600,
      height: 400,
      sideWidth: 180,
    })

    // 旧版本几何没有 sideWidth → 回落到新默认 160
    localStorage.setItem(
      QUICK_NOTES_GEOMETRY_KEY,
      JSON.stringify({ left: 10, top: 40, width: 600, height: 400 }),
    )
    expect(loadQuickNotesGeometry()).toEqual({
      left: 10,
      top: 40,
      width: 600,
      height: 400,
      sideWidth: 160,
    })

    localStorage.setItem(QUICK_NOTES_GEOMETRY_KEY, '{"left":1,"top":"x"}')
    expect(loadQuickNotesGeometry()).toBeNull()
  })

  it('列表栏宽度单独保存；旧版几何里的宽度只做一次迁移', () => {
    expect(loadQuickNotesSideWidth()).toBe(QUICK_NOTES_DEFAULT_SIDE_WIDTH)

    saveQuickNotesSideWidth(212)
    expect(localStorage.getItem(QUICK_NOTES_SIDE_WIDTH_KEY)).toBe('212')
    expect(loadQuickNotesSideWidth()).toBe(212)

    // 只留旧几何：迁移它的 sideWidth
    localStorage.removeItem(QUICK_NOTES_SIDE_WIDTH_KEY)
    saveQuickNotesGeometry({ left: 10, top: 40, width: 600, height: 400, sideWidth: 184 })
    expect(loadQuickNotesSideWidth()).toBe(184)

    localStorage.setItem(QUICK_NOTES_SIDE_WIDTH_KEY, 'not-a-number')
    expect(loadQuickNotesSideWidth()).toBe(184)
  })
})
