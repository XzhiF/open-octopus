// 设置 → 手机配对（M3）：配对码展示 + 设备列表 + 吊销 + 非本机的 403 提示。
// 网络层用 fetch mock（与 billing-page 测试同惯例），不连真实 server。

import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { DevicePairingPanel } from "../device-pairing-panel"

const NOW = "2026-11-27T02:00:00.000Z"

const DEVICES = [
  {
    id: "d1",
    name: "书房手机",
    platform: "android",
    token_prefix: "abcdef12",
    created_at: NOW,
    last_seen_at: NOW,
    revoked_at: null,
    ssh_key_slot: "slot-01",
  },
  {
    id: "d2",
    name: "旧手机",
    platform: null,
    token_prefix: "99887766",
    created_at: NOW,
    last_seen_at: null,
    revoked_at: NOW,
    ssh_key_slot: null,
  },
]

const REMOTE_READY = {
  installed: true,
  platform: "win32",
  os: "windows",
  ssh_user: "EDY",
  ssh_port: 22,
  task_name: "Octopus",
  installed_at: NOW,
  slots_total: 8,
  slots_available: 6,
  tailscale_hosts: ["shufang-pc.tail1234.ts.net"],
}

const REMOTE_MISSING = {
  installed: false,
  platform: "win32",
  os: null,
  ssh_user: null,
  ssh_port: null,
  task_name: null,
  installed_at: null,
  slots_total: 0,
  slots_available: 0,
  tailscale_hosts: [],
}

const REMOTE_READY_MAC = {
  ...REMOTE_READY,
  platform: "darwin",
  os: "macos",
  ssh_user: "xzf",
  task_name: "com.octopus.desktop.agent",
}

const REMOTE_MISSING_MAC = {
  ...REMOTE_MISSING,
  platform: "darwin",
}

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body }
}

interface Call {
  url: string
  method: string
}

let calls: Call[] = []

function mockFetch(opts: { codeStatus?: number; remote?: unknown; remoteSequence?: unknown[] } = {}) {
  calls = []
  let statusCalls = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: RequestInit = {}) => {
      const u = String(url)
      const method = (init.method ?? "GET").toUpperCase()
      calls.push({ url: u, method })
      if (u.endsWith("/api/devices") && method === "GET") return json({ devices: DEVICES })
      if (u.endsWith("/api/remote/status") && method === "GET") {
        if (opts.remoteSequence) {
          const value = opts.remoteSequence[Math.min(statusCalls, opts.remoteSequence.length - 1)]
          statusCalls++
          return json(value)
        }
        return json(opts.remote ?? REMOTE_READY)
      }
      if (u.endsWith("/api/remote/setup") && method === "POST") {
        return json({ started: true, installer: "C:\\x\\install-remote.ps1" }, 202)
      }
      if (u.endsWith("/api/devices/d1") && method === "DELETE") return json(null, 204)
      if (u.endsWith("/api/pair/code") && method === "POST") {
        if (opts.codeStatus === 403) {
          return json({ error: "forbidden", message: "只能在电脑本机操作" }, 403)
        }
        return json({ code: "246810", expires_at: new Date(Date.now() + 120_000).toISOString() })
      }
      if (u.endsWith("/api/devices/d1") && method === "PATCH") {
        return json({ device: { ...DEVICES[0], name: "书房新手机" } })
      }
      return json({})
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch()
})

describe("手机配对面板", () => {
  it("列出设备：有效 / 已吊销、令牌前缀、活跃台数", async () => {
    render(<DevicePairingPanel />)

    expect(await screen.findByText("书房手机")).toBeTruthy()
    expect(screen.getByText("旧手机")).toBeTruthy()
    expect(screen.getByText("1 台有效")).toBeTruthy()
    expect(screen.getByText("已吊销")).toBeTruthy()
    expect(screen.getByText(/令牌 abcdef12…/)).toBeTruthy()
  })

  it("生成配对码：6 位分组展示 + 倒计时", async () => {
    render(<DevicePairingPanel />)
    await screen.findByText("书房手机")

    fireEvent.click(screen.getByTestId("pair-code-button"))

    expect(await screen.findByTestId("pair-code")).toBeTruthy()
    expect(screen.getByText("246 810")).toBeTruthy()
    expect(screen.getByText(/秒后失效/)).toBeTruthy()
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/pair/code"))).toBe(true)
  })

  it("非本机生成被拒（403）→ 给出「只能在电脑本机」的提示", async () => {
    mockFetch({ codeStatus: 403 })
    render(<DevicePairingPanel />)
    await screen.findByText("书房手机")

    fireEvent.click(screen.getByTestId("pair-code-button"))

    const error = await screen.findByTestId("pairing-error")
    expect(error.textContent).toContain("只能在这台电脑上生成配对码")
    expect(screen.queryByTestId("pair-code")).toBeNull()
  })

  it("吊销设备 → DELETE 后重新拉列表", async () => {
    vi.stubGlobal("confirm", () => true)
    render(<DevicePairingPanel />)
    await screen.findByText("书房手机")

    fireEvent.click(screen.getAllByTestId("revoke-device")[0])

    await waitFor(() => {
      expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/api/devices/d1"))).toBe(true)
    })
    await waitFor(() => {
      expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/api/devices")).length).toBeGreaterThan(1)
    })
  })

  it("远程拉起已就绪：显示槽位余量与 SSH 用户；设备行带远程槽位标记", async () => {
    render(<DevicePairingPanel />)
    await screen.findByText("书房手机")

    expect(await screen.findByText("已就绪")).toBeTruthy()
    expect(screen.getByText("密钥槽 6 / 8")).toBeTruthy()
    expect(screen.getByText(/SSH EDY@22/)).toBeTruthy()
    expect(screen.getByText("远程 slot-01")).toBeTruthy()
  })

  it("远程拉起未安装：给出管理员安装命令", async () => {
    mockFetch({ remote: REMOTE_MISSING })
    render(<DevicePairingPanel />)
    await screen.findByText("书房手机")

    expect(await screen.findByText("未安装")).toBeTruthy()
    expect(screen.getByTestId("remote-status").textContent).toContain("install-remote.ps1")
  })

  it("macOS 未安装：文案走管理员授权与 install-remote.sh，不再提 UAC", async () => {
    mockFetch({ remote: REMOTE_MISSING_MAC })
    render(<DevicePairingPanel />)
    await screen.findByText("书房手机")

    expect(await screen.findByText("未安装")).toBeTruthy()
    const box = screen.getByTestId("remote-status").textContent ?? ""
    expect(box).toContain("管理员授权")
    expect(box).toContain("install-remote.sh")
    expect(box).not.toContain("UAC")
  })

  it("macOS 已就绪：状态行显示「登录项」而不是 Windows 的计划任务", async () => {
    mockFetch({ remote: REMOTE_READY_MAC })
    render(<DevicePairingPanel />)
    await screen.findByText("书房手机")

    expect(await screen.findByText("已就绪")).toBeTruthy()
    expect(screen.getByTestId("remote-status").textContent).toContain("登录项 com.octopus.desktop.agent")
  })

  it("未安装时点「启用远程拉起」→ 发起安装并轮询到已就绪", async () => {
    mockFetch({ remoteSequence: [REMOTE_MISSING, REMOTE_READY] })
    render(<DevicePairingPanel />)
    await screen.findByText("书房手机")

    fireEvent.click(screen.getByTestId("remote-setup-button"))

    expect(await screen.findByText("已就绪")).toBeTruthy()
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/remote/setup"))).toBe(true)
  })
})
