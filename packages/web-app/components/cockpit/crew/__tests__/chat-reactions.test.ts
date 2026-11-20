// 对话联动的台词选取（纯函数）：等待三档、收尾、倾听 + 全库容量。
import { describe, expect, it } from 'vitest'
import {
  CHAT_DONE,
  CHAT_LISTEN,
  CHAT_WAIT_EARLY,
  CHAT_WAIT_LATE,
  CHAT_WAIT_MID,
  IDLE_POSE_LINES,
  doneLine,
  idlePoseLine,
  listenLine,
  waitingLine,
} from '../chat-reactions'
import { POSE_ORDER } from '../pose-model'

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

  it('每个姿态都有 ≥8 句旁白，随机取都在库里', () => {
    for (const pose of POSE_ORDER) {
      expect(IDLE_POSE_LINES[pose].length).toBeGreaterThanOrEqual(8)
      expect(IDLE_POSE_LINES[pose]).toContain(idlePoseLine(pose, first))
    }
  })

  // 2026-11-20 用户：互动文案太少，希望至少 128 条不同的话，分布在待命问候 /
  // agent 工作中 / agent 交互完 etc. —— 全库统一在这里守容量与去重。
  it('全库 ≥128 条且互不重复', () => {
    const all = [
      ...POSE_ORDER.flatMap((pose) => [...IDLE_POSE_LINES[pose]]),
      ...CHAT_WAIT_EARLY.map((l) => l.text),
      ...CHAT_WAIT_MID.map((l) => l.text),
      ...CHAT_WAIT_LATE.map((l) => l.text),
      ...CHAT_DONE.map((l) => l.text),
      ...CHAT_LISTEN.map((l) => l.text),
    ]
    expect(all.length).toBeGreaterThanOrEqual(128)
    expect(new Set(all).size).toBe(all.length)
  })
})
