// packages/web-app/lib/__tests__/server-config.test.ts
//
// 2026-10-30 用户 bug：dev 页面从 localhost:3000 直连 100.104.28.35:3001
// （本机 Tailscale IP），一次网络层失败被浏览器报成 CORS，实录补拉失败 →
// 「Failed to load messages」。页面本身在回环地址时改回回环主机；其它访问方式
// （手机走 LAN、隧道、Electron 注入）保持原样。
import { describe, it, expect } from "vitest"
import { resolveServerUrl } from "../server-config"

const base = {
  dev: true,
  pageOrigin: "http://localhost:3000",
  pageHost: "localhost",
}

describe("resolveServerUrl", () => {
  it("Electron 注入优先且不重写", () => {
    expect(
      resolveServerUrl({
        ...base,
        injected: "http://100.104.28.35:3001/",
        meta: "http://127.0.0.1:9999",
      }),
    ).toBe("http://100.104.28.35:3001")
  })

  it("localhost 页面 → 纯 IP 的 meta 改回 localhost（同端口）", () => {
    expect(
      resolveServerUrl({ ...base, meta: "http://100.104.28.35:3001/" }),
    ).toBe("http://localhost:3001")
  })

  it("127.0.0.1 页面 → 改回 127.0.0.1", () => {
    expect(
      resolveServerUrl({
        ...base,
        pageOrigin: "http://127.0.0.1:3000",
        pageHost: "127.0.0.1",
        meta: "http://192.168.1.9:3001",
      }),
    ).toBe("http://127.0.0.1:3001")
  })

  it("页面已经走 LAN IP 访问 → 保持原目标（手机等设备不受影响）", () => {
    expect(
      resolveServerUrl({
        ...base,
        pageOrigin: "http://192.168.1.9:3000",
        pageHost: "192.168.1.9",
        meta: "http://192.168.1.9:3001",
      }),
    ).toBe("http://192.168.1.9:3001")
  })

  it("命名主机（隧道 / 远端后端）不重写", () => {
    expect(
      resolveServerUrl({ ...base, meta: "https://octopus.example.com:8443" }),
    ).toBe("https://octopus.example.com:8443")
  })

  it("无 meta 的 dev 兜底仍是 localhost:3001；prod 走同源", () => {
    expect(resolveServerUrl(base)).toBe("http://localhost:3001")
    expect(
      resolveServerUrl({
        ...base,
        dev: false,
        pageOrigin: "https://octopus.example.com",
        pageHost: "octopus.example.com",
      }),
    ).toBe("https://octopus.example.com")
  })
})
