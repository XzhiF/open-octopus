// 对话索引（右侧「用户输入历史」/ 全域标题栏 ≡N轮）的数据源。
//
// role='user' 不全是「我打出去的字」：任务事件卡（displayType='event'，
// 含「[任务提问 · 待回答] …」镜像卡）也以 user 落库，汐音代你转达的
// 回执同样是 user 行。把它们混进索引，点条目只会跳到一张卡/一行回执，
// 看起来就是「点了没反应」（2026-11-17 用户）。
//
// 索引只收真人输入：排除事件卡、role_switch 标记、代理发言与空正文。

import type { AgentMessage } from './types'
import { proxyTurnOf } from './display-content'

export interface UserTurnItem {
  id: string
  text: string
}

export function userPromptTurns(messages: readonly AgentMessage[]): UserTurnItem[] {
  return messages
    .filter((message) => message.role === 'user')
    .filter((message) => message.displayType !== 'event' && !message.roleSwitch && !proxyTurnOf(message.content))
    .filter((message) => message.content.trim().length > 0)
    .map((message) => ({ id: message.id, text: message.content.trim() }))
}
