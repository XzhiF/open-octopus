'use client'

// packages/web-app/components/agent/chat/SlashCommandAutocomplete.tsx
//
// Slash-command autocomplete for the chat input. Triggered when the user
// types `/` at the start of the input (the entire input is the partial
// command). Shows a dropdown of available commands filtered by what the
// user has typed so far. Clicking a row inserts `/command-name ` into the
// input so the user can continue typing the prompt argument.
//
// Mirrors the MentionAutocomplete pattern (popover above the input,
// arrow-key navigation, Escape to close) but with a static command list
// from props instead of a fetched clone list.
//
// 键盘语义（2026-09-24 用户改判「不要必然从列表抓一个命令」）：
//   - Enter：仅当输入「精确等于」某个命令名时提交该命令；否则只收起下拉、
//     原样保留用户敲的字（我输入什么就是什么），再按一次 Enter 才发送。
//   - Tab：取消（收起下拉），不改文本。
//   - 点击某行：插入该命令（保留的显式选择路径）。
//   - Alt+Enter：换行（由宿主 ChatArea 消费，不进本组件）。

import { useState, useEffect, useRef, useCallback } from 'react'
import { cn } from '@/lib/utils'

export interface SlashCommand {
  /** Command name without the leading `/` (e.g. "octo-guide"). */
  name: string
  /** Optional description shown as secondary text in the dropdown. */
  description?: string
  /** 分组：内置命令 / 技能命令（缺省视为 skill）。下拉按此分节展示。 */
  kind?: 'builtin' | 'skill'
}

/** 内置命令表 —— v4 草稿任务不再有 skill_groups 锁定，技能命令可为空，
 *  但内置命令恒可用（原型 chat-draft-v4.html 拍板）。命令集对齐 Claude
 *  Agent SDK 的斜杠命令（服务端 chat 透传，SDK 侧执行）。 */
export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: '压缩会话上下文，保留关键事实', kind: 'builtin' },
  { name: 'context', description: '查看当前上下文窗口占用与构成', kind: 'builtin' },
  { name: 'usage', description: '本轮 token / 费用用量统计', kind: 'builtin' },
  { name: 'cost', description: '查看累计花费', kind: 'builtin' },
  { name: 'status', description: '查看会话与模型运行状态', kind: 'builtin' },
  { name: 'config', description: '查看/调整运行时配置', kind: 'builtin' },
  { name: 'model', description: '切换本轮使用的模型', kind: 'builtin' },
  { name: 'memory', description: '查看/整理 agent 长期记忆', kind: 'builtin' },
  { name: 'resume', description: '恢复历史会话', kind: 'builtin' },
  { name: 'rewind', description: '回退到上一个检查点', kind: 'builtin' },
  { name: 'init', description: '初始化项目上下文（CLAUDE.md）', kind: 'builtin' },
  { name: 'review', description: '代码审查当前改动', kind: 'builtin' },
  { name: 'doctor', description: '诊断环境与配置问题', kind: 'builtin' },
  { name: 'help', description: '查看可用命令', kind: 'builtin' },
  { name: 'clear', description: '清空当前会话', kind: 'builtin' },
  { name: 'stop', description: '打断当前生成', kind: 'builtin' },
]

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
 *  is `/` followed by command-name characters). 字符集放宽：技能名可含
 *  大写字母 / `:` / 中文（原型 v4.3 需求），只要求「/ 开头 + 无空格」。 */
function matchSlashTrigger(input: string): string | null {
  const m = input.match(/^\/(\S*)$/)
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
  // 稳定分组序：内置在前、技能在后（键盘导航作用于展平后的 order）。
  const matched = commands.filter((cmd) => {
    if (!query) return true
    const q = query.toLowerCase()
    const nameMatches = cmd.name.toLowerCase().startsWith(q)
    const descMatches = cmd.description?.toLowerCase().includes(q) ?? false
    return nameMatches || descMatches
  })
  const builtins = matched.filter((c) => c.kind === 'builtin')
  const skills = matched.filter((c) => c.kind !== 'builtin')
  const order = [...builtins, ...skills]

  // Reset selected index when filter changes.
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Keyboard navigation (global while visible).
  useEffect(() => {
    if (!visible || order.length === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.min(prev + 1, order.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) => Math.max(prev - 1, 0))
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()  // Prevent Dialog from closing — only dismiss the dropdown
        notifyOpen(false)
      } else if (e.key === 'Tab') {
        // 取消：只收起下拉，不改用户已敲的文本。
        e.preventDefault()
        e.stopPropagation()
        notifyOpen(false)
      } else if (e.key === 'Enter' && !e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        // 不再「必然选中高亮项」。以 inputValue（受控事实源，query state 可能
        // 慢一拍）解析出已敲partial：精确等于某命令名才补全它；否则只收起
        // 下拉、原样保留输入（我输入什么就是什么）。
        const typed = (matchSlashTrigger(inputValue) ?? '').toLowerCase()
        const exact = typed ? order.find((c) => c.name.toLowerCase() === typed) : undefined
        e.preventDefault()
        e.stopPropagation()
        if (exact) onSelect(exact.name)
        notifyOpen(false)
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [visible, order, selectedIndex, onSelect, notifyOpen])

  if (!visible || order.length === 0) return null

  const renderRow = (cmd: SlashCommand) => {
    const i = order.indexOf(cmd)
    return (
      <button
        key={`${cmd.kind ?? 'skill'}/${cmd.name}`}
        onClick={() => { onSelect(cmd.name); notifyOpen(false) }}
        className={cn(
          'w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-accent transition-colors',
          i === selectedIndex && 'bg-accent',
        )}
      >
        <code className="text-sm font-mono font-medium text-pop-cyan shrink-0">
          /{cmd.name}
        </code>
        {cmd.description && (
          <span className="text-xs text-muted-foreground truncate mt-0.5">
            {cmd.description}
          </span>
        )}
      </button>
    )
  }

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
        / 调用命令 — 点击插入 · ↑↓ 浏览 · Enter 保留输入 · Tab 取消
      </div>
      {builtins.length > 0 && (
        <>
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-[.08em] text-muted-foreground">内置命令</div>
          {builtins.map(renderRow)}
        </>
      )}
      {skills.length > 0 && (
        <>
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-[.08em] text-muted-foreground">技能命令</div>
          {skills.map(renderRow)}
        </>
      )}
    </div>
  )
}
