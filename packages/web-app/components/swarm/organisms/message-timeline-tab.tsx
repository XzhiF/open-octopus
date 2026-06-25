"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { MessageBubble } from "../molecules/message-bubble"
import { ExpertAvatar } from "../atoms/expert-avatar"
import type { SwarmMessage } from "@/lib/swarm-types"

export interface MessageTimelineTabProps {
  messages: SwarmMessage[]
}

/** Group messages by round */
interface RoundGroup {
  round: number
  messages: SwarmMessage[]
}

export function MessageTimelineTab({ messages }: MessageTimelineTabProps) {
  const [collapsedRounds, setCollapsedRounds] = useState<Set<number>>(new Set())
  const [collapsedExperts, setCollapsedExperts] = useState<Set<string>>(new Set())

  // Group messages by round
  const roundGroups = useMemo<RoundGroup[]>(() => {
    const groups: RoundGroup[] = []
    let current: RoundGroup | null = null

    for (const msg of messages) {
      if (!current || current.round !== msg.round) {
        current = { round: msg.round, messages: [] }
        groups.push(current)
      }
      current.messages.push(msg)
    }
    return groups
  }, [messages])

  // Auto-collapse previous rounds when new round starts
  useEffect(() => {
    if (roundGroups.length > 1) {
      const allButLast = new Set(roundGroups.slice(0, -1).map(g => g.round))
      setCollapsedRounds(allButLast)
    }
  }, [roundGroups.length])

  const toggleRound = useCallback((round: number) => {
    setCollapsedRounds(prev => {
      const next = new Set(prev)
      if (next.has(round)) next.delete(round)
      else next.add(round)
      return next
    })
  }, [])

  const toggleExpert = useCallback((role: string) => {
    setCollapsedExperts(prev => {
      const next = new Set(prev)
      if (next.has(role)) next.delete(role)
      else next.add(role)
      return next
    })
  }, [])

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        等待专家发言...
      </div>
    )
  }

  return (
    <div className="px-2">
      {roundGroups.map((group) => {
        const isRoundCollapsed = collapsedRounds.has(group.round)
        const msgCount = group.messages.length

        return (
          <div key={group.round} className="mb-2">
            {/* Round header — clickable to collapse/expand */}
            <div
              className="flex items-center gap-2 py-1.5 px-1 cursor-pointer hover:bg-muted/30 rounded select-none"
              onClick={() => toggleRound(group.round)}
            >
              {isRoundCollapsed
                ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              }
              <span className="text-xs font-medium text-muted-foreground">
                第 {group.round} 轮
              </span>
              <span className="text-[10px] text-muted-foreground/60">
                {msgCount} 条消息
              </span>
              {isRoundCollapsed && (
                <span className="text-[10px] text-muted-foreground/40 ml-auto">
                  {group.messages.map(m => m.from).filter((v, i, a) => a.indexOf(v) === i).join(", ")}
                </span>
              )}
            </div>

            {/* Messages in this round */}
            {!isRoundCollapsed && (
              <div className="space-y-1">
                {group.messages.map((msg, i) => {
                  const isExpertCollapsed = collapsedExperts.has(msg.from)

                  if (isExpertCollapsed) {
                    return (
                      <div
                        key={i}
                        className="flex items-center gap-2 py-1.5 px-2 cursor-pointer hover:bg-muted/20 rounded text-xs text-muted-foreground"
                        onClick={() => toggleExpert(msg.from)}
                      >
                        <ChevronRight className="h-3 w-3 shrink-0" />
                        <ExpertAvatar role={msg.from} size="xs" />
                        <span className="font-medium">{msg.from}</span>
                        <span className="text-muted-foreground/60">已折叠</span>
                      </div>
                    )
                  }

                  return (
                    <div key={i} className="flex items-start gap-1">
                      <div
                        className="mt-2 shrink-0 px-1 py-1.5 cursor-pointer rounded hover:bg-muted/30"
                        onClick={() => toggleExpert(msg.from)}
                      >
                        <ChevronDown className="h-3 w-3 text-muted-foreground/50" />
                      </div>
                      <div className="flex-1 min-w-0 py-0.5">
                        <MessageBubble message={msg} onCollapse={() => toggleExpert(msg.from)} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
