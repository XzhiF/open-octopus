'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import type { AssistantMessage } from '@/lib/knowledge/types'
import { createAssistantStream } from '@/lib/knowledge/api'

const MAX_ROUNDS = 5

export function useKnowledgeAssistant() {
  const [messages, setMessages] = useState<AssistantMessage[]>([])
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [roundCount, setRoundCount] = useState(0)
  const abortRef = useRef<(() => void) | null>(null)
  const streamContentRef = useRef('')
  const suggestionRef = useRef<string | undefined>(undefined)

  const cleanup = useCallback(() => {
    if (abortRef.current) {
      abortRef.current()
      abortRef.current = null
    }
  }, [])

  // Auto-cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup()
    }
  }, [cleanup])

  const sendMessage = useCallback(async (
    content: string,
    params: {
      mode: 'review' | 'archive' | 'chat'
      ruleContent?: string
      skillContent?: string
      userPreference?: string
      executionContext?: string
    }
  ) => {
    if (roundCount >= MAX_ROUNDS) {
      setError(`Maximum ${MAX_ROUNDS} rounds reached`)
      return
    }
    if (isConnecting) return

    // Add user message
    const userMsg: AssistantMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
    }
    setMessages(prev => [...prev, userMsg])
    setIsConnecting(true)
    setError(null)
    streamContentRef.current = ''
    suggestionRef.current = undefined

    const { reader, abort } = createAssistantStream({
      mode: params.mode,
      ruleContent: params.ruleContent,
      skillContent: params.skillContent,
      userPreference: params.userPreference,
      executionContext: params.executionContext,
    })
    abortRef.current = abort

    // Add placeholder assistant message
    const assistantMsgId = `assistant-${Date.now()}`
    const assistantMsg: AssistantMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
    }
    setMessages(prev => [...prev, assistantMsg])

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        try {
          const eventData = JSON.parse(value)
          const eventType = eventData.type as string

          switch (eventType) {
            case 'text_delta': {
              const delta = eventData.content ?? eventData.delta ?? ''
              streamContentRef.current += delta
              const currentContent = streamContentRef.current
              setMessages(prev =>
                prev.map(m =>
                  m.id === assistantMsgId ? { ...m, content: currentContent } : m
                )
              )
              break
            }
            case 'suggestion': {
              const suggestion = eventData.suggestion ?? eventData.content ?? ''
              suggestionRef.current = suggestion
              setMessages(prev =>
                prev.map(m =>
                  m.id === assistantMsgId ? { ...m, suggestion } : m
                )
              )
              break
            }
            case 'done': {
              setRoundCount(prev => prev + 1)
              setIsConnecting(false)
              abortRef.current = null
              break
            }
            case 'error': {
              const errMsg = eventData.message ?? eventData.error ?? 'Stream error'
              setError(errMsg)
              setIsConnecting(false)
              abortRef.current = null
              break
            }
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Stream connection failed')
      }
    } finally {
      setIsConnecting(false)
      abortRef.current = null
    }
  }, [roundCount, isConnecting])

  const adoptSuggestion = useCallback(() => {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.suggestion)
    if (!lastAssistant?.suggestion) return null
    return lastAssistant.suggestion
  }, [messages])

  const resetConversation = useCallback(() => {
    cleanup()
    setMessages([])
    setError(null)
    setRoundCount(0)
    streamContentRef.current = ''
    suggestionRef.current = undefined
  }, [cleanup])

  return {
    messages,
    sendMessage,
    isConnecting,
    error,
    adoptSuggestion,
    resetConversation,
    roundCount,
  }
}
