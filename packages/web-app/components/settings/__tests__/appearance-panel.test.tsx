// 设置 → 外观：作业坞文字开关读写同一个偏好，已打开的坞会即时跟随。

import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { AppearancePanel } from "../appearance-panel"
import { __resetDockLabelsForTests, getDockLabelsVisible } from "@/lib/ui-preferences"

beforeEach(() => {
  localStorage.clear()
  __resetDockLabelsForTests()
})

describe("AppearancePanel — 作业坞", () => {
  it("默认开启；点开关落盘为关闭，再点恢复", () => {
    render(<AppearancePanel />)

    const toggle = screen.getByTestId("dock-labels-switch")
    expect(toggle.getAttribute("data-state")).toBe("checked")

    fireEvent.click(toggle)
    expect(getDockLabelsVisible()).toBe(false)
    expect(localStorage.getItem("octopus.ui.dockLabels.v1")).toBe("false")
    expect(toggle.getAttribute("data-state")).toBe("unchecked")

    fireEvent.click(toggle)
    expect(getDockLabelsVisible()).toBe(true)
    expect(toggle.getAttribute("data-state")).toBe("checked")
  })
})
