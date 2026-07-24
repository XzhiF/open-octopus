'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import type { CloneInfo } from '@/lib/agent/types'
import * as api from '@/lib/agent/api'
import { cn } from '@/lib/utils'

interface MentionAutocompleteProps {
  /** Current input value */
  inputValue: string
  /** Callback when a clone is selected */
  onSelect: (cloneName: string) => void
  /** Position relative to textarea */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  /** Current clone name (for self-reference detection) */
  currentCloneName?: string | null
}

export function MentionAutocomplete({
  inputValue,
  onSelect,
  textareaRef,
  currentCloneName,
}: MentionAutocompleteProps) {
  const [clones, setClones] = useState<CloneInfo[]>([])
  const [visible, setVisible] = useState(false)
  const [filter, setFilter] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const clonesCacheRef = useRef<CloneInfo[] | null>(null)

  // Detect @@ pattern in input
  useEffect(() => {
    const match = inputValue.match(/@@([a-z0-9-]*)$/)
    if (match) {
      const query = match[1]
      setFilter(query)
      setVisible(true)
      setSelectedIndex(0)

      // Load clones if not cached
      if (!clonesCacheRef.current) {
        setLoading(true)
        api.listClones()
          .then(res => {
            // Filter out Main Agent (no upward delegation)
            const filtered = res.clones.filter(c => c.name !== 'main-agent')
            setClones(filtered)
            clonesCacheRef.current = filtered
          })
          .catch(() => {
            setClones([])
          })
          .finally(() => setLoading(false))
      } else {
        setClones(clonesCacheRef.current)
      }
    } else {
      setVisible(false)
      setFilter('')
    }
  }, [inputValue])

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setVisible(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Keyboard navigation
  useEffect(() => {
    if (!visible) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(prev => Math.min(prev + 1, filteredClones.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(prev => Math.max(prev - 1, 0))
      } else if (e.key === 'Escape') {
        setVisible(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [visible, filter, clones])

  // Filter clones by typed characters
  const filteredClones = clones.filter(c => {
    if (!filter) return true
    const q = filter.toLowerCase()
    return c.name.includes(q) || c.display_name.toLowerCase().includes(q)
  })

  // Reset selected index when filter changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  const handleSelect = useCallback((clone: CloneInfo) => {
    onSelect(clone.name)
    setVisible(false)
  }, [onSelect])

  if (!visible || filteredClones.length === 0) return null

  return (
    <div
      ref={containerRef}
      className={cn(
        'absolute bottom-full left-0 right-0 mb-2 z-50',
        'bg-popover border border-border rounded-lg shadow-lg',
        'max-h-60 overflow-auto'
      )}
    >
      {loading ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">加载分身列表...</div>
      ) : (
        <>
          <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-b">
            @@ 委托分身 — 输入选择目标
          </div>
          {filteredClones.map((clone, i) => (
            <button
              key={clone.name}
              onClick={() => handleSelect(clone)}
              className={cn(
                'w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-accent transition-colors',
                i === selectedIndex && 'bg-accent',
                clone.name === currentCloneName && 'opacity-50' // Self-reference hint
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium truncate">{clone.display_name}</span>
                  <Badge
                    variant={clone.type === 'built-in' ? 'secondary' : 'outline'}
                    className="text-[9px] px-1 py-0 h-3.5"
                  >
                    {clone.type === 'built-in' ? '系统' : '用户'}
                  </Badge>
                  {clone.name === currentCloneName && (
                    <span className="text-[9px] text-muted-foreground">(当前)</span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground font-mono">{clone.name}</span>
              </div>
            </button>
          ))}
        </>
      )}
    </div>
  )
}

/**
 * Parse @@mention from message text.
 * Returns { delegate_to, cleanMessage } or null if no mention detected.
 */
export function parseMention(text: string): { delegate_to: string; cleanMessage: string } | null {
  // Match @@clone-name at the start of the message
  const match = text.match(/^@@([a-z0-9-]+)\s*(.*)$/s)
  if (!match) return null

  const cloneName = match[1]
  const cleanMessage = match[2].trim()

  if (!cleanMessage) return null // Empty message after stripping mention

  return { delegate_to: cloneName, cleanMessage }
}
