// 「等你在场」提醒话术（2026-11-19 用户）：有需要人处理的事项挂着时，汐音的
// 头顶气泡隔一阵报一条**真实清单**（标题 / 条数 / 该做什么都来自编队 attention），
// 而不是只有一支摇头动作、什么额外信息都没有。
//
// 纯函数：输入 = 右栏「要我处理」同一份 inbox entries（collectInbox 的结果，
// 含 job / task / attention 行）。输出按轮播顺序给 4–6 条，调度在 CockpitCrew。
// 不催不吓：措辞只陈述事实 + 一个就地动作（点右栏 ✉ 打开清单）。

import { inboxGroupOf, type InboxEntry } from '../rail/inbox-model'

export interface WaitNudge {
  text: string
  /** 气泡停留（ms，打字耗时另计）。 */
  hold: number
}

/** 标题压成一行：取首行，超长截断 —— 气泡只有两行宽。 */
function shortTitle(entry: InboxEntry): string {
  const raw = (entry.item.title || entry.item.question || '待办').trim()
  const one = raw.split('\n')[0] ?? raw
  return one.length > 34 ? `${one.slice(0, 34)}…` : one
}

function verbOf(entry: InboxEntry): string {
  const group = inboxGroupOf(entry.item)
  return group === 'rev' ? '验收' : group === 'blk' ? '处理' : '拍板'
}

/**
 * 生成一轮待办提醒台词。顺序 = 总览 → 分组 → 逐条清单；调用方按下标轮播，
 * 每条只出现一次再回环。
 */
export function buildWaitNudges(entries: readonly InboxEntry[]): WaitNudge[] {
  if (entries.length === 0) return []
  const total = entries.length
  const first = entries[0]!
  const rev = entries.find((entry) => inboxGroupOf(entry.item) === 'rev')
  const ask = entries.find((entry) => inboxGroupOf(entry.item) === 'ask')
  const blk = entries.find((entry) => inboxGroupOf(entry.item) === 'blk')

  const out: WaitNudge[] = []
  if (total === 1) {
    out.push({
      text: `指挥官，「${shortTitle(first)}」还在等你${verbOf(first)}。`,
      hold: 8000,
    })
  } else {
    const top = entries.slice(0, 2).map((entry) => `「${shortTitle(entry)}」`).join('、')
    out.push({
      text: `指挥官，${total} 件事挂着：${top}…点右边的 ✉ 要我处理，我逐条摆给你。`,
      hold: 9500,
    })
  }
  if (rev) {
    out.push({ text: `待验收：「${shortTitle(rev)}」—— 看一眼就能消项。`, hold: 7500 })
  }
  if (ask) {
    out.push({ text: `要你拍板的：「${shortTitle(ask)}」；要我把选项摊开吗？`, hold: 8000 })
  }
  if (blk) {
    out.push({
      text: `「${shortTitle(blk)}」卡住了，现场我先停着，等你一句话解。`,
      hold: 8000,
    })
  }
  for (const entry of entries.slice(0, 3)) {
    out.push({ text: `清单 · ${shortTitle(entry)} → ${verbOf(entry)}`, hold: 6500 })
  }
  return out
}
