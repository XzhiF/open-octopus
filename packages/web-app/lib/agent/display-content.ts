// packages/web-app/lib/agent/display-content.ts
//
// 历史态正文的选取规则（TuiTranscript / ChatBubble 共用）。
//
// 默认：有 timeline 时只显最后一段 text —— 过程碎片（思考 / 工具 / 中间
// 叙述）收进折叠 meta，正文保持紧凑。
//
// 例外（2026-11-02，用户反馈「本来显示，回合结束后没了」）：以
// AskUserQuestion 收尾的回合，问题前的正文也是用户要读的正文。模型常见写法
// 是「先说明结论 → 提问 → 再补一句等你回答」，若只显最后一段，前半句会在
// 回合结束、问题卡出现时凭空消失（流式期其实一直可见）。

import type { AgentMessage } from './types'

/** 本回合是否调用过 AskUserQuestion（问题卡由 ChatArea 在消息尾部渲染）。 */
export function endsOnAsk(message: AgentMessage): boolean {
  // 旧数据的 tool_calls 可能是对象（legacy "{}" 行），不能直接 .some。
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  return toolCalls.some((tc) => tc.name === 'AskUserQuestion')
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
  // ask 回合：按时间序拼接全部正文段（问题卡在正文之后，由 ChatArea 追加）。
  if (endsOnAsk(message)) return texts.join('\n')
  return texts[texts.length - 1]
}
