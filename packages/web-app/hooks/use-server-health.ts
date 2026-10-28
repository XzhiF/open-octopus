'use client'

/**
 * 全局后端存活探测。
 *
 * 背景：web(3000) 与 server(3001) 是两个进程，server 挂掉时页面只剩零散的
 * 请求失败，用户看不出「后端整个没连上」。这里在壳层常驻一个轻量探针：
 * - 探 `GET /api/actuator/ready`（不碰 DB 的存活探针，5s 一次；失联后 3s 一次）
 * - 网络错误 / 超时 → offline；HTTP 5xx → degraded（服务在但没就绪）
 * - 状态翻转时发一次 toast（同一个 id，恢复时自动替换），横幅由壳层渲染
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { getServerUrl } from '@/lib/server-config'

export type ServerHealthStatus = 'checking' | 'online' | 'degraded' | 'offline'

export interface ServerHealthState {
  status: ServerHealthStatus
  serverUrl: string
  /** 最近一次异常说明（超时 / HTTP 状态码） */
  detail: string | null
  /** 连续失败次数（恢复后归零） */
  failures: number
  /** 最近一次探测成功的时间戳 */
  lastOnlineAt: number | null
}

export interface ServerHealthResult extends ServerHealthState {
  /** 立刻重探一次（不等下一个轮询间隔） */
  retry: () => void
}

type ProbeResult = {
  status: 'online' | 'degraded' | 'offline'
  detail: string | null
}

export const PROBE_TIMEOUT_MS = 4000
export const HEALTHY_INTERVAL_MS = 5000
export const UNHEALTHY_INTERVAL_MS = 3000
export const SERVER_HEALTH_TOAST_ID = 'octopus-server-health'

/** 单次探测：只有拿不到任何 HTTP 响应才算 offline。 */
export async function probeServerHealth(
  serverUrl: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${serverUrl}/api/actuator/ready`, {
      signal: controller.signal,
      credentials: 'include',
      cache: 'no-store',
    })
    if (res.status >= 500) {
      return { status: 'degraded', detail: `服务端未就绪 (HTTP ${res.status})` }
    }
    // 404 等 4xx 说明进程活着（老版本没有 ready 路由），仍算在线。
    return { status: 'online', detail: null }
  } catch (err) {
    const aborted = (err as { name?: string } | null)?.name === 'AbortError'
    return {
      status: 'offline',
      detail: aborted ? `连接超时（${Math.round(timeoutMs / 1000)}s）` : '无法建立连接',
    }
  } finally {
    clearTimeout(timer)
  }
}

export interface UseServerHealthOptions {
  enabled?: boolean
  /** 健康时的轮询间隔（测试可调小） */
  intervalMs?: number
  /** 异常时的轮询间隔 */
  unhealthyIntervalMs?: number
}

export function useServerHealth(options: UseServerHealthOptions = {}): ServerHealthResult {
  const {
    enabled = true,
    intervalMs = HEALTHY_INTERVAL_MS,
    unhealthyIntervalMs = UNHEALTHY_INTERVAL_MS,
  } = options
  const serverUrl = getServerUrl()

  const [state, setState] = useState<ServerHealthState>({
    status: 'checking',
    serverUrl,
    detail: null,
    failures: 0,
    lastOnlineAt: null,
  })

  // effect 内的一次性轮询循环（自递归 setTimeout，避免并发探针）
  const retryRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let failures = 0
    let previous: ServerHealthStatus = 'checking'

    const check = async () => {
      const result = await probeServerHealth(serverUrl)
      if (cancelled) return

      if (result.status === 'online') {
        failures = 0
        setState((prev) =>
          prev.status === 'online'
            ? prev
            : { ...prev, status: 'online', detail: null, failures: 0, lastOnlineAt: Date.now() },
        )
        if (previous === 'offline' || previous === 'degraded') {
          toast.success('后端服务已恢复', {
            id: SERVER_HEALTH_TOAST_ID,
            description: serverUrl,
            duration: 4000,
          })
        }
      } else {
        failures += 1
        setState((prev) => ({
          ...prev,
          status: result.status,
          detail: result.detail,
          failures,
        }))
        // 同一段故障只弹一次；恢复后再次故障会重新弹。
        if (previous !== result.status) {
          toast.error(result.status === 'offline' ? '后端服务连接失败' : '后端服务响应异常', {
            id: SERVER_HEALTH_TOAST_ID,
            description:
              result.status === 'offline'
                ? `${serverUrl} 无响应，正在自动重试…`
                : `${result.detail ?? '服务异常'} · ${serverUrl}`,
            duration: Infinity,
          })
        }
      }

      previous = result.status
      if (cancelled) return
      const delay = result.status === 'online' ? intervalMs : unhealthyIntervalMs
      timer = setTimeout(() => void check(), delay)
    }

    retryRef.current = () => {
      if (timer) clearTimeout(timer)
      timer = null
      void check()
    }

    void check()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      retryRef.current = () => {}
    }
  }, [enabled, serverUrl, intervalMs, unhealthyIntervalMs])

  const retry = useCallback(() => {
    retryRef.current()
  }, [])

  return { ...state, retry }
}
