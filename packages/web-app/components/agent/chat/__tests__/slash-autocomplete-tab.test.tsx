import { fireEvent, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import {
  SlashCommandAutocomplete,
  type SlashCommand,
} from "../SlashCommandAutocomplete"

const COMMANDS: SlashCommand[] = [
  { name: "compact", description: "压缩会话上下文", kind: "builtin" },
  { name: "octo-wiki", kind: "skill" },
  { name: "octo-guide", kind: "skill" },
]

function renderAutocomplete(onSelect = vi.fn()) {
  render(
    <SlashCommandAutocomplete
      inputValue="/octo"
      commands={COMMANDS}
      onSelect={onSelect}
      onOpenChange={vi.fn()}
    />,
  )
  return onSelect
}

describe("斜杠命令 Tab 补全（2026-11-19 用户追加）", () => {
  it("Tab 插入当前高亮项，与点击同义", () => {
    const onSelect = renderAutocomplete()
    fireEvent.keyDown(document, { key: "Tab" })
    expect(onSelect).toHaveBeenCalledWith("octo-wiki")
  })

  it("↓ 换高亮后 Tab 插入第二项", () => {
    const onSelect = renderAutocomplete()
    fireEvent.keyDown(document, { key: "ArrowDown" })
    fireEvent.keyDown(document, { key: "Tab" })
    expect(onSelect).toHaveBeenCalledWith("octo-guide")
  })

  it("Enter 仍只认精确命令：partial 不补全，保留输入", () => {
    const onSelect = renderAutocomplete()
    fireEvent.keyDown(document, { key: "Enter" })
    expect(onSelect).not.toHaveBeenCalled()
  })
})
