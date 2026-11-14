// S1 状态层契约测试：URL parse/serialize、默认选中、Esc 栈顺序、fx nonce 递增。
// 不测渲染细节 —— 星野/布局由后续 Step 的 RTL 覆盖。

import { describe, it, expect } from 'vitest'
import { act, fireEvent, render, renderHook } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { matchAppRoute } from '@/lib/routes'
import { CockpitStateProvider, useCockpitState } from '../CockpitStateProvider'
import { CockpitLayerStack } from '../CockpitLayerStack'
import {
  cockpitHrefPreserving,
  parseCockpitUrl,
  resolveDefaultRef,
  serializeCockpitHref,
  type CockpitCandidate,
} from '../../entry/cockpit-url'

function wrapper({ children }: { children: ReactNode }) {
  return <CockpitStateProvider entryCabinId="c1">{children}</CockpitStateProvider>
}

describe('cockpit URL 契约', () => {
  it('参数优先级 job > task > attn，tab 只认合法值', () => {
    expect(parseCockpitUrl('?job=j1&task=t1&attn=a1&tab=run', 'c1')).toEqual({
      ref: { kind: 'job', cabinId: 'c1', id: 'j1' },
      tab: 'run',
    })
    expect(parseCockpitUrl('?task=t1&attn=a1', 'c1').ref).toEqual({
      kind: 'task',
      cabinId: 'c1',
      id: 't1',
    })
    expect(parseCockpitUrl('?attn=a1', 'c1').ref).toEqual({
      kind: 'attention',
      cabinId: 'c1',
      id: 'a1',
    })
    expect(parseCockpitUrl('?tab=nope', 'c1')).toEqual({ ref: null, tab: null })
    expect(parseCockpitUrl('', 'c1')).toEqual({ ref: null, tab: null })
  })

  it('serialize：attention 用 attn，默认页签省略，空选中回裸路径', () => {
    expect(serializeCockpitHref('c1', { kind: 'job', cabinId: 'c1', id: 'j1' }, 'overview'))
      .toBe('/cabin/c1/cockpit?job=j1')
    expect(serializeCockpitHref('c1', { kind: 'attention', cabinId: 'c1', id: 'a1' }, 'run'))
      .toBe('/cabin/c1/cockpit?attn=a1&tab=run')
    expect(serializeCockpitHref('c1', null)).toBe('/cabin/c1/cockpit')
  })

  it('serialize → parse 往返一致', () => {
    const href = serializeCockpitHref('c1', { kind: 'task', cabinId: 'c1', id: 't1' }, 'changes')
    const query = href.slice(href.indexOf('?'))
    expect(parseCockpitUrl(query, 'c1')).toEqual({
      ref: { kind: 'task', cabinId: 'c1', id: 't1' },
      tab: 'changes',
    })
  })

  it('跨舱 ref 带 &cabin=，同舱不带；往返后所属舱不丢', () => {
    const cross = serializeCockpitHref('c1', { kind: 'job', cabinId: 'c2', id: 'j9' }, 'run')
    expect(cross).toBe('/cabin/c1/cockpit?job=j9&cabin=c2&tab=run')
    expect(parseCockpitUrl(cross.slice(cross.indexOf('?')), 'c1')).toEqual({
      ref: { kind: 'job', cabinId: 'c2', id: 'j9' },
      tab: 'run',
    })

    const same = serializeCockpitHref('c1', { kind: 'job', cabinId: 'c1', id: 'j1' })
    expect(same).toBe('/cabin/c1/cockpit?job=j1')
  })

  it('URL 同步保留调用方参数（?demo=1），只重写座舱自己的', () => {
    expect(
      cockpitHrefPreserving('c1', { kind: 'job', cabinId: 'c1', id: 'j1' }, 'run', '?demo=1&x=2'),
    ).toBe('/cabin/c1/cockpit?job=j1&tab=run&demo=1&x=2')
    // 旧的座舱参数不残留（换选中后不重复 / 不留旧值）
    expect(
      cockpitHrefPreserving('c1', null, null, '?job=old&tab=run&demo=1'),
    ).toBe('/cabin/c1/cockpit?demo=1')
  })
})

describe('默认选中解析', () => {
  const candidates: CockpitCandidate[] = [
    { ref: { kind: 'job', cabinId: 'c1', id: 'queued' }, group: 'queue' },
    { ref: { kind: 'job', cabinId: 'c1', id: 'need-low' }, group: 'need', priority: 2 },
    { ref: { kind: 'job', cabinId: 'c1', id: 'running' }, group: 'run' },
    { ref: { kind: 'job', cabinId: 'c1', id: 'need-high' }, group: 'need', priority: 9 },
    { ref: { kind: 'job', cabinId: 'c1', id: 'done' }, group: 'done' },
  ]

  it('需要你（priority 降序）优先，其次运行中，其次排队', () => {
    expect(resolveDefaultRef(candidates)).toEqual({
      kind: 'job',
      cabinId: 'c1',
      id: 'need-high',
    })
    expect(resolveDefaultRef(candidates.filter((c) => c.group !== 'need'))).toEqual({
      kind: 'job',
      cabinId: 'c1',
      id: 'running',
    })
    expect(
      resolveDefaultRef(candidates.filter((c) => c.group === 'queue' || c.group === 'done')),
    ).toEqual({ kind: 'job', cabinId: 'c1', id: 'queued' })
    expect(resolveDefaultRef([])).toBeNull()
  })
})

describe('路由', () => {
  it('cockpit 是独立兄弟壳，不吞 /cabin/:id', () => {
    const cockpit = matchAppRoute('/cabin/c1/cockpit')
    expect(cockpit.route).toMatchObject({
      kind: 'cabin',
      id: 'cabin-cockpit',
      componentKey: 'cabin-cockpit',
    })
    expect(cockpit.params.cabinId).toBe('c1')

    const shell = matchAppRoute('/cabin/c1')
    expect(shell.route).toMatchObject({
      kind: 'cabin',
      id: 'cabin',
      componentKey: 'cabin-shell',
    })
  })
})

describe('CockpitStateProvider', () => {
  it('初始契约：选中为空、chat 未就绪、浮窗默认值', () => {
    const { result } = renderHook(() => useCockpitState(), { wrapper })
    expect(result.current.entryCabinId).toBe('c1')
    expect(result.current.selection).toBeNull()
    expect(result.current.tab).toBe('overview')
    expect(result.current.chat).toBeNull()
    expect(result.current.railOpen).toBe(false)
    expect(result.current.chatWindow).toMatchObject({
      open: false,
      mini: false,
      pinned: false,
      alpha: 0.94,
      rect: null,
    })
    expect(result.current.fx.pulseNonce).toBe(0)
    expect(result.current.fx.lastSaid).toBeNull()
  })

  it('select 同步 tab；chatWindow 的 set / openWithFocus', () => {
    const { result } = renderHook(() => useCockpitState(), { wrapper })

    act(() => result.current.select({ kind: 'job', cabinId: 'c1', id: 'j1' }, 'run'))
    expect(result.current.selection).toEqual({ kind: 'job', cabinId: 'c1', id: 'j1' })
    expect(result.current.tab).toBe('run')

    act(() => result.current.chatWindow.openWithFocus())
    expect(result.current.chatWindow.open).toBe(true)
    expect(result.current.chatWindow.mini).toBe(false)

    act(() => result.current.chatWindow.set({ mini: true, alpha: 0.7 }))
    expect(result.current.chatWindow.mini).toBe(true)
    expect(result.current.chatWindow.alpha).toBe(0.7)
  })

  it('fx 只递增 nonce（每次调用都触发渲染），say 走 lastSaid', () => {
    const { result } = renderHook(() => useCockpitState(), { wrapper })

    act(() => result.current.fx.pulse('#123456'))
    expect(result.current.fx.pulseNonce).toBe(1)
    expect(result.current.fx.pulseColor).toBe('#123456')

    act(() => result.current.fx.pulse())
    expect(result.current.fx.pulseNonce).toBe(2)
    expect(result.current.fx.pulseColor).toBe('#123456')

    act(() => result.current.fx.edge('#abcdef'))
    expect(result.current.fx.edgeNonce).toBe(1)
    expect(result.current.fx.edgeColor).toBe('#abcdef')

    act(() => result.current.fx.jump())
    act(() => result.current.fx.jump())
    expect(result.current.fx.jumpNonce).toBe(2)

    act(() => result.current.fx.say('汐音在。', 'idle'))
    expect(result.current.fx.lastSaid).toEqual({ nonce: 1, line: '汐音在。', mood: 'idle' })
    act(() => result.current.fx.say('再看一眼'))
    expect(result.current.fx.lastSaid).toEqual({ nonce: 2, line: '再看一眼', mood: undefined })
  })
})

describe('CockpitLayerStack', () => {
  function Layer({
    id,
    priority,
    onClose,
  }: {
    id: string
    priority: number
    onClose: () => void
  }) {
    const { layer } = useCockpitState()
    useEffect(() => layer.register(id, priority, onClose), [layer, id, priority, onClose])
    return null
  }

  it('Esc 按 priority 高→低、同 priority 后注册者优先；栈空不吞事件', () => {
    const closes: string[] = []
    render(
      <CockpitStateProvider entryCabinId="c1">
        <CockpitLayerStack>
          <Layer id="face" priority={10} onClose={() => closes.push('face')} />
          <Layer id="chat" priority={20} onClose={() => closes.push('chat')} />
          <Layer id="popover-a" priority={30} onClose={() => closes.push('popover-a')} />
          <Layer id="popover-b" priority={30} onClose={() => closes.push('popover-b')} />
        </CockpitLayerStack>
      </CockpitStateProvider>,
    )

    for (let i = 0; i < 5; i++) fireEvent.keyDown(window, { key: 'Escape' })

    expect(closes).toEqual(['popover-b', 'popover-a', 'chat', 'face'])
  })

  it('closeTop 在空栈返回 false', () => {
    const { result } = renderHook(() => useCockpitState(), { wrapper })
    expect(result.current.layer.closeTop()).toBe(false)
  })
})
