// 全舱便签窗（2026-11-23 用户 #3）：classic 快速便签迁入全舱。
//   · 数据层 = lib/quick-notes 的 localStorage（与 classic 同一份内容）；
//   · 打开即列便签、选中第一条；新建 / 自动标题（前 10 字）/ 字数；
//   · 搜索过滤 / 删除 5s 撤销 / Esc 收窗（层栈）；
//   · 关窗落盘，并丢掉没写任何内容的空便签。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  QUICK_NOTES_STORAGE_KEY, __resetQuickNotesForTests, getQuickNotes, updateQuickNotes,
  type QuickNote,
} from '@/lib/quick-notes'
import { CockpitStateProvider } from '../../state/CockpitStateProvider'
import { CockpitLayerStack } from '../../state/CockpitLayerStack'
import { CockpitNotesWindow } from '../CockpitNotesWindow'
import {
  resetCockpitNotesForTests, setCockpitNotesOpen, useQuickNoteCount,
} from '../notes-store'

const SEED: QuickNote = {
  id: 'nt1',
  title: '周会待确认',
  body: '周会待确认：\n- 限流阈值 1000 rpm',
  manualTitle: true,
  color: '#FFC857',
  updatedAt: Date.now() - 60_000,
}

function CountProbe() {
  const count = useQuickNoteCount()
  return <span data-testid="note-count-probe">{count}</span>
}

function openWindow() {
  render(
    <CockpitStateProvider entryCabinId="c1">
      <CockpitLayerStack>
        <CockpitNotesWindow />
        <CountProbe />
      </CockpitLayerStack>
    </CockpitStateProvider>,
  )
  act(() => setCockpitNotesOpen(true))
}

function savedNotes(): QuickNote[] {
  return JSON.parse(localStorage.getItem(QUICK_NOTES_STORAGE_KEY) ?? '[]') as QuickNote[]
}

beforeEach(() => {
  localStorage.clear()
  __resetQuickNotesForTests()
  resetCockpitNotesForTests()
  updateQuickNotes(() => [SEED])
})

afterEach(() => cleanup())

describe('CockpitNotesWindow — 全舱便签', () => {
  it('默认收起；打开后列便签并选中第一条', () => {
    render(
      <CockpitStateProvider entryCabinId="c1">
        <CockpitLayerStack>
          <CockpitNotesWindow />
        </CockpitLayerStack>
      </CockpitStateProvider>,
    )
    expect(screen.queryByTestId('cockpit-noteswin')).toBeNull()

    act(() => setCockpitNotesOpen(true))
    expect(screen.getByTestId('cockpit-noteswin')).toBeInTheDocument()
    expect(screen.getByText('周会待确认')).toBeInTheDocument()
    expect(screen.getByLabelText('便签内容')).toHaveValue(SEED.body)
  })

  it('新建 → 正文自动取前 10 字作标题 + 字数；关窗落盘', () => {
    openWindow()
    fireEvent.click(screen.getByTestId('cockpit-note-new'))

    fireEvent.change(screen.getByLabelText('便签内容'), {
      target: { value: '今天先把便签交互改完再吃晚饭' },
    })

    expect(screen.getByLabelText('便签标题')).toHaveValue('今天先把便签交互改完')
    expect(screen.getByTestId('cockpit-note-count')).toHaveTextContent('14 字')
    expect(screen.getByTestId('note-count-probe')).toHaveTextContent('2')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('cockpit-noteswin')).toBeNull()

    const saved = savedNotes()
    expect(saved).toHaveLength(2)
    expect(saved[0].title).toBe('今天先把便签交互改完')
    expect(saved[0].body).toBe('今天先把便签交互改完再吃晚饭')
  })

  it('手动改标题后，正文继续输入不再覆盖标题', () => {
    openWindow()
    fireEvent.click(screen.getByTestId('cockpit-note-new'))
    fireEvent.change(screen.getByLabelText('便签内容'), { target: { value: '买咖啡' } })
    fireEvent.change(screen.getByLabelText('便签标题'), { target: { value: '自定义标题' } })
    fireEvent.change(screen.getByLabelText('便签内容'), { target: { value: '买咖啡，顺便买牛奶' } })

    expect(screen.getByLabelText('便签标题')).toHaveValue('自定义标题')
  })

  // 2026-11-24 用户：清空标题的瞬间不再被自动标题顶回来，整段重命名才做得了；
  // 只有离开焦点时仍为空，才还原原标题。
  it('清空标题时保持为空（不立刻还原），失焦仍为空才还原原标题', () => {
    openWindow()
    const title = screen.getByLabelText('便签标题')
    fireEvent.focus(title)
    fireEvent.change(title, { target: { value: '' } })

    expect(screen.getByLabelText('便签标题')).toHaveValue('')
    // 列表里的旧标题还在（没有写回空标题）
    expect(screen.getByText('周会待确认')).toBeInTheDocument()
    expect(getQuickNotes()[0].title).toBe('周会待确认')

    fireEvent.blur(title)
    expect(screen.getByLabelText('便签标题')).toHaveValue('周会待确认')
    expect(getQuickNotes()[0].title).toBe('周会待确认')
  })

  it('整段重命名：先清空再输入新标题，失焦后保留并落盘', () => {
    openWindow()
    const title = screen.getByLabelText('便签标题')
    fireEvent.focus(title)
    fireEvent.change(title, { target: { value: '' } })
    fireEvent.change(title, { target: { value: '新的完整标题' } })

    expect(screen.getByLabelText('便签标题')).toHaveValue('新的完整标题')
    fireEvent.blur(title)

    expect(screen.getByLabelText('便签标题')).toHaveValue('新的完整标题')
    const saved = savedNotes().find((note) => note.id === 'nt1')
    expect(saved?.title).toBe('新的完整标题')
    expect(saved?.manualTitle).toBe(true)
  })

  // 2026-11-24 用户：便签窗左列表 / 右草稿纸的宽度要能拖（双击回默认）。
  it('拖动分隔条调节左列表宽度并记住；双击恢复默认', () => {
    openWindow()
    const divider = screen.getByTestId('cockpit-notes-divider')
    const row = divider.parentElement as HTMLElement

    fireEvent.pointerDown(divider, { button: 0, clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(divider, { clientX: 380, pointerId: 1 })
    fireEvent.pointerUp(divider, { pointerId: 1 })

    expect(row.style.getPropertyValue('--ck12-nt-side')).toBe('300px')
    expect(localStorage.getItem('octopus.cockpit.notes.side-width.v1')).toBe('300')

    fireEvent.doubleClick(divider)
    expect(row.style.getPropertyValue('--ck12-nt-side')).toBe('220px')
    expect(localStorage.getItem('octopus.cockpit.notes.side-width.v1')).toBe('220')
  })

  it('搜索过滤：命中留行，无命中给空态', () => {
    openWindow()
    const search = screen.getByLabelText('搜索便签')

    fireEvent.change(search, { target: { value: '限流' } })
    expect(screen.getByText('周会待确认')).toBeInTheDocument()

    fireEvent.change(search, { target: { value: '不存在的词' } })
    expect(screen.getByText('没有匹配的便签')).toBeInTheDocument()
    expect(screen.queryByText('周会待确认')).toBeNull()
  })

  it('删除后可撤销恢复', () => {
    openWindow()
    fireEvent.click(screen.getAllByRole('button', { name: '删除便签' })[0])

    expect(screen.queryByText('周会待确认')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('已删除「周会待确认」')
    expect(screen.getByTestId('note-count-probe')).toHaveTextContent('0')

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(screen.getByText('周会待确认')).toBeInTheDocument()
    expect(screen.getByTestId('note-count-probe')).toHaveTextContent('1')
  })

  it('关窗丢弃没写任何内容的空便签', () => {
    openWindow()
    fireEvent.click(screen.getByTestId('cockpit-note-new'))
    expect(screen.getByTestId('note-count-probe')).toHaveTextContent('2')

    fireEvent.click(screen.getByTestId('cockpit-notes-close'))

    expect(getQuickNotes()).toHaveLength(1)
    expect(savedNotes()).toHaveLength(1)
    expect(savedNotes()[0].id).toBe('nt1')
  })
})
