import type { ChatMessage } from "@/lib/types"

interface AnsweredState {
  lastAskIdx: number
  questionAnswered: boolean
  lastAskId: string | null
}

/** Find the index of the last unanswered ask_user_question message */
export function getLastAskIdx(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].displayType === 'ask_user_question') return i
  }
  return -1
}

/** Check if the last ask_user_question has been answered by a user message */
export function isQuestionAnswered(messages: ChatMessage[], lastAskIdx: number): boolean {
  if (lastAskIdx < 0) return true
  return messages.slice(lastAskIdx + 1).some(
    m => m.role === 'user' && m.content.includes('用户回答了以下问题')
  )
}

/** Determine if a message should be hidden after an unanswered question card.
 *  Text below the card provides context for the question — always show it.
 *  The card itself is visually distinct enough to draw user attention. */
export function shouldHideAfterCard(
  _msg: ChatMessage,
  _idx: number,
  state: AnsweredState
): boolean {
  // Never hide — the question card is visually prominent, and the text
  // below provides important context for understanding the question.
  if (state.questionAnswered || state.lastAskIdx < 0) return false
  return false
}

/** Filter messages: hide redundant AI messages after an unanswered ask_user_question */
export function filterMessages(messages: ChatMessage[]): ChatMessage[] {
  const lastAskIdx = getLastAskIdx(messages)
  const questionAnswered = isQuestionAnswered(messages, lastAskIdx)
  const state: AnsweredState = { lastAskIdx, questionAnswered, lastAskId: lastAskIdx >= 0 ? messages[lastAskIdx]?.id ?? null : null }

  return messages.filter((msg, idx) => !shouldHideAfterCard(msg, idx, state))
}