// packages/server/src/middleware/device-auth.ts
//
// M3 · 设备令牌闸（2026-11-27）。
//
// 谁算「本机」：**直连回环**的请求。tailscale serve 也是从 127.0.0.1 连进来的，
// 所以只认回环会把整个 tailnet 当本机 —— 必须叠加两个反向代理信号：
//   ① 带 X-Forwarded-For / X-Forwarded-Proto / Forwarded 任一；
//   ② Host 是 *.ts.net。
// 命中任一即按远程处理，要求 `Authorization: Bearer <device-token>`。
//
// 这个判定依赖 http 桥（index.ts）写入的 `x-octopus-peer`，它会覆盖客户端同名头。
// 没有这个头 = 进程内直调（app.fetch / 单测），按本机处理 —— 生产网络请求
// 一律经过 http 桥，不存在这条路径。

import type { MiddlewareHandler } from "hono"
import type { DeviceRow } from "../db/types"

export const PEER_HEADER = "x-octopus-peer"

export type DeviceLookup = (token: string) => DeviceRow | null

const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])
const TS_NET_HOST = /(^|\.)ts\.net(:\d+)?$/i

/** 免鉴权的路径：探活 / 兑换码 / 配对码（路由自己只允许回环） / 对话图片（<img> 带不了头）。 */
const EXEMPT_PATHS = new Set([
  "/api/actuator/health",
  "/api/pair/redeem",
  "/api/pair/code",
])
const EXEMPT_PREFIXES = ["/api/chat-media/"]

/**
 * 由 socket 地址 + 原始请求头判定这条连接是不是「本机直连」。
 * 导出给 http 桥使用；客户端自带的 `x-octopus-peer` 会被桥覆盖，不能拿来冒充。
 */
export function peerFromConnection(
  remoteAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): "local" | "remote" {
  if (!remoteAddress || !LOOPBACK_ADDRS.has(remoteAddress)) return "remote"
  const proxied =
    headers["x-forwarded-for"] !== undefined ||
    headers["x-forwarded-proto"] !== undefined ||
    headers["forwarded"] !== undefined
  if (proxied) return "remote"
  const host = headerValue(headers["host"]) ?? ""
  if (TS_NET_HOST.test(host)) return "remote"
  return "local"
}

/** 中间件与路由共用的判定：只信 http 桥写的头。 */
export function isLocalRequest(headers: Headers): boolean {
  const peer = headers.get(PEER_HEADER)
  if (peer !== null) return peer === "local"
  return true
}

export function bearerToken(raw: string | undefined): string | null {
  if (!raw) return null
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim())
  const token = match?.[1]?.trim() ?? ""
  return token.length > 0 ? token : null
}

/**
 * WebSocket 升级的同口径守卫。
 *
 * HTTP 中间件管不到 `ws://` 握手，但工作区文档同样是可写面 —— 不补这一道，
 * tailnet 里任何人只要知道 workspace id 就能绕过令牌改文档。浏览器 WS 带不了
 * Authorization 头，所以远程一律走 `?token=<device-token>`；本机直连照旧放行。
 */
export function isAllowedUpgrade(
  remoteAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  requestUrl: string | undefined,
  lookup: DeviceLookup,
): boolean {
  if (peerFromConnection(remoteAddress, headers) === "local") return true
  let fromQuery: string | null = null
  try {
    fromQuery = new URL(requestUrl ?? "/", "http://localhost").searchParams.get("token")
  } catch {
    fromQuery = null
  }
  const token = fromQuery ?? bearerToken(headerValue(headers["authorization"]))
  if (!token) return false
  try {
    return lookup(token) !== null
  } catch {
    return false
  }
}

export function createDeviceAuthMiddleware(lookup: DeviceLookup): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === "OPTIONS") return next()
    if (isLocalRequest(c.req.raw.headers)) return next()

    const path = new URL(c.req.url).pathname
    if (EXEMPT_PATHS.has(path) || EXEMPT_PREFIXES.some((p) => path.startsWith(p))) {
      return next()
    }

    const token = bearerToken(c.req.header("Authorization"))
    if (token) {
      try {
        if (lookup(token)) return next()
      } catch {
        // DB 还没起来（启动窗口）：诚实 503，不把「未知」说成「令牌错」。
        return c.json({ error: "unavailable", message: "服务还没准备好，稍后重试" }, 503)
      }
    }

    c.header("WWW-Authenticate", 'Bearer realm="octopus"')
    return c.json(
      { error: "unauthorized", message: "需要设备令牌 —— 在电脑「设置 → 手机配对」生成配对码" },
      401,
    )
  }
}

function headerValue(raw: string | string[] | undefined): string | undefined {
  if (typeof raw === "string") return raw
  if (Array.isArray(raw)) return raw[0]
  return undefined
}
