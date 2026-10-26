'use client'

// `@` / `@@` 分身 picker — 本轮委派子代理会诊（一次性），不改变当前身份。
// 与身份 chip 刻意分工：chip = 持久换身份（角色卡）；@ = 本轮会诊。
// 选中插入 `@@<clone-name>`（ASCII slug，服务端按它解析），消息原文入转发。

import { useState, useEffect, useRef, useCallback } from 'react'
import { Badge } from '@/components/ui/badge'
import { UserRound } from 'lucide-react'
import type { CloneInfo } from '@/lib/agent/types'
import * as api from '@/lib/agent/api'
import { cn } from '@/lib/utils'

interface MentionAutocompleteProps {
  /** Current input value */
  inputValue: string
  /** Callback when a clone is selected (clone name / slug) */
  onSelect: (cloneName: string) => void
  /** Position relative to textarea */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null> | null
  /** Current clone name (for self-reference detection) */
  currentCloneName?: string | null
  /** Parent uses this to route Enter/arrows to the picker, not the send path. */
  onOpenChange?: (open: boolean) => void
}

export function MentionAutocomplete({
  inputValue,
  onSelect,
  textareaRef,
  currentCloneName,
  onOpenChange,
}: MentionAutocompleteProps) {
  const [clones, setClones] = useState<CloneInfo[]>([])
  const [visible, setVisible] = useState(false)
  const [filter, setFilter] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const clonesCacheRef = useRef<CloneInfo[] | null>(null)

  // Detect `@` / `@@` pattern in input (single or double @, same roster).
  useEffect(() => {
    const match = inputValue.match(/(^|\s)@(@?)([^\s@]*)$/)
    if (match) {
      const query = match[3]
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

  useEffect(() => {
    onOpenChange?.(visible)
  }, [visible, onOpenChange])

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

  // Filter clones by typed characters (display name / slug / skills)
  const filteredClones = clones.filter(c => {
    if (!filter) return true
    const q = filter.toLowerCase()
    return (
      c.name.toLowerCase().includes(q) ||
      c.display_name.toLowerCase().includes(q) ||
      c.skills.some((s) => s.toLowerCase().includes(q))
    )
  })

  // Reset selected index when filter changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  const handleSelect = useCallback((clone: CloneInfo) => {
    onSelect(clone.name)
    setVisible(false)
  }, [onSelect])

  // Keyboard navigation — capture phase so Enter belongs to the picker while open.
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
        e.preventDefault()
        setVisible(false)
      } else if (e.key === 'Enter') {
        if (filteredClones.length === 0) return
        e.preventDefault()
        e.stopPropagation()
        handleSelect(filteredClones[selectedIndex] ?? filteredClones[0])
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [visible, filteredClones, selectedIndex, handleSelect])

  if (!visible || filteredClones.length === 0) return null

  return (
    <div
      ref={containerRef}
      data-testid="clone-mention-picker"
      className={cn(
        'absolute bottom-full left-0 right-0 mb-2 z-50',
        'bg-popover border border-border rounded-lg shadow-lg',
        'max-h-64 overflow-auto'
      )}
    >
      {loading ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">加载分身列表...</div>
      ) : (
        <>
          <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] text-muted-foreground border-b">
            <UserRound className="size-3 text-pop-purple" />
            @ 分身 — 本轮委派子代理会诊，不改变当前身份
          </div>
          {filteredClones.map((clone, i) => (
            <button
              key={clone.name}
              type="button"
              data-testid="clone-mention-item"
              data-clone-name={clone.name}
              onMouseEnter={() => setSelectedIndex(i)}
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
                <span className="text-xs text-muted-foreground font-mono">
                  {clone.name}
                  {clone.skills.length > 0 && (
                    <span className="ml-2 font-sans">SKILL {clone.skills.join(' · ')}</span>
                  )}
                </span>
              </div>
            </button>
          ))}
        </>
      )}
    </div>
  )
}