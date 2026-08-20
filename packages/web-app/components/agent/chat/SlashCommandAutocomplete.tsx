'use client'

// packages/web-app/components/agent/chat/SlashCommandAutocomplete.tsx
//
// Slash-command autocomplete for the chat input. Triggered when the user
// types `/` at the start of the input (the entire input is the partial
// command). Shows a dropdown of available commands filtered by what the
// user has typed so far. Selection (click / Enter / Tab) inserts
// `/command-name ` into the input so the user can continue typing the
// prompt argument.
//
// Mirrors the MentionAutocomplete pattern (popover above the input,
// arrow-key navigation, Escape to close) but with a static command list
// from props instead of a fetched clone list.

import { useState, useEffect, useRef, useCallback } from 'react'
import { cn } from '@/lib/utils'

export interface SlashCommand {
  /** Command name without the leading `/` (e.g. "octo-guide"). */
  name: string
  /** Optional description shown as secondary text in the dropdown. */
  description?: string
}

interface SlashCommandAutocompleteProps {
  /** Current input value (the full textarea text). */
  inputValue: string
  /** Available commands (derived from the task's locked skill groups). */
  commands: SlashCommand[]
  /** Called with the selected command name. Parent replaces input with
   *  `/commandName ` (trailing space). */
  onSelect: (commandName: string) => void
  /** Fires when the dropdown opens/closes. Parent uses this to gate the
   *  Enter key so it selects from the dropdown instead of sending. */
  onOpenChange: (isOpen: boolean) => void
}

/** Detect whether the input is a partial slash command (the entire input
 *  is `/` followed by optional command-name characters). Returns the
 *  partial query (everything after `/`) or null if the pattern doesn't
 *  match (e.g. input has a space → user already moved past the command). */
function matchSlashTrigger(input: string): string | null {
  const m = input.match(/^\/([a-z0-9-]*)$/)
  return m ? m[1] : null
}

export function SlashCommandAutocomplete({
  inputValue,
  commands,
  onSelect,
  onOpenChange,
}: SlashCommandAutocompleteProps) {
  const [visible, setVisible] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // Track open state → notify parent for Enter-key gating.
  const notifyOpen = useCallback((open: boolean) => {
    setVisible(open)
    onOpenChange(open)
  }, [onOpenChange])

  // Detect `/partial` in the input.
  useEffect(() => {
    const q = matchSlashTrigger(inputValue)
    if (q !== null && commands.length > 0) {
      setQuery(q)
      setSelectedIndex(0)
      notifyOpen(true)
    } else {
      notifyOpen(false)
      setQuery('')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to input changes
  }, [inputValue, commands.length])

  // Close on outside click.
  useEffect(() => {
    if (!visible) return
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        notifyOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [visible, notifyOpen])

  // Filter commands by the partial query.
  // Name: prefix match (startsWith) — typing `/cxx` should NOT match `/octo-guide`.
  // Description: includes match (looser — the query can appear anywhere in desc).
  // When query is non-empty, at least one must match for the command to appear.
  const filtered = commands.filter((cmd) => {
    if (!query) return true
    const q = query.toLowerCase()
    const nameMatches = cmd.name.toLowerCase().startsWith(q)
    const descMatches = cmd.description?.toLowerCase().includes(q) ?? false
    return nameMatches || descMatches
  })

  // Reset selected index when filter changes.
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Keyboard navigation (global while visible).
  useEffect(() => {
    if (!visible || filtered.length === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()  // Prevent Dialog from closing — only dismiss the dropdown
        notifyOpen(false)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        const cmd = filtered[selectedIndex]
        if (cmd) {
          onSelect(cmd.name)
          notifyOpen(false)
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [visible, filtered, selectedIndex, onSelect, notifyOpen])

  if (!visible || filtered.length === 0) return null

  return (
    <div
      ref={containerRef}
      data-slash-autocomplete
      className={cn(
        'absolute bottom-full left-0 right-0 mb-2 z-50',
        'bg-popover border border-border rounded-lg shadow-lg',
        'max-h-60 overflow-auto',
      )}
    >
      <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-b">
        / 调用技能 — 选择后输入参数，Enter 发送
      </div>
      {filtered.map((cmd, i) => (
        <button
          key={cmd.name}
          onClick={() => { onSelect(cmd.name); notifyOpen(false) }}
          className={cn(
            'w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-accent transition-colors',
            i === selectedIndex && 'bg-accent',
          )}
        >
          <code className="text-sm font-mono font-medium text-blue-600 shrink-0">
            /{cmd.name}
          </code>
          {cmd.description && (
            <span className="text-xs text-muted-foreground truncate mt-0.5">
              {cmd.description}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
