import { describe, it, expect } from 'vitest'
import {
  getLastAskIdx,
  isQuestionAnswered,
  shouldHideAfterCard,
  filterMessages,
} from '../message-filter'
import type { ChatMessage } from '@/lib/types'

function makeMsg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    sessionId: 's-1',
    role: 'assistant',
    displayType: 'text',
    content: '',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

function makeAskQuestion(id: string): ChatMessage {
  return makeMsg({
    id,
    role: 'assistant',
    displayType: 'ask_user_question',
    content: '',
    toolCallId: 'tool-1',
    toolName: 'AskUserQuestion',
    toolInput: {
      questions: [{ question: 'test?', header: 'Test', multiSelect: false, options: [] }],
    },
    toolStatus: 'done',
  })
}

function makeUserAnswer(id: string): ChatMessage {
  return makeMsg({
    id,
    role: 'user',
    displayType: 'user',
    content: '用户回答了以下问题：\n\n1. [Test] test?\n   → answer',
  })
}

describe('message-filter', () => {
  describe('getLastAskIdx', () => {
    it('returns -1 when no ask_user_question messages', () => {
      const msgs = [
        makeMsg({ id: '1', displayType: 'text' }),
        makeMsg({ id: '2', displayType: 'text' }),
      ]
      expect(getLastAskIdx(msgs)).toBe(-1)
    })

    it('returns the index of the last ask_user_question', () => {
      const msgs = [
        makeMsg({ id: '1', displayType: 'text' }),
        makeAskQuestion('2'),
        makeAskQuestion('3'),
        makeMsg({ id: '4', displayType: 'text' }),
      ]
      expect(getLastAskIdx(msgs)).toBe(2)
    })
  })

  describe('isQuestionAnswered', () => {
    it('returns true when no question exists', () => {
      expect(isQuestionAnswered([], -1)).toBe(true)
    })

    it('returns false when no answer after the question', () => {
      const msgs = [makeAskQuestion('1')]
      expect(isQuestionAnswered(msgs, 0)).toBe(false)
    })

    it('returns true when answer exists after the question', () => {
      const msgs = [
        makeAskQuestion('1'),
        makeUserAnswer('2'),
      ]
      expect(isQuestionAnswered(msgs, 0)).toBe(true)
    })
  })

  describe('shouldHideAfterCard', () => {
    const state = { lastAskIdx: 1, questionAnswered: false, lastAskId: null }

    it('never hides messages — text provides context for the question', () => {
      const msg = makeMsg({ id: '2', role: 'assistant', displayType: 'text' })
      expect(shouldHideAfterCard(msg, 2, state)).toBe(false)
    })

    it('never hides thinking messages', () => {
      const msg = makeMsg({ id: '2', role: 'assistant', displayType: 'thinking' })
      expect(shouldHideAfterCard(msg, 2, state)).toBe(false)
    })

    it('never hides user messages', () => {
      const msg = makeMsg({ id: '2', role: 'user', displayType: 'user' })
      expect(shouldHideAfterCard(msg, 2, state)).toBe(false)
    })

    it('never hides the ask_user_question card itself', () => {
      const msg = makeAskQuestion('2')
      expect(shouldHideAfterCard(msg, 2, state)).toBe(false)
    })

    it('never hides anything when question is answered', () => {
      const answeredState = { lastAskIdx: 1, questionAnswered: true, lastAskId: null }
      const msg = makeMsg({ id: '2', role: 'assistant', displayType: 'text' })
      expect(shouldHideAfterCard(msg, 2, answeredState)).toBe(false)
    })
  })

  describe('filterMessages', () => {
    it('returns all messages when no ask_user_question', () => {
      const msgs = [
        makeMsg({ id: '1', displayType: 'text' }),
        makeMsg({ id: '2', displayType: 'text' }),
      ]
      expect(filterMessages(msgs)).toEqual(msgs)
    })

    it('shows all messages including text after unanswered card', () => {
      const msgs = [
        makeMsg({ id: '1', role: 'user', displayType: 'user', content: '帮我...' }),
        makeAskQuestion('2'),
        makeMsg({ id: '3', role: 'assistant', displayType: 'thinking' }),
        makeMsg({ id: '4', role: 'assistant', displayType: 'text', content: '你对哪个感兴趣？' }),
      ]
      const result = filterMessages(msgs)
      expect(result).toHaveLength(4)
      expect(result[0].id).toBe('1')
      expect(result[1].id).toBe('2')
      expect(result[2].id).toBe('3')
      expect(result[3].id).toBe('4')
    })

    it('shows all messages after question is answered', () => {
      const msgs = [
        makeAskQuestion('1'),
        makeUserAnswer('2'),
        makeMsg({ id: '3', role: 'assistant', displayType: 'text', content: '好的，根据...' }),
      ]
      const result = filterMessages(msgs)
      expect(result).toHaveLength(3)
    })
  })
})