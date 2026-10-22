import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const nav = vi.hoisted(() => ({ pathname: "/" }))

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
}))

import { useNavHistory } from "../use-nav-history"

beforeEach(() => {
  nav.pathname = "/"
})

describe("useNavHistory", () => {
  it("记录首页对话，按最近优先去重", () => {
    const { result, rerender } = renderHook(() => useNavHistory())
    expect(result.current.entries.map((entry) => entry.href)).toEqual(["/"])
    expect(result.current.entries[0]).toMatchObject({ label: "对话", sub: "/" })

    act(() => {
      nav.pathname = "/tasks"
    })
    rerender()
    expect(result.current.entries.map((entry) => entry.href)).toEqual(["/tasks", "/"])

    act(() => {
      nav.pathname = "/dashboard"
    })
    rerender()
    expect(result.current.entries.map((entry) => entry.href)).toEqual([
      "/dashboard",
      "/tasks",
      "/",
    ])
    expect(result.current.entries[0]).toMatchObject({
      label: "今日",
      sub: "/dashboard",
    })

    act(() => {
      nav.pathname = "/tasks"
    })
    rerender()
    expect(result.current.entries.map((entry) => entry.href)).toEqual([
      "/tasks",
      "/dashboard",
      "/",
    ])

    act(() => {
      nav.pathname = "/"
    })
    rerender()
    expect(result.current.entries.map((entry) => entry.href)).toEqual([
      "/",
      "/tasks",
      "/dashboard",
    ])
  })

  it("可见 4 条，内部保留更多", () => {
    const { result, rerender } = renderHook(() => useNavHistory())
    for (const pathname of [
      "/tasks",
      "/dashboard",
      "/knowledge",
      "/resources",
      "/scheduler",
      "/settings",
    ]) {
      act(() => {
        nav.pathname = pathname
      })
      rerender()
    }

    expect(result.current.entries).toHaveLength(4)
    expect(result.current.total).toBe(7)
    expect(result.current.entries[0].href).toBe("/settings")
  })

  it("可移除单条记录", () => {
    const { result, rerender } = renderHook(() => useNavHistory())
    act(() => {
      nav.pathname = "/tasks"
    })
    rerender()
    act(() => {
      nav.pathname = "/dashboard"
    })
    rerender()

    act(() => {
      result.current.remove("/tasks")
    })
    expect(result.current.entries.map((entry) => entry.href)).toEqual([
      "/dashboard",
      "/",
    ])
  })
})
