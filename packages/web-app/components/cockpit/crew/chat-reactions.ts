// 汐音 × 对话生命周期（2026-11-16 用户口径）：
//   「助理在输出的时候没有相应的表情输出；我输入的时候，助理等待中也可以有互动」。
//
// 这里只放**纯文本池 + 选取函数**，组件负责节流、打字机和动画：
//   · 送出消息 → 等待回答：思考表情 + 轮换的等待台词（越等越久换一档）；
//   · 回答结束 → 收尾表情 + 一句「回完了」，给一次星光/边缘反馈；
//   · 用户正在输入（草稿非空）→ 倾听表情 + 一句「我在听」，只在开始输入时说一次；
//   · 待命自走换动作 → 按新片段的姿态补一句旁白（IDLE_POSE_LINES）。
//
// 2026-11-20 用户：文案太少、来回就那几句。全库扩到 **152 条**（12 姿态各 8 条
// 旁白 + 等待三档各 10 + 收尾 16 + 倾听 10），且全局互不重复；新增文案一律
// 追加在原三条之后，保持 [0] 的既有测试口径。
//
// 台词不长、带 ✦/☕ 这类轻表情；不写进 chat（不花 token），只在立绘气泡里出现。

import type { MoodKey } from '@/components/cabin/cockpit'
import type { PoseKey } from './pose-model'

export interface ChatReactionLine {
  text: string
  mood: MoodKey
}

/** 空闲轮播换动作时的一句旁白（2026-11-20 用户：纯动作变化太单调）。
 *  只表达「在场感」，不冒充事件播报 —— 每句都对得上此刻的姿态，但不声称有事发生。 */
export const IDLE_POSE_LINES: Record<PoseKey, readonly string[]> = {
  idle: [
    '我在。 ✦',
    '舱面安静，正好。',
    '有事先忙，我守着。',
    '待命，随时接单。',
    '舰桥一切就绪。',
    '你忙你的，我盯着舷窗。',
    '呼吸灯都稳着呢。',
    '需要我时喊一声就行。',
  ],
  working: [
    '手上的都顺 ✦',
    '进度我盯着。',
    '嗯，都在轨道上。',
    '编队跑得平稳。',
    '我在看实时日志。',
    '这一段推进得不错。',
    '有回流我第一时间报。',
    '节奏正好，不用催。',
  ],
  thinking: [
    '在想一件事…',
    '让我理一理。',
    '这条线索有点意思。',
    '嗯……先把证据摊开。',
    '我在权衡两种走法。',
    '这里的取舍值得琢磨。',
    '让我把时间线排一下。',
    '快想通了，别急。',
  ],
  alert: [
    '四下都看过了，稳。',
    '没有异常。',
    '有情况我会先举牌。',
    '屏上一切正常。',
    '我刚巡过一圈。',
    '警戒线开着，放心。',
    '雷达上没有杂点。',
    '有风吹草动我先动。',
  ],
  smile: [
    '状态不错 ✦',
    '今天挺好。',
    '嗯哼～',
    '心情不错，干活也快。',
    '这个节奏我喜欢。',
    '偷偷笑一下。',
    '今天的手气应该不错。',
    '✦ 就是这样。',
  ],
  concerned: [
    '这里我会多看一眼。',
    '小心驶得万年船。',
    '有我在，别担心。',
    '这个数值有点微妙。',
    '我先记下来，回头对一下。',
    '不急着下结论。',
    '边界条件再核一遍。',
    '稳一点总没错。',
  ],
  cheer: [
    '继续加油 ✦',
    '这一下精神了！',
    '嘿嘿。',
    '干得漂亮！',
    '今天状态拉满。',
    '来，下一城。',
    '士气 +1 ✦',
    '我们能赢。',
  ],
  wink: [
    '别绷太紧。',
    '看我一眼就够啦 ✦',
    '嘿。',
    '喝口水再拍板嘛。',
    '秘密通道给你留着。',
    '眨个眼，压力 −1。',
    '看你这么忙，逗你一下。',
    '✦ 怎么样，心情好点没。',
  ],
  sleep: [
    '困了…',
    '让我眯一下。',
    '……Zzz',
    '有事先喊我。',
    '打个盹，马上回来。',
    '梦里也在巡逻。',
    '灯调暗了一点。',
    '……嗯？我在。',
  ],
  ready: [
    '随时可以出发。',
    '舰桥接管完毕。',
    '指令到，我动。',
    '整装待命，听你口令。',
    '坐标已载入。',
    '引擎预热完毕。',
    '五秒内可开跑。',
    '出发前最后一次检查。',
  ],
  command: [
    '按节奏来。',
    '听我口令 ✦',
    '保持队形。',
    '各就各位。',
    '目标已锁定。',
    '推进器点火。',
    '编队跟上。',
    '按预案执行。',
  ],
  typing: [
    '键声就是进度 ✦',
    '在整理记录。',
    '打字中…',
    '正在编译产物。',
    '日志归好档了。',
    '这一段写完就发。',
    '键盘已经热起来了。',
    '进度条在涨，听着。',
  ],
}

/** 刚开始生成（0–12s）。 */
export const CHAT_WAIT_EARLY: ChatReactionLine[] = [
  { text: '收到 · 我先看一遍再回你', mood: 'thinking' },
  { text: '在跑了 ✦ 有结果我马上说', mood: 'working' },
  { text: '让我推演一下方案…', mood: 'thinking' },
  { text: '收到，我先把材料过一遍', mood: 'thinking' },
  { text: '正在展开上下文…', mood: 'thinking' },
  { text: '这一步我来拆解', mood: 'working' },
  { text: '先看现场，再给你答案', mood: 'thinking' },
  { text: '我在读你刚给的要求', mood: 'thinking' },
  { text: '让我找一下相关的旧记录', mood: 'thinking' },
  { text: '马上开始第一轮', mood: 'working' },
]

/** 生成中段（12–45s）：换一档语气，表示还在盯。 */
export const CHAT_WAIT_MID: ChatReactionLine[] = [
  { text: '还在跑 · 我盯着呢 ✦', mood: 'working' },
  { text: '这段有点长，没卡住，我继续等', mood: 'thinking' },
  { text: '工具在跑，我在旁边看着 ⚙', mood: 'working' },
  { text: '还在推进，进度条没停', mood: 'working' },
  { text: '工具链正常，我继续盯', mood: 'working' },
  { text: '中途没有报错，放心', mood: 'working' },
  { text: '这一步有点绕，我在拆', mood: 'thinking' },
  { text: '第二轮验证中…', mood: 'thinking' },
  { text: '别走开，快出结果了', mood: 'happy' },
  { text: '我顺手把边界情况也跑了', mood: 'working' },
]

/** 生成长尾（>45s）：安抚 + 陪伴，不催人也不假装完成。 */
export const CHAT_WAIT_LATE: ChatReactionLine[] = [
  { text: '这轮跑得久一点…先给你倒杯水 ☕', mood: 'happy' },
  { text: '还在推进 · 我替你数着秒 ✦', mood: 'working' },
  { text: '没卡住，只是步骤多；我继续盯。', mood: 'thinking' },
  { text: '这轮确实长，但我一直在看', mood: 'working' },
  { text: '长任务都是这样，稳住', mood: 'idle' },
  { text: '要不要我先把中间结论给你？', mood: 'thinking' },
  { text: '没有卡死，只是步骤细', mood: 'working' },
  { text: '我盯着超时护栏，不会无限跑', mood: 'working' },
  { text: '慢工出细活，再等等 ✦', mood: 'happy' },
  { text: '你已经等了很久，我记着时间', mood: 'worried' },
]

/** 回答结束（停止 / 正常收流都算）：收尾台词。 */
export const CHAT_DONE: ChatReactionLine[] = [
  { text: '回完了 ✦ 你看看', mood: 'cheer' },
  { text: '搞定 ✦ 有要改的直接说', mood: 'happy' },
  { text: '这一轮收工 ✦ 我在。', mood: 'wink' },
  { text: '好了 ✦ 需要我接着跑就说', mood: 'happy' },
  { text: '收工 ✦ 结果放这儿了', mood: 'cheer' },
  { text: '跑完了，你先看结论', mood: 'happy' },
  { text: '交付完成，等你过目', mood: 'happy' },
  { text: '这一轮有惊无险，成了', mood: 'cheer' },
  { text: '搞定！下一件随时喊我', mood: 'wink' },
  { text: '产物已归档，验收请随意', mood: 'happy' },
  { text: '回完啦，想看细节我展开给你', mood: 'idle' },
  { text: '报告写在对话里了 ✦', mood: 'happy' },
  { text: '这次收得还算干净', mood: 'happy' },
  { text: '任务闭环，我盯着下一个', mood: 'working' },
  { text: '完成 ✦ 需要复盘的话我陪你', mood: 'cheer' },
  { text: '好，先到这，你喘口气', mood: 'happy' },
]

/** 用户正在输入（草稿非空）：助理等待时的互动。 */
export const CHAT_LISTEN: ChatReactionLine[] = [
  { text: '我在听 · 想好就发', mood: 'happy' },
  { text: '不急，慢慢说 ✦', mood: 'idle' },
  { text: '听着呢 · 要我先别插话就说', mood: 'wink' },
  { text: '你慢慢打，我不催', mood: 'idle' },
  { text: '在看了，继续说', mood: 'happy' },
  { text: '要不要我帮你起个头？', mood: 'thinking' },
  { text: '光标在闪，我在等', mood: 'idle' },
  { text: '想清楚了再发也行', mood: 'idle' },
  { text: '我先把上下文备好', mood: 'working' },
  { text: '说到一半我也跟得上', mood: 'happy' },
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

/** 空闲换动作时的旁白：跟着新片段的姿态挑一句（同一姿态 8 句里随机）。 */
export function idlePoseLine(pose: PoseKey, rnd: () => number = Math.random): string {
  const pool = IDLE_POSE_LINES[pose] ?? IDLE_POSE_LINES.idle
  return pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))] ?? pool[0]!
}
