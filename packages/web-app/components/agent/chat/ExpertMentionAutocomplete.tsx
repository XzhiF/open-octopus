'use client'

// `@专家` mention picker — one-turn subagent dispatch.
// Distinct from the identity chip (which switches the session's lead role):
// an @ mention only sends the expert as a subagent for the current turn.

import { useEffect, useMemo, useRef, useState } from 'react'
import { UserRound, Check } from 'lucide-react'
import { EXPERT_ROLES, type ExpertRole } from '@/lib/expert-roles'
import { cn } from '@/lib/utils'

interface ExpertMentionAutocompleteProps {
  inputValue: string
  onSelect: (role: ExpertRole) => void
  /** Parent uses this to route Enter/arrows to the picker, not the send path. */
  onOpenChange?: (open: boolean) => void
}

export function ExpertMentionAutocomplete({
  inputValue,
  onSelect,
  onOpenChange,
}: ExpertMentionAutocompleteProps) {
  const [filter, setFilter] = useState('')
  const [visible, setVisible] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Single @ only. `@@` is clone delegation and is handled elsewhere.
    const match = inputValue.match(/(^|\s)@([^\s@]*)$/)
    if (match) {
      setFilter(match[2])
      setVisible(true)
      setSelectedIndex(0)
    } else {
      setVisible(false)
      setFilter('')
    }
  }, [inputValue])

  useEffect(() => {
    onOpenChange?.(visible)
  }, [visible, onOpenChange])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return EXPERT_ROLES
    return EXPERT_ROLES.filter((role) =>
      role.id.toLowerCase().includes(q) ||
      role.name.toLowerCase().includes(q) ||
      role.label.toLowerCase().includes(q) ||
      role.desc.toLowerCase().includes(q),
    )
  }, [filter])

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        if (filtered.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        onSelect(filtered[selectedIndex] ?? filtered[0])
        setVisible(false)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setVisible(false)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [visible, filtered, selectedIndex, onSelect])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setVisible(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  if (!visible) return null

  return (
    <div
      ref={containerRef}
      data-testid="expert-mention-picker"
      className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-64 overflow-auto rounded-[10px] border border-pop-bd bg-pop-paper shadow-pop"
    >
      <div className="flex items-center gap-1.5 border-b border-pop-bd/60 px-3 py-1.5 text-[10px] text-pop-dim">
        <UserRound className="size-3 text-pop-purple" />
        @ 专家 — 派一个子代理，不改变当前身份
      </div>
      {filtered.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-pop-dim">没有匹配的专家</div>
      ) : (
        filtered.map((role, i) => (
          <button
            key={role.id}
            type="button"
            data-testid="expert-mention-item"
            data-expert-id={role.id}
            onMouseEnter={() => setSelectedIndex(i)}
            onClick={() => {
              onSelect(role)
              setVisible(false)
            }}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
              i === selectedIndex ? 'bg-pop-purple-soft text-pop-ink' : 'text-pop-dim hover:bg-pop-bd/20',
            )}
          >
            <span className="w-5 shrink-0 text-center text-[13px]">{role.label.split(' ')[0]}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium text-pop-ink">{role.name}</span>
              <span className="block truncate text-[10px] text-pop-dim">{role.desc}</span>
            </span>
            {i === selectedIndex && <Check className="size-3 shrink-0 text-pop-purple" />}
          </button>
        ))
      )}
    </div>
  )
}
