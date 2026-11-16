// 对话联动的台词选取（纯函数）：等待三档、收尾、倾听。
import { describe, expect, it } from 'vitest'
import {
  CHAT_DONE,
  CHAT_LISTEN,
  CHAT_WAIT_EARLY,
  CHAT_WAIT_LATE,
  CHAT_WAIT_MID,
  doneLine,
  listenLine,
  waitingLine,
} from '../chat-reactions'

const first = () => 0

describe('chat-reactions · 台词选取', () => {
  it('等待台词按已等时长换档：<12s / 12–45s / >45s', () => {
    expect(waitingLine(0, first)).toEqual(CHAT_WAIT_EARLY[0])
    expect(waitingLine(11_999, first)).toEqual(CHAT_WAIT_EARLY[0])
    expect(waitingLine(12_000, first)).toEqual(CHAT_WAIT_MID[0])
    expect(waitingLine(44_999, first)).toEqual(CHAT_WAIT_MID[0])
    expect(waitingLine(45_000, first)).toEqual(CHAT_WAIT_LATE[0])
  })

  it('收尾 / 倾听台词都来自各自词库', () => {
    expect(CHAT_DONE).toContainEqual(doneLine(first))
    expect(CHAT_LISTEN).toContainEqual(listenLine(first))
  })
})
