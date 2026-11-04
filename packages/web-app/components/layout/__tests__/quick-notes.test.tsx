import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  QUICK_NOTES_SIDE_WIDTH_KEY,
  QUICK_NOTES_STORAGE_KEY,
  __resetQuickNotesForTests,
} from '@/lib/quick-notes'
import { QuickNotes, QuickNotesCountBadge, QuickNotesWindow } from '../quick-notes'

function createNote() {
  const buttons = screen.getAllByRole('button', { name: '新建便签' })
  fireEvent.click(buttons[0])
}

function typeBody(value: string) {
  fireEvent.change(screen.getByLabelText('便签内容'), { target: { value } })
}

beforeEach(() => {
  localStorage.clear()
  __resetQuickNotesForTests()
})

afterEach(() => cleanup())

describe('QuickNotesWindow — 便签窗口内容', () => {
  it('空态 → 新建 → 正文自动生成标题，关闭窗口时落盘', () => {
    const { unmount } = render(<QuickNotesWindow />)

    expect(screen.getByText('还没有便签')).toBeInTheDocument()

    createNote()
    typeBody('今天先把便签交互改完再吃晚饭')

    const title = screen.getByLabelText('便签标题（自动取内容前 10 字）') as HTMLInputElement
    expect(title.value).toBe('今天先把便签交互改完')

    unmount()

    const saved = JSON.parse(localStorage.getItem(QUICK_NOTES_STORAGE_KEY) ?? '[]')
    expect(saved).toHaveLength(1)
    expect(saved[0].title).toBe('今天先把便签交互改完')
    expect(saved[0].body).toBe('今天先把便签交互改完再吃晚饭')
    expect(saved[0].manualTitle).toBe(false)
  })

  it('关闭时丢弃没写任何内容的空便签', () => {
    const { unmount } = render(<QuickNotesWindow />)
    createNote()
    unmount()
    expect(JSON.parse(localStorage.getItem(QUICK_NOTES_STORAGE_KEY) ?? '[]')).toHaveLength(0)
  })

  it('手动改标题后，正文继续输入不再覆盖标题', () => {
    render(<QuickNotesWindow />)
    createNote()
    typeBody('买咖啡')

    const title = screen.getByLabelText('便签标题（自动取内容前 10 字）') as HTMLInputElement
    fireEvent.change(title, { target: { value: '自定义标题' } })
    typeBody('买咖啡，顺便买牛奶')

    expect(title.value).toBe('自定义标题')
  })

  it('删除后可从 toast 撤销恢复', () => {
    render(<QuickNotesWindow />)
    createNote()
    typeBody('临时记一条')

    const deleteButtons = screen.getAllByRole('button', { name: '删除便签' })
    fireEvent.click(deleteButtons[deleteButtons.length - 1])

    expect(screen.getByText('还没有便签')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('已删除「临时记一条」')

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(screen.getByLabelText('便签内容')).toHaveValue('临时记一条')
  })

  it('多行正文显示行号，右下角显示字数', () => {
    render(<QuickNotesWindow />)
    createNote()
    typeBody('第一行\n第二行\n\n第四行')

    const gutter = screen.getByTestId('quick-notes-gutter')
    expect(gutter.querySelectorAll('span')).toHaveLength(4)
    expect(screen.getByTestId('quick-notes-char-count')).toHaveTextContent('9 字')
  })

  it('标题行与日期、颜色、删除在同一行', () => {
    render(<QuickNotesWindow />)
    createNote()

    const title = screen.getByLabelText('便签标题（自动取内容前 10 字）')
    const row = title.parentElement as HTMLElement
    expect(row.querySelector('svg')).toBeTruthy()
    expect(row.querySelector('[role="group"]')).toBeTruthy()
    expect(row.querySelector('[aria-label="删除便签"]')).toBeTruthy()
    expect(row.textContent).toMatch(/\d+月\d+日/)
  })

  it('分隔条拖动调整列表栏宽度并落盘', () => {
    render(<QuickNotesWindow />)
    createNote()

    const divider = screen.getByTestId('quick-notes-divider')
    const sidebar = screen.getByTestId('quick-notes-sidebar')

    fireEvent.pointerDown(divider, { button: 0, pointerId: 1, clientX: 300 })
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 360 })
    expect(sidebar.style.width).toBe('220px')

    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 360 })
    expect(sidebar.style.width).toBe('220px')
    expect(localStorage.getItem(QUICK_NOTES_SIDE_WIDTH_KEY)).toBe('220')
  })

  it('窗口标题徽标显示便签数量', () => {
    render(
      <>
        <QuickNotesCountBadge />
        <QuickNotesWindow />
      </>,
    )
    expect(screen.getByTestId('quick-notes-count')).toHaveTextContent('0')
    createNote()
    expect(screen.getByTestId('quick-notes-count')).toHaveTextContent('1')
  })
})

describe('QuickNotes — header 入口', () => {
  it('没有桌面上下文时只渲染按钮，不误报按下', () => {
    render(<QuickNotes />)
    const button = screen.getByTestId('quick-notes-button')
    expect(button).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })
})
