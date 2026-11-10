// 分屏偏好（2026-11-08）：开关是模块级 store（顶栏与对话层是兄弟节点），
// ratio / 焦点栏 / 两栏会话写进 localStorage['octopus.chat.split.v1']。
// 这里只钉存储契约与钳制规则，不含 React。

import { describe, it, expect, beforeEach } from 'vitest'
import {
  CHAT_SPLIT_STORAGE_KEY,
  getChatSplitEnabled,
  readChatSplitPrefs,
  resetChatSplitForTests,
  setChatSplitEnabled,
  writeChatSplitPrefs,
} from '../chat-split'

function stored() {
  return JSON.parse(localStorage.getItem(CHAT_SPLIT_STORAGE_KEY) ?? 'null')
}

beforeEach(() => {
  localStorage.clear()
  resetChatSplitForTests()
})

describe('chat-split store', () => {
  it('默认关闭，比例为 0.5，焦点左栏', () => {
    expect(getChatSplitEnabled()).toBe(false)
    expect(readChatSplitPrefs()).toEqual({ ratio: 0.5, focused: 'left', left: null, right: null, leftTask: null, rightTask: null })
  })

  it('开关写入 localStorage，重新读模块缓存前也能恢复', () => {
    setChatSplitEnabled(true)
    expect(getChatSplitEnabled()).toBe(true)
    expect(stored().enabled).toBe(true)

    resetChatSplitForTests()
    expect(getChatSplitEnabled()).toBe(true)
  })

  it('布局偏好合并写入，不覆盖开关', () => {
    setChatSplitEnabled(true)
    writeChatSplitPrefs({ ratio: 0.62, focused: 'right', left: 's-a', right: 's-b', leftTask: 't-a', rightTask: 't-b' })
    expect(stored()).toMatchObject({
      enabled: true,
      ratio: 0.62,
      focused: 'right',
      left: 's-a',
      right: 's-b',
      leftTask: 't-a',
      rightTask: 't-b',
    })

    writeChatSplitPrefs({ left: null })
    expect(stored()).toMatchObject({ enabled: true, ratio: 0.62, right: 's-b', left: null })
  })

  it('比例被钳到 0.2–0.8，坏数据回落到默认值', () => {
    writeChatSplitPrefs({ ratio: 0.05 })
    expect(readChatSplitPrefs().ratio).toBe(0.2)

    writeChatSplitPrefs({ ratio: 0.99 })
    expect(readChatSplitPrefs().ratio).toBe(0.8)

    localStorage.setItem(CHAT_SPLIT_STORAGE_KEY, '{oops')
    resetChatSplitForTests()
    expect(getChatSplitEnabled()).toBe(false)
    expect(readChatSplitPrefs().ratio).toBe(0.5)
  })

  it('写入后重新载入模块缓存（模拟刷新）仍保持布局', () => {
    setChatSplitEnabled(true)
    writeChatSplitPrefs({ ratio: 0.4, focused: 'right', left: 's-a', right: 's-b' })
    resetChatSplitForTests()
    expect(getChatSplitEnabled()).toBe(true)
    expect(readChatSplitPrefs()).toEqual({ ratio: 0.4, focused: 'right', left: 's-a', right: 's-b', leftTask: null, rightTask: null })
  })
})
