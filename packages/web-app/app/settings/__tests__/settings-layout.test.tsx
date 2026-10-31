// 设置窗口的分区路由：新开 tab 的标题必须取自菜单项，不能写死「日志分析」。

import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import SettingsLayout from "../layout"

describe("SettingsLayout", () => {
  it("默认打开外观；切到日志分析时 tab 标题正确且面板切换", () => {
    render(
      <SettingsLayout
        panels={{
          appearance: <div>外观内容</div>,
          "log-analysis": <div>日志内容</div>,
        }}
      />,
    )

    expect(screen.getByText("外观内容")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /日志分析/ }))

    expect(screen.getByText("日志内容")).toBeTruthy()
    // 侧栏 + 新开的 tab 各一处，说明 tab 标签没有写成「日志分析」以外的旧值。
    expect(screen.getAllByText("日志分析")).toHaveLength(2)
  })
})
