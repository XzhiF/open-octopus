/**
 * 手机配对 API（M3 · 2026-11-27）。
 *
 * 全部是 PC 回环设置页用到的接口：配对码生成、设备列表、改名、吊销。
 * 服务端对这三组非兑换接口都要求「本机直连」——从 ts.net 地址打开 Web 会 403。
 */

import { getServerUrl } from "@/lib/server-config"

export interface PairedDevice {
  id: string
  name: string
  platform: string | null
  token_prefix: string
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
  /** M4：这台手机拿走的 SSH 密钥槽；null = 没配远程拉起。 */
  ssh_key_slot: string | null
}

/** 远程拉起（M4）：install-remote.{ps1,sh} 装没装、密钥槽还剩几把。 */
export interface RemoteControlStatus {
  installed: boolean
  /** 服务端宿主平台：Windows 走 UAC，macOS 走管理员授权 + LaunchAgent。 */
  platform: "win32" | "darwin" | "linux"
  os: string | null
  ssh_user: string | null
  ssh_port: number | null
  task_name: string | null
  installed_at: string | null
  slots_total: number
  slots_available: number
  tailscale_hosts: string[]
  error?: string
}

/** 一键启用：服务端会起一个 UAC 提权的安装器；结果靠轮询 status 得知。 */
export interface RemoteSetupResult {
  started: boolean
  installed?: boolean
  reason?: string
  installer?: string
  message?: string
}

export interface PairCode {
  code: string
  expires_at: string
}

export class PairingApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "PairingApiError"
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getServerUrl()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  })
  if (res.status === 204) return undefined as T
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const message =
      (body && typeof body === "object" && (body.message ?? body.error)) ||
      `HTTP ${res.status}`
    throw new PairingApiError(String(message), res.status)
  }
  return body as T
}

export async function createPairCode(): Promise<PairCode> {
  return call<PairCode>("/api/pair/code", { method: "POST", body: "{}" })
}

export async function listPairedDevices(): Promise<PairedDevice[]> {
  const data = await call<{ devices?: PairedDevice[] }>("/api/devices")
  return Array.isArray(data?.devices) ? data.devices : []
}

export async function getRemoteControlStatus(): Promise<RemoteControlStatus> {
  return call<RemoteControlStatus>("/api/remote/status")
}

export async function enableRemoteControl(): Promise<RemoteSetupResult> {
  return call<RemoteSetupResult>("/api/remote/setup", { method: "POST", body: "{}" })
}

export async function renamePairedDevice(id: string, name: string): Promise<PairedDevice> {
  const data = await call<{ device: PairedDevice }>(`/api/devices/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  })
  return data.device
}

export async function revokePairedDevice(id: string): Promise<void> {
  await call<void>(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" })
}
