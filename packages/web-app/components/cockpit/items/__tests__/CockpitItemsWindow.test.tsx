// 事项窗（2026-11-24 用户）：舱内零散小待办。
//   · 打开即拉取，未决 / 记录 / 全部 三个页签与计数；
//   · 新建 / 标题即时改列表 / 删除 5s 撤销；
//   · 投递两档：直接投递（带 via='items' meta）/ 带到输入框（seed）；
//   · 完成 / 搁置写回记录。

import { useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CabinItemDTO } from '@octopus/shared'
import type { CockpitChatApi } from '../../state/cockpit-state'
import { CockpitStateProvider, useCockpitState } from '../../state/CockpitStateProvider'
import { CockpitLayerStack } from '../../state/CockpitLayerStack'
import { CockpitItemsWindow } from '../CockpitItemsWindow'
import { resetCabinItemsForTests, setCabinItemsOpen, useCabinItems, useItemDeliveryQueue } from '../items-store'

vi.mock('@/lib/cabin-api', () => ({
  fetchCabinItems: vi.fn(),
  createCabinItem: vi.fn(),
  updateCabinItem: vi.fn(),
  deleteCabinItem: vi.fn(),
  closeCabinItems: vi.fn(),
  reopenCabinItem: vi.fn(),
}))

import {
  closeCabinItems, createCabinItem, deleteCabinItem, fetchCabinItems, updateCabinItem,
} from '@/lib/cabin-api'

const fetchItems = vi.mocked(fetchCabinItems)
const createItemApi = vi.mocked(createCabinItem)
const updateItemApi = vi.mocked(updateCabinItem)
const deleteItemApi = vi.mocked(deleteCabinItem)
const closeItemsApi = vi.mocked(closeCabinItems)

function item(partial: Partial<CabinItemDTO> & { id: string; seq: number; title: string }): CabinItemDTO {
  return {
    cabin_id: 'c1',
    kind: 'optimize',
    status: 'todo',
    body: '',
    created_at: '2026-11-24T02:00:00.000Z',
    updated_at: '2026-11-24T02:00:00.000Z',
    delivered_at: null,
    closed_at: null,
    delivery_session_id: null,
    delivery_message_id: null,
    ...partial,
  }
}

const ITEMS: CabinItemDTO[] = [
  item({
    id: 'ci-2', seq: 2, title: '时间列太窄',
    body: '长提交时间被截成「2026-11-23 ...」；按原型给时间列固定宽度。',
    created_at: '2026-11-24T03:00:00.000Z',
  }),
  item({
    id: 'ci-3', seq: 3, title: 'Esc 后焦点丢失', kind: 'fix',
    body: '关掉详情后键盘不能继续操作编队，得再点一下。',
  }),
  item({
    id: 'ci-4', seq: 4, title: '头像偶尔不加载', kind: 'fix', status: 'delivered',
    delivered_at: '2026-11-24T01:30:00.000Z',
  }),
  item({
    id: 'ci-1', seq: 1, title: '附录顺序反了', status: 'done',
    closed_at: '2026-11-23T09:00:00.000Z',
  }),
]

function makeChatApi(overrides: Partial<CockpitChatApi> = {}): CockpitChatApi {
  return {
    model: 'pro',
    effort: 'medium',
    contextWindow: '200k',
    streaming: false,
    queueDepth: 0,
    canSend: true,
    contextUsage: null,
    usage: null,
    submit: vi.fn(),
    seed: vi.fn(),
    stop: vi.fn(),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    setContext: vi.fn(),
    ...overrides,
  }
}

function ChatProbe({ api }: { api: CockpitChatApi }) {
  const { reportChat } = useCockpitState()
  useEffect(() => {
    reportChat(api)
    return () => reportChat(null)
  }, [reportChat, api])
  return null
}

function ItemsProbe() {
  const state = useCabinItems('c1')
  return <span data-testid="items-open-probe">{state.open}</span>
}

function QueueProbe() {
  const queue = useItemDeliveryQueue()
  return <span data-testid="queue-probe">{queue.length}</span>
}

function renderWindow(chat: CockpitChatApi = makeChatApi()): { chat: CockpitChatApi } {
  render(
    <CockpitStateProvider entryCabinId="c1">
      <CockpitLayerStack>
        <CockpitItemsWindow />
        <ChatProbe api={chat} />
        <ItemsProbe />
        <QueueProbe />
      </CockpitLayerStack>
    </CockpitStateProvider>,
  )
  act(() => setCabinItemsOpen(true))
  return { chat }
}

let dbItems: CabinItemDTO[] = []
function countOpen(list: CabinItemDTO[]): number {
  return list.filter((row) => row.status === 'todo' || row.status === 'delivered').length
}

beforeEach(() => {
  resetCabinItemsForTests()
  vi.clearAllMocks()
  dbItems = ITEMS.map((row) => ({ ...row }))
  fetchItems.mockImplementation(async () => ({
    items: dbItems.map((row) => ({ ...row })),
    open: countOpen(dbItems),
  }))
  createItemApi.mockImplementation(async (_cabin, input) => {
    const created = item({ id: 'ci-5', seq: 5, title: input.title ?? '' })
    dbItems = [created, ...dbItems]
    return { ...created }
  })
  updateItemApi.mockImplementation(async (_cabin, id, patch) => {
    const base = dbItems.find((x) => x.id === id) ?? dbItems[0]
    const next = { ...base, ...patch, updated_at: '2026-11-24T04:00:00.000Z' }
    dbItems = dbItems.map((x) => (x.id === id ? next : x))
    return { ...next }
  })
  deleteItemApi.mockImplementation(async (_cabin, id) => {
    dbItems = dbItems.filter((x) => x.id !== id)
  })
  closeItemsApi.mockImplementation(async (_cabin, ids, outcome) => {
    const rows = ids.map((id) => {
      const base = dbItems.find((x) => x.id === id) ?? dbItems[0]
      const next = { ...base, status: outcome, closed_at: '2026-11-24T04:00:00.000Z' }
      dbItems = dbItems.map((x) => (x.id === id ? next : x))
      return { ...next }
    })
    return rows
  })
})

afterEach(() => {
  cleanup()
  resetCabinItemsForTests()
})

describe('CockpitItemsWindow — 舱内事项', () => {
  it('打开后列未决事项并选中第一条；记录页签列出已关闭项', async () => {
    renderWindow()
    await screen.findByText('时间列太窄')

    expect(screen.getByTestId('cockpit-items-tab-open')).toHaveTextContent('未决 3')
    expect(screen.getByTestId('cockpit-items-tab-record')).toHaveTextContent('记录 1')
    expect(screen.getByTestId('cockpit-items-tab-all')).toHaveTextContent('全部 4')
    expect(screen.getByLabelText('事项标题')).toHaveValue('时间列太窄')
    expect(screen.queryByText('附录顺序反了')).toBeNull()

    fireEvent.click(screen.getByTestId('cockpit-items-tab-record'))
    expect(await screen.findByText('附录顺序反了')).toBeInTheDocument()
    // 已关闭项不可勾选投递
    const row = screen.getByTestId('cockpit-item-row-ci-1')
    expect(within(row).queryByLabelText('选中投递')).toBeNull()
  })

  it('新建 → 出现在列表并被选中；标题即时写进列表行', async () => {
    renderWindow()
    await screen.findByText('时间列太窄')

    fireEvent.click(screen.getByTestId('cockpit-item-new'))
    await waitFor(() => expect(createItemApi).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('cockpit-item-row-ci-5')).toBeInTheDocument()
    expect(screen.getByLabelText('事项标题')).toHaveValue('')

    fireEvent.change(screen.getByLabelText('事项标题'), { target: { value: '新的小事项' } })
    expect(within(screen.getByTestId('cockpit-item-row-ci-5')).getByText('新的小事项')).toBeInTheDocument()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)) })
    expect(updateItemApi).toHaveBeenCalledWith('c1', 'ci-5', expect.objectContaining({ title: '新的小事项' }))
  })

  it('多选投递 → chat.submit 带 via=items；窗口关闭', async () => {
    const { chat } = renderWindow()
    await screen.findByText('时间列太窄')

    fireEvent.click(within(screen.getByTestId('cockpit-item-row-ci-2')).getByLabelText('选中投递'))
    fireEvent.click(within(screen.getByTestId('cockpit-item-row-ci-3')).getByLabelText('选中投递'))
    expect(screen.getByTestId('cockpit-items-picked')).toHaveTextContent('已选 2 条')

    fireEvent.click(screen.getByTestId('cockpit-items-deliver-picked'))
    expect(chat.submit).toHaveBeenCalledTimes(1)
    const [text, meta] = (chat.submit as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(text).toContain('#IT-2')
    expect(text).toContain('#IT-3')
    // 正文必须跟着标题一起送达（2026-11-26 用户事故：#IT-1 正文 1368 字没投出去）
    expect(text).toContain('长提交时间被截成「2026-11-23 ...」')
    expect(text).toContain('关掉详情后键盘不能继续操作编队')
    expect(meta).toEqual({ via: 'items', itemIds: ['ci-2', 'ci-3'] })
    expect(screen.queryByTestId('cockpit-itemswin')).toBeNull()
  })

  it('带到输入框 → chat.seed 预填 + 挂件标签；窗口关闭', async () => {
    const { chat } = renderWindow()
    await screen.findByText('时间列太窄')

    fireEvent.click(screen.getByTestId('cockpit-item-stage'))
    expect(chat.seed).toHaveBeenCalledTimes(1)
    const [text, meta] = (chat.seed as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(text).toContain('#IT-2')
    expect(text).toContain('长提交时间被截成「2026-11-23 ...」')
    expect(meta).toEqual({ via: 'items', itemIds: ['ci-2'], labels: ['#IT-2'] })
    expect(screen.queryByTestId('cockpit-itemswin')).toBeNull()
  })

  it('删除 → 立即消失且可撤销；关项写回记录', async () => {
    renderWindow()
    await screen.findByText('时间列太窄')

    fireEvent.click(screen.getByTestId('cockpit-item-delete'))
    expect(screen.queryByTestId('cockpit-item-row-ci-2')).toBeNull()
    expect(screen.getByText(/已删除「时间列太窄」/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('撤销'))
    expect(await screen.findByTestId('cockpit-item-row-ci-2')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('cockpit-item-done'))
    expect(closeItemsApi).toHaveBeenCalledWith('c1', ['ci-2'], 'done')
    await waitFor(() => expect(screen.getByTestId('items-open-probe')).toHaveTextContent('2'))
    fireEvent.click(screen.getByTestId('cockpit-items-tab-record'))
    expect(await screen.findByText('时间列太窄')).toBeInTheDocument()
    expect(screen.getByTestId('cockpit-item-row-ci-2')).toHaveTextContent('已完成')
  })

  it('主对话在跑 → 投递进排队，不直接 submit', async () => {
    const { chat } = renderWindow(makeChatApi({ streaming: true }))
    await screen.findByText('时间列太窄')

    fireEvent.click(screen.getByTestId('cockpit-item-deliver'))
    expect(chat.submit).not.toHaveBeenCalled()
    expect(screen.getByTestId('queue-probe')).toHaveTextContent('1')
    expect(screen.queryByTestId('cockpit-itemswin')).toBeNull()
  })
})
