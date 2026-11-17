// 问答窗纯函数（design 26 §5.4）：过滤 / 去重 / 固定落点公式 / 窄屏。
import { describe, it, expect } from 'vitest'
import type { CabinAttentionItem } from '@octopus/shared'
import {
  askRect,
  askWindowTitle,
  clampLeft,
  pendingAsks,
  windowWidthFor,
  COCKPIT_WIN,
  CLASSIC_WIN,
} from '../ask-window-model'

function attn(over: Partial<CabinAttentionItem> = {}): CabinAttentionItem {
  return {
    id: 'ask-a1',
    job_id: null,
    stage: 'answer',
    awaiting: 'person',
    title: '任务一 · 待回答',
    question: '接哪个渠道？',
    task_id: 't1',
    repo: null,
    wt: null,
    deep_link: 'ask:a1',
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

describe('pendingAsks', () => {
  it('只收 stage=answer 且带决策票据的项', () => {
    const list = pendingAsks([
      attn(),
      attn({ id: 'ask-a2', stage: 'review', deep_link: 'task:t1' }),
      // 工作流执行提问：stage=answer 但没有 ask 信封。
      attn({ id: 'ask-a3', ask: undefined }),
      attn({ id: 'ask-a4', ask: { ask_id: '' } }),
    ])
    expect(list.map((a) => a.askId)).toEqual(['a1'])
  })

  it('同一 askId 只出现一次（跨行去重）', () => {
    const list = pendingAsks([attn(), attn({ id: 'ask-dup' })])
    expect(list).toHaveLength(1)
  })

  it('本地已答（乐观集合）立即剔除', () => {
    const list = pendingAsks([attn(), attn({ id: 'ask-a2', ask: { ask_id: 'a2' } })], new Set(['a1']))
    expect(list.map((a) => a.askId)).toEqual(['a2'])
  })

  it('保持 attention 的既有顺序（不重排）', () => {
    const list = pendingAsks([
      attn({ id: 'ask-z', ask: { ask_id: 'z' } }),
      attn({ id: 'ask-y', ask: { ask_id: 'y' } }),
    ])
    expect(list.map((a) => a.askId)).toEqual(['z', 'y'])
  })
})

describe('askRect —— cockpit 固定落点', () => {
  const viewport = { w: 1600, h: 900 }

  it('贴编队右缘 + 10，y 固定 74，宽度 560', () => {
    expect(askRect('cockpit', { railRight: 320, openCount: 0, viewport })).toEqual({
      left: 330, top: 74, width: 560,
    })
  })

  it('多开只向右错开 32px，y 不变', () => {
    const second = askRect('cockpit', { railRight: 320, openCount: 1, viewport })
    expect(second).toEqual({ left: 330 + COCKPIT_WIN.stagger, top: 74, width: 560 })
  })

  it('窄视口（≤1480）用 460 宽档', () => {
    const rect = askRect('cockpit', { railRight: 280, openCount: 0, viewport: { w: 1400, h: 900 } })
    expect(rect.width).toBe(COCKPIT_WIN.wNarrow)
    expect(rect.top).toBe(74)
  })

  it('拿不到编队（抽屉收起）时 x 取 10', () => {
    expect(askRect('cockpit', { railRight: null, openCount: 0, viewport }).left).toBe(10)
  })

  it('右侧越界只夹 x，不改 y / 宽', () => {
    const rect = askRect('cockpit', { railRight: 1500, openCount: 0, viewport })
    expect(rect.left).toBe(viewport.w - rect.width - 8)
    expect(rect.top).toBe(74)
    expect(rect.width).toBe(560)
  })
})

describe('askRect —— classic 固定落点（编队左侧）', () => {
  const viewport = { w: 1920, h: 1000 }

  it('贴编队左缘 − 窗宽 − 10，y 固定 56', () => {
    expect(askRect('classic', { fleetLeft: 1510, openCount: 0, viewport })).toEqual({
      left: 1510 - CLASSIC_WIN.w - 10,
      top: 56,
      width: CLASSIC_WIN.w,
    })
  })

  it('多开只向左错开 32px', () => {
    const first = askRect('classic', { fleetLeft: 1510, openCount: 0, viewport })
    const second = askRect('classic', { fleetLeft: 1510, openCount: 1, viewport })
    expect(first.left - second.left).toBe(CLASSIC_WIN.stagger)
    expect(second.top).toBe(56)
  })

  it('编队隐藏（≤1320 / 未渲染）时窗口贴右', () => {
    const rect = askRect('classic', { fleetLeft: 1000, openCount: 0, viewport: { w: 1280, h: 900 } })
    expect(rect.left).toBe(1280 - CLASSIC_WIN.w - 24)
    expect(askRect('classic', { fleetLeft: null, openCount: 0, viewport }).left)
      .toBe(viewport.w - CLASSIC_WIN.w - 24)
  })

  it('左侧越界夹回 8', () => {
    expect(askRect('classic', { fleetLeft: 300, openCount: 2, viewport }).left).toBe(8)
  })
})

describe('helpers', () => {
  it('windowWidthFor 不超过视口', () => {
    expect(windowWidthFor('cockpit', 500)).toBeLessThanOrEqual(500 - 24)
    expect(windowWidthFor('classic', 900)).toBe(520)
  })

  it('clampLeft 左右都夹', () => {
    expect(clampLeft(-20, 500, 1200)).toBe(8)
    expect(clampLeft(900, 500, 1200)).toBe(1200 - 500 - 8)
  })

  it('askWindowTitle 去掉服务端后缀', () => {
    expect(askWindowTitle(attn())).toBe('任务一')
    expect(askWindowTitle(attn({ title: 'D1 清理日志' }))).toBe('D1 清理日志')
  })
})
