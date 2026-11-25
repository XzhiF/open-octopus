// 事项回执卡（2026-11-24 用户）：投递的 user 消息之后，本轮收口时举上来。
//   · 有后续 assistant 行才出现；
//   · 行状态读事项 store；完成 / 搁置 = close API；
//   · 全部关项后收成一行「已关闭为…」。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CabinItemDTO } from '@octopus/shared'
import type { AgentMessage } from '@/lib/agent/types'
import { CockpitItemReceipt } from '../CockpitItemReceipt'
import { resetCabinItemsForTests } from '../items-store'

vi.mock('@/lib/cabin-api', () => ({
  fetchCabinItems: vi.fn(),
  createCabinItem: vi.fn(),
  updateCabinItem: vi.fn(),
  deleteCabinItem: vi.fn(),
  closeCabinItems: vi.fn(),
  reopenCabinItem: vi.fn(),
}))

import { closeCabinItems, fetchCabinItems } from '@/lib/cabin-api'

const fetchItems = vi.mocked(fetchCabinItems)
const closeItemsApi = vi.mocked(closeCabinItems)

function item(partial: Partial<CabinItemDTO> & { id: string; seq: number }): CabinItemDTO {
  return {
    cabin_id: 'c1',
    kind: 'optimize',
    status: 'delivered',
    title: '',
    body: '',
    created_at: '2026-11-24T02:00:00.000Z',
    updated_at: '2026-11-24T02:00:00.000Z',
    delivered_at: '2026-11-24T02:10:00.000Z',
    closed_at: null,
    delivery_session_id: 's1',
    delivery_message_id: 'm1',
    ...partial,
  }
}

const ITEMS = [
  item({ id: 'ci-2', seq: 2, title: '时间列太窄' }),
  item({ id: 'ci-3', seq: 3, title: 'Esc 后焦点丢失' }),
]

const USER_MSG: AgentMessage = {
  id: 'm1',
  session_id: 's1',
  role: 'user',
  content: '处理这几条事项：',
  created_at: '2026-11-24T03:00:00.000Z',
  is_summary: false,
  is_compressed: false,
  is_edited: false,
  via: 'items',
  items: ['ci-2', 'ci-3'],
}

const ANSWER: AgentMessage = {
  id: 'm2',
  session_id: 's1',
  role: 'assistant',
  content: '两条都处理完了。',
  created_at: '2026-11-24T03:01:00.000Z',
  is_summary: false,
  is_compressed: false,
  is_edited: false,
}

beforeEach(() => {
  resetCabinItemsForTests()
  vi.clearAllMocks()
  fetchItems.mockResolvedValue({ items: ITEMS, open: 2 })
  closeItemsApi.mockResolvedValue(
    ITEMS.map((row) => ({ ...row, status: 'done' as const, closed_at: '2026-11-24T03:02:00.000Z' })),
  )
})

afterEach(() => cleanup())

describe('CockpitItemReceipt — 关项回执', () => {
  it('本轮未收口（没有后续 assistant）不出现', async () => {
    render(<CockpitItemReceipt cabinId="c1" message={USER_MSG} messages={[USER_MSG]} />)
    await waitFor(() => expect(fetchItems).toHaveBeenCalled())
    expect(screen.queryByTestId('cockpit-items-receipt')).toBeNull()
  })

  it('收口后列出事项；完成 → close API，卡片收成已关闭', async () => {
    render(<CockpitItemReceipt cabinId="c1" message={USER_MSG} messages={[USER_MSG, ANSWER]} />)
    const card = await screen.findByTestId('cockpit-items-receipt')
    expect(card).toHaveTextContent('#IT-2')
    expect(card).toHaveTextContent('时间列太窄')
    expect(card).toHaveTextContent('待确认')

    fireEvent.click(screen.getByTestId('cockpit-items-receipt-done'))
    expect(closeItemsApi).toHaveBeenCalledWith('c1', ['ci-2', 'ci-3'], 'done')
    await waitFor(() => expect(screen.getByTestId('cockpit-items-receipt')).toHaveTextContent('已关闭为「完成」'))
  })

  it('搁置 → close API 带 dropped', async () => {
    closeItemsApi.mockResolvedValue(
      ITEMS.map((row) => ({ ...row, status: 'dropped' as const, closed_at: '2026-11-24T03:02:00.000Z' })),
    )
    render(<CockpitItemReceipt cabinId="c1" message={USER_MSG} messages={[USER_MSG, ANSWER]} />)
    await screen.findByTestId('cockpit-items-receipt')

    fireEvent.click(screen.getByTestId('cockpit-items-receipt-drop'))
    expect(closeItemsApi).toHaveBeenCalledWith('c1', ['ci-2', 'ci-3'], 'dropped')
    await waitFor(() => expect(screen.getByTestId('cockpit-items-receipt')).toHaveTextContent('已关闭为「搁置」'))
  })
})
