// 问答窗组件（design 26 §3.2 / §3.5）：chrome、作答回执、旧服务端回退入口。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CabinAttentionItem } from '@octopus/shared'
import { AskWindowsProvider, useAskWindows } from '../ask-windows-provider'
import { AskWindowLayer } from '../ask-window-layer'
import type { CockpitLayerApi } from '@/components/cockpit/state/cockpit-state'
import { submitCabinDecision, dismissCabinAsk, discussCabinAsk, CabinDecisionError } from '@/lib/cabin-api'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/cabin-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cabin-api')>()
  return { ...actual, submitCabinDecision: vi.fn(), dismissCabinAsk: vi.fn(), discussCabinAsk: vi.fn() }
})
// 窗在舱外也要能提交：给出一个舱 id（真实实现里由 CabinProvider 提供）。
vi.mock('@/components/cabin/cabin-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/cabin/cabin-provider')>()
  return { ...actual, useCabinOptional: () => ({ cabinId: 'c1' }) }
})

const submit = vi.mocked(submitCabinDecision)
const dismiss = vi.mocked(dismissCabinAsk)
const discuss = vi.mocked(discussCabinAsk)

function attn(over: Partial<CabinAttentionItem> = {}): CabinAttentionItem {
  return {
    id: 'ask-a1',
    job_id: null,
    stage: 'answer',
    awaiting: 'person',
    title: '支付接入 · 待回答',
    question: '接哪个渠道？',
    task_id: 't1',
    repo: 'octopus',
    wt: 'feat-pay',
    deep_link: 'ask:a1',
    handle: '#1',
    subject: { kind: 'task', id: 't1' },
    ask: {
      ask_id: 'a1',
      message_id: 'm1',
      author_session_id: 's1',
      decision: '接哪个渠道',
      options: [{ label: '支付宝', impact: '3 天' }],
    },
    ...over,
  }
}

function Harness() {
  const { open, asks } = useAskWindows()
  return (
    <>
      <button type="button" onClick={() => asks[0] && open(asks[0])}>open</button>
    </>
  )
}

function renderWindow(item: CabinAttentionItem) {
  return render(
    <AskWindowsProvider attention={[item]}>
      <Harness />
      <AskWindowLayer mode="cockpit" />
    </AskWindowsProvider>,
  )
}

beforeEach(() => {
  submit.mockReset()
  dismiss.mockReset()
  discuss.mockReset()
})

describe('AskWindow', () => {
  it('标题栏关闭灯组在左；固定上下文；无「去作业面」按钮', () => {
    renderWindow(attn())
    fireEvent.click(screen.getByText('open'))

    const win = screen.getByTestId('ask-window-a1')
    expect(win).toBeInTheDocument()
    expect(win.querySelector('header .ck-askwin-lights button')).toHaveAttribute('aria-label', '关闭问答窗')
    expect(win).toHaveTextContent('支付接入')
    expect(win).toHaveTextContent('等你定')
    expect(win).toHaveTextContent('octopus · feat-pay')
    expect(win).not.toHaveTextContent('去作业面')
  })

  it('窗内作答 → 回执、行消项、回执后自动关窗', async () => {
    submit.mockResolvedValue({
      decision: { askId: 'a1' } as never,
      already: false,
      receipt: { handle: '#1', choice: '支付宝', line: '✓ 已答 · #1 支付宝' },
    })
    renderWindow(attn({
      ask: {
        ask_id: 'a1',
        message_id: 'm1',
        author_session_id: 's1',
        decision: '接哪个渠道',
        options: [{ label: '支付宝', impact: '3 天' }],
        questions: {
          questions: [{
            question: '接哪个渠道？',
            header: '渠道',
            multiSelect: false,
            options: [
              { label: '支付宝', description: '账号现成' },
              { label: '微信', description: '要走资质' },
            ],
          }],
        },
      },
    }))
    fireEvent.click(screen.getByText('open'))

    fireEvent.click(screen.getByRole('radio', { name: /支付宝/ }))
    fireEvent.click(screen.getByRole('button', { name: '提交答案' }))

    await waitFor(() => expect(screen.getByTestId('ask-window-receipt')).toHaveTextContent('✓ 已答'))
    expect(submit).toHaveBeenCalledWith('c1', expect.objectContaining({
      askId: 'a1', choice: '支付宝', source: 'card', taskId: 't1',
    }))
    // 回执当场：标题胶囊先变「已答」，窗还在。
    expect(screen.getByTestId('ask-window-a1')).toHaveTextContent('已答')
    // 1.5s 后自动关窗（v6 口径：处理完自己消失）。
    await waitFor(
      () => expect(screen.queryByTestId('ask-window-a1')).toBeNull(),
      { timeout: 3_000 },
    )
    // 编队行已乐观消项（provider 的 asks 变空 → Harness 无行可开）。
    expect(screen.getByText('open')).toBeInTheDocument()
  })

  it('「还需讨论」→ 走讨论端点（不提交答案），窗不关、回执照常', async () => {
    discuss.mockResolvedValue({
      target: 'thread',
      delivered: true,
      receipt: '已请对方先把这几个选项讲清楚 —— 到对话里继续',
    })
    renderWindow(attn())
    fireEvent.click(screen.getByText('open'))

    fireEvent.click(screen.getByTestId('ask-window-discuss'))
    await waitFor(() => expect(discuss).toHaveBeenCalledWith('c1', { askId: 'a1' }))
    expect(submit).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByTestId('ask-window-discuss-note')).toHaveTextContent('已请对方先把这几个选项讲清楚')
    })
    // 提问仍待答：窗还在，没有「已答」回执。
    expect(screen.getByTestId('ask-window-a1')).toBeInTheDocument()
    expect(screen.queryByTestId('ask-window-receipt')).toBeNull()
  })

  it('旧服务端 404：窗内给「去任务线程回答 →」，不偷偷转发', async () => {
    submit.mockRejectedValue(new CabinDecisionError('ask 不在本舱主对话里', 404))
    renderWindow(attn({ ask: { ask_id: 'a1', decision: '接哪个渠道', options: [{ label: '支付宝' }] } }))
    fireEvent.click(screen.getByText('open'))

    fireEvent.click(screen.getByRole('radio', { name: /支付宝/ }))
    fireEvent.click(screen.getByRole('button', { name: '发送答案' }))

    await waitFor(() => expect(screen.getByTestId('ask-window-error')).toHaveTextContent('去任务线程回答'))
    expect(screen.getByTestId('ask-window-error')).not.toHaveTextContent('已答')
  })

  it('关闭后窗口从 DOM 移除', () => {
    renderWindow(attn())
    fireEvent.click(screen.getByText('open'))
    fireEvent.click(screen.getByRole('button', { name: '关闭问答窗' }))
    expect(screen.queryByTestId('ask-window-a1')).not.toBeInTheDocument()
  })

  it('忽略旧卡：调 dismiss、行消项、窗关闭', async () => {
    dismiss.mockResolvedValue({ dismissed: 1 })
    renderWindow(attn())
    fireEvent.click(screen.getByText('open'))
    fireEvent.click(screen.getByTestId('ask-window-dismiss'))

    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('c1', 'a1'))
    await waitFor(() => expect(screen.queryByTestId('ask-window-a1')).not.toBeInTheDocument())
  })

  it('忽略失败（工作流提问没有会话消息）：窗保留并说明原因', async () => {
    dismiss.mockResolvedValue({ dismissed: 0 })
    renderWindow(attn())
    fireEvent.click(screen.getByText('open'))
    fireEvent.click(screen.getByTestId('ask-window-dismiss'))

    await waitFor(() => expect(screen.getByTestId('ask-window-error')).toHaveTextContent('没有可忽略的会话消息'))
    expect(screen.getByTestId('ask-window-a1')).toBeInTheDocument()
  })
})

describe('AskWindowLayer · Esc', () => {
  it('classic：捕获阶段 Esc 关最上面一扇，尊重 defaultPrevented', () => {
    renderWindow(attn())
    fireEvent.click(screen.getByText('open'))
    expect(screen.getByTestId('ask-window-a1')).toBeInTheDocument()

    // 已处理的 Esc 不再抢（别的层先用掉）
    const blocked = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
    blocked.preventDefault()
    document.dispatchEvent(blocked)
    expect(screen.getByTestId('ask-window-a1')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('ask-window-a1')).not.toBeInTheDocument()
  })

  it('cockpit：注册到 shared layer stack，priority 75', () => {
    let close: (() => void) | null = null
    let priority = 0
    const escLayer: CockpitLayerApi = {
      register: (_id, p, fn) => { priority = p; close = fn; return () => { close = null } },
      closeTop: () => false,
    }
    render(
      <AskWindowsProvider attention={[attn()]}>
        <Harness />
        <AskWindowLayer mode="cockpit" escLayer={escLayer} />
      </AskWindowsProvider>,
    )
    fireEvent.click(screen.getByText('open'))
    expect(priority).toBe(75)
    expect(close).not.toBeNull()
    act(() => close!())
    expect(screen.queryByTestId('ask-window-a1')).not.toBeInTheDocument()
  })
})
