'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { useAgentSessions } from '@/hooks/useAgentSessions'

export type ChatSessionsValue = ReturnType<typeof useAgentSessions>

const ChatSessionsContext = createContext<ChatSessionsValue | null>(null)

/** One session list for the whole shell: the chat desktop owns it, the header reads it. */
export function ChatSessionsProvider({ children }: { children: ReactNode }) {
  const value = useAgentSessions()
  return <ChatSessionsContext.Provider value={value}>{children}</ChatSessionsContext.Provider>
}

export function useChatSessions(): ChatSessionsValue {
  const context = useContext(ChatSessionsContext)
  if (!context) throw new Error('useChatSessions must be used inside ChatSessionsProvider')
  return context
}
