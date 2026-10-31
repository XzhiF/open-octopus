import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetDockLabelsForTests,
  getDockLabelsVisible,
  setDockLabelsVisible,
  subscribeDockLabels,
} from "../ui-preferences"

beforeEach(() => {
  localStorage.clear()
  __resetDockLabelsForTests()
})

describe("作业坞文字标签偏好", () => {
  it("默认常驻显示", () => {
    expect(getDockLabelsVisible()).toBe(true)
  })

  it("关闭后落盘并通知订阅者；退订后不再收到", () => {
    const listener = vi.fn()
    const off = subscribeDockLabels(listener)

    setDockLabelsVisible(false)
    expect(getDockLabelsVisible()).toBe(false)
    expect(localStorage.getItem("octopus.ui.dockLabels.v1")).toBe("false")
    expect(listener).toHaveBeenCalledTimes(1)

    off()
    setDockLabelsVisible(true)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getDockLabelsVisible()).toBe(true)
  })

  it("其它标签页写入（storage 事件）也会通知", () => {
    const listener = vi.fn()
    const off = subscribeDockLabels(listener)

    localStorage.setItem("octopus.ui.dockLabels.v1", "false")
    window.dispatchEvent(
      new StorageEvent("storage", { key: "octopus.ui.dockLabels.v1", newValue: "false" }),
    )

    expect(listener).toHaveBeenCalledTimes(1)
    expect(getDockLabelsVisible()).toBe(false)
    off()
  })
})
