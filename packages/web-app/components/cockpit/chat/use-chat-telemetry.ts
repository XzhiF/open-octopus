'use client'

// S5 owns this file —— telemetry 上报的防环阀。
//
// ChatPane 每次渲染都会重建一组 handler（setModel / stop…）。如果直接把它们
// 放进上报 effect 的依赖里，`reportChat` 写进 Provider → Provider 重渲染 →
// ChatPane 重渲染 → handler 换了新引用 → 再上报 …… 就是一个无限渲染环。
//
// 这里只把**每次渲染都稳定**的 `api` 对象当依赖：ChatPane 用 useMemo 按真实值
// 组装它，值不变时引用不变；回调本身放 ref，永远调用最新的一份，不参与 deps。

import { useEffect, useRef } from 'react'
import type { CockpitChatApi } from '../state/cockpit-state'

export function useChatTelemetry(
  api: CockpitChatApi,
  onTelemetry?: (api: CockpitChatApi | null) => void,
) {
  const callbackRef = useRef(onTelemetry)

  // 先刷新回调（同一 commit 内比下面的上报 effect 更早执行）。
  useEffect(() => {
    callbackRef.current = onTelemetry
  })

  useEffect(() => {
    callbackRef.current?.(api)
  }, [api])

  // 卸载 = 会话接不上了：回 null，舰桥回到「未就绪」，不留下过期读数。
  useEffect(() => () => {
    callbackRef.current?.(null)
  }, [])
}
