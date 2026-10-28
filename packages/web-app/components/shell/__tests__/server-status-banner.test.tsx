import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ServerHealthResult } from "@/hooks/use-server-health"

import { ServerStatusBanner } from "../server-status-banner"

function health(overrides: Partial<ServerHealthResult> = {}): ServerHealthResult {
  return {
    status: "offline",
    serverUrl: "http://localhost:3001",
    detail: "无法建立连接",
    failures: 2,
    lastOnlineAt: null,
    retry: vi.fn(),
    ...overrides,
  }
}

describe("ServerStatusBanner", () => {
  it("在线 / 首次探测中不渲染", () => {
    for (const status of ["online", "checking"] as const) {
      const { container, unmount } = render(
        <ServerStatusBanner health={health({ status })} />,
      )
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })

  it("离线：显示服务地址与重试按钮，点击触发 retry", () => {
    const retry = vi.fn()
    render(<ServerStatusBanner health={health({ retry })} />)

    const banner = screen.getByTestId("server-status-banner")
    expect(banner).toHaveAttribute("data-status", "offline")
    expect(banner).toHaveTextContent("后端服务未连接")
    expect(banner).toHaveTextContent("http://localhost:3001")
    expect(banner).toHaveTextContent("已重试 2 次")

    fireEvent.click(screen.getByTestId("server-status-retry"))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it("服务端 5xx：显示「服务异常」而不是「未连接」", () => {
    render(
      <ServerStatusBanner
        health={health({ status: "degraded", detail: "服务端未就绪 (HTTP 503)" })}
      />,
    )
    const banner = screen.getByTestId("server-status-banner")
    expect(banner).toHaveTextContent("后端服务异常")
    expect(banner).toHaveTextContent("服务端未就绪 (HTTP 503)")
    expect(banner).not.toHaveTextContent("后端服务未连接")
  })
})
