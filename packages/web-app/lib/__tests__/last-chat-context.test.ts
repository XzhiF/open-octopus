// 刷新恢复的落盘格式：只认两种 kind，坏数据/空值一律当作「没有记录」。

import { describe, it, expect, beforeEach } from "vitest"
import {
  LAST_CHAT_CONTEXT_KEY,
  readLastChatContext,
  writeLastChatContext,
} from "../last-chat-context"

beforeEach(() => {
  localStorage.clear()
})

describe("last-chat-context", () => {
  it("session / task 往返", () => {
    writeLastChatContext({ kind: "session", sessionId: "s1" })
    expect(readLastChatContext()).toEqual({ kind: "session", sessionId: "s1" })

    writeLastChatContext({ kind: "task", taskId: "t1" })
    expect(readLastChatContext()).toEqual({ kind: "task", taskId: "t1" })
  })

  it("write(null) 清空记录（新建对话 / 删除）", () => {
    writeLastChatContext({ kind: "task", taskId: "t1" })
    writeLastChatContext(null)
    expect(localStorage.getItem(LAST_CHAT_CONTEXT_KEY)).toBeNull()
    expect(readLastChatContext()).toBeNull()
  })

  it("坏 JSON / 未知 kind / 缺 id ⇒ null，不抛", () => {
    localStorage.setItem(LAST_CHAT_CONTEXT_KEY, "{not json")
    expect(readLastChatContext()).toBeNull()

    localStorage.setItem(LAST_CHAT_CONTEXT_KEY, JSON.stringify({ kind: "window", windowId: "w" }))
    expect(readLastChatContext()).toBeNull()

    localStorage.setItem(LAST_CHAT_CONTEXT_KEY, JSON.stringify({ kind: "task", taskId: "" }))
    expect(readLastChatContext()).toBeNull()
  })
})
