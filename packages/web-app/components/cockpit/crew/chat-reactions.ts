// 汐音 × 对话生命周期（2026-11-16 用户口径）：
//   「助理在输出的时候没有相应的表情输出；我输入的时候，助理等待中也可以有互动」。
//
// 这里只放**纯文本池 + 选取函数**，组件负责节流、打字机和动画：
//   · 送出消息 → 等待回答：思考表情 + 轮换的等待台词（越等越久换一档）；
//   · 回答结束 → 收尾表情 + 一句「回完了」，给一次星光/边缘反馈；
//   · 用户正在输入（草稿非空）→ 倾听表情 + 一句「我在听」，只在开始输入时说一次。
//
// 台词不长、带 ✦/☕ 这类轻表情；不写进 chat（不花 token），只在立绘气泡里出现。

import type { MoodKey } from '@/components/cabin/cockpit'

export interface ChatReactionLine {
  text: string
  mood: MoodKey
}

/** 刚开始生成（0–12s）。 */
export const CHAT_WAIT_EARLY: ChatReactionLine[] = [
  { text: '收到 · 我先看一遍再回你', mood: 'thinking' },
  { text: '在跑了 ✦ 有结果我马上说', mood: 'working' },
  { text: '让我推演一下方案…', mood: 'thinking' },
]

/** 生成中段（12–45s）：换一档语气，表示还在盯。 */
export const CHAT_WAIT_MID: ChatReactionLine[] = [
  { text: '还在跑 · 我盯着呢 ✦', mood: 'working' },
  { text: '这段有点长，没卡住，我继续等', mood: 'thinking' },
  { text: '工具在跑，我在旁边看着 ⚙', mood: 'working' },
]

/** 生成长尾（>45s）：安抚 + 陪伴，不催人也不假装完成。 */
export const CHAT_WAIT_LATE: ChatReactionLine[] = [
  { text: '这轮跑得久一点…先给你倒杯水 ☕', mood: 'happy' },
  { text: '还在推进 · 我替你数着秒 ✦', mood: 'working' },
  { text: '没卡住，只是步骤多；我继续盯。', mood: 'thinking' },
]

/** 回答结束（停止 / 正常收流都算）：收尾台词。 */
export const CHAT_DONE: ChatReactionLine[] = [
  { text: '回完了 ✦ 你看看', mood: 'cheer' },
  { text: '搞定 ✦ 有要改的直接说', mood: 'happy' },
  { text: '这一轮收工 ✦ 我在。', mood: 'wink' },
  { text: '好了 ✦ 需要我接着跑就说', mood: 'happy' },
]

/** 用户正在输入（草稿非空）：助理等待时的互动。 */
export const CHAT_LISTEN: ChatReactionLine[] = [
  { text: '我在听 · 想好就发', mood: 'happy' },
  { text: '不急，慢慢说 ✦', mood: 'idle' },
  { text: '听着呢 · 要我先别插话就说', mood: 'wink' },
]

const pick = (pool: readonly ChatReactionLine[], rnd: () => number): ChatReactionLine =>
  pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))] ?? pool[0]

/** 等待回答时的台词：按已等时长分三档（12s / 45s 换档）。 */
export function waitingLine(elapsedMs: number, rnd: () => number = Math.random): ChatReactionLine {
  const pool = elapsedMs >= 45_000
    ? CHAT_WAIT_LATE
    : elapsedMs >= 12_000
      ? CHAT_WAIT_MID
      : CHAT_WAIT_EARLY
  return pick(pool, rnd)
}

export function doneLine(rnd: () => number = Math.random): ChatReactionLine {
  return pick(CHAT_DONE, rnd)
}

export function listenLine(rnd: () => number = Math.random): ChatReactionLine {
  return pick(CHAT_LISTEN, rnd)
}
