// S5 · telemetry 上报的防环阀（useChatTelemetry）。
//
// 这里用真的 CockpitStateProvider：reportChat 写进 Provider → 全树重渲染。
// 如果上报 effect 把「每次渲染都新建的回调」放进依赖，就会 reportChat →
// 重渲染 → 再上报 无限转。断言：值变才上报，渲染次数有界。

import { useMemo } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { CockpitStateProvider, useCockpitState } from '../../state/CockpitStateProvider'
import { useChatTelemetry } from '../use-chat-telemetry'
import type { CockpitChatApi } from '../../state/cockpit-state'

let renders = 0
let reports = 0

function Probe({ model }: { model: string }) {
  renders += 1
  const { reportChat, chat } = useCockpitState()
  const api = useMemo<CockpitChatApi>(() => ({
    model,
    effort: 'high',
    contextWindow: '200k',
    streaming: false,
    queueDepth: 0,
    canSend: true,
    contextUsage: null,
    usage: null,
    submit() {},
    stop() {},
    setModel() {},
    setEffort() {},
    setContext() {},
  }), [model])
  // 故意每帧新建回调（模拟 ChatPane 里 useComposerSettings 的 setter）：
  // 依赖里若有它，这个测试就会炸成无限渲染。
  useChatTelemetry(api, (next) => {
    reports += 1
    reportChat(next)
  })
  return <span data-testid="model">{chat?.model ?? 'null'}</span>
}

describe('useChatTelemetry — 值变化才上报，不引发无限渲染', () => {
  beforeEach(() => {
    renders = 0
    reports = 0
  })

  it('把 api 值透出到 CockpitState，且只在值变化时再报一次', async () => {
    const { rerender } = render(
      <CockpitStateProvider entryCabinId="cabin-1">
        <Probe model="pro" />
      </CockpitStateProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('model')).toHaveTextContent('pro'))
    expect(reports).toBe(1)

    rerender(
      <CockpitStateProvider entryCabinId="cabin-1">
        <Probe model="se" />
      </CockpitStateProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('model')).toHaveTextContent('se'))

    // 两次值变化 = 两次上报；再多就是环。
    expect(reports).toBe(2)
    expect(renders).toBeLessThan(10)
  })
})
