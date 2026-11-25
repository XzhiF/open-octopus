// packages/web-app/lib/agent/display-content.ts
//
// 历史态正文的选取规则（TuiTranscript / ChatBubble 共用）。
//
// 规则：timeline 里的**全部正文段**按时间序留在正文区；只有思考 / 工具调用
// 收进折叠 meta。正文段是结论（常常是这一轮真正要用户读的话），过程才是
// thinking / tool。
//
// 2026-11-02 用户反馈「本来显示，回合结束后没了」：以 AskUserQuestion 收尾
// 的回合，问题前的正文在流式期可见，回合结束、问题卡出现后却消失。当时只
// 给 ask 回合开了例外，按时间序拼接全部正文段。
//
// 2026-11-24 用户反馈（多 Agent 回合）：主对话派了几个子代理，第一段正文
// 是在问用户问题；用户还没答，后续子代理陆续返回，模型在同一条 assistant
// 消息里继续追加正文段。旧规则只显最后一段 → 最初那段（含问题）被折进
// 「已完成 · 时长 · N 步」里，只能在展开 meta 时才看得到。既然流式期所有
// 正文段本来就在屏上，结束态就应与流式态一致：全部显示，不折叠正文。

import type { AgentMessage } from './types'

/** 代理发言（design 25 §2 / §5.5）：doer 侧收到的 user 消息里，由汐音代用户
 *  转达的那几类。TuiTranscript 用它把回执渲染成「汐音 · 代你」，用户输入
 *  历史用它把这些系统写入的行排除（不是用户亲手打的字）。 */
export function proxyTurnOf(content: string): { kind: 'decision' | 'brief' | 'note'; verbatim?: string } | null {
  const text = content.trimStart()
  if (/^\[决策\s*·[^\]]*\]/.test(text) && text.includes('用户回答了以下问题')) {
    const verbatim = /（逐字）\s*(.+)/.exec(text)?.[1]?.trim()
    return { kind: 'decision', ...(verbatim ? { verbatim } : {}) }
  }
  if (/^\[汐音\s*·\s*代用户转达\]/.test(text)) return { kind: 'brief' }
  if (/^\[舱派发\s*·/.test(text)) return { kind: 'brief' }
  if (/^\[舱备注\s*·/.test(text)) return { kind: 'note' }
  return null
}

/** 历史态要显示的正文。 */
export function displayContentFor(message: AgentMessage): string {
  const timeline = message.role === 'user' || !Array.isArray(message.timeline)
    ? undefined
    : message.timeline
  if (!timeline?.length) return message.content
  const texts = timeline
    .filter((e) => e.kind === 'text' && e.text)
    .map((e) => e.text as string)
  if (texts.length === 0) return message.content
  // 全部正文段按时间序显示（问题卡在正文之后，由 ChatArea 追加）。
  return texts.join('\n')
}

/** timeline 的正文段是否已全量进正文区 —— 是则折叠 meta 展开时不再重复列
 *  正文碎片（hideTextFrags）。与 displayContentFor 同源。 */
export function showsAllTimelineTexts(message: AgentMessage): boolean {
  if (message.role === 'user' || !Array.isArray(message.timeline)) return false
  return message.timeline.some((e) => e.kind === 'text' && !!e.text)
}
