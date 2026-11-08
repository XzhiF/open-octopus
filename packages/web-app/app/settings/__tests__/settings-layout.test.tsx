// 设置窗口：只剩「外观」一个分区；日志分析已随功能下线移除。

import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import SettingsLayout from "../layout"

describe("SettingsLayout", () => {
  it("默认打开外观，且不再渲染日志分析入口", () => {
    render(<SettingsLayout panels={{ appearance: <div>外观内容</div> }} />)

    expect(screen.getByText("外观内容")).toBeTruthy()
    // 侧栏 + 页签各一处。
    expect(screen.getAllByText("外观")).toHaveLength(2)
    expect(screen.queryByText("日志分析")).toBeNull()
  })
})