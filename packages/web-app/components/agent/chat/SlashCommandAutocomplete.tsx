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

/** 命令描述表 —— 只覆盖 CLI 真正在 headless 可用的内置命令。
 *  列表本身不再硬编码：`system:init.slash_commands` 会告诉我们这个会话
 *  （含 plugins/skills）到底有哪些命令。这张表只负责给已知命令配中文说明，
 *  不在表里的名字一律按「技能命令」展示。 */
export const COMMAND_DESCRIPTIONS: Record<string, string> = {
  compact: '压缩会话上下文，保留关键事实',
  context: '查看当前上下文窗口占用与构成',
  usage: '查看 CLI 用量统计（非应用账本）',
  cost: '查看 CLI 累计花费（非应用账本）',
  config: '查看/调整运行时配置',
  model: '切换本轮使用的模型',
  clear: '清空 SDK 上下文（聊天记录保留）',
  init: '初始化项目上下文（CLAUDE.md）',
  doctor: '诊断环境与配置问题',
  mcp: '查看 MCP 服务与工具',
  effort: '调整推理强度',
  fast: '切换快速模式',
  autocompact: '查看/调整自动压缩',
  recap: '回顾会话要点',
  insights: '查看使用洞察',
  goal: '设置收敛目标',
  rename: '重命名会话',
  'security-review': '安全审查当前改动',
}

/** 首次发出消息之前的兜底菜单。CLI 实际命令集在 `system:init` 之后由
 *  `buildSlashCommands()` 替换；这里只列 headless 确认可用的内置命令。 */
export const FALLBACK_SLASH_COMMANDS: SlashCommand[] = Object.entries(COMMAND_DESCRIPTIONS)
  .map(([name, description]) => ({ name, description, kind: 'builtin' as const }))

/** CLI init 命令名 → 下拉行。已知命令归内置组（按兜底表顺序），其余视为技能。 */
export function buildSlashCommands(names?: readonly string[] | null): SlashCommand[] {
  const cleaned = (names ?? []).filter((name) => !!name && !name.startsWith('__'))
  if (cleaned.length === 0) return FALLBACK_SLASH_COMMANDS

  const seen = new Set<string>()
  const builtins: SlashCommand[] = []
  const skills: SlashCommand[] = []
  for (const name of cleaned) {
    if (seen.has(name)) continue
    seen.add(name)
    const description = COMMAND_DESCRIPTIONS[name]
    if (description) builtins.push({ name, description, kind: 'builtin' })
    else skills.push({ name, kind: 'skill' })
  }
  const order = new Map(FALLBACK_SLASH_COMMANDS.map((cmd, i) => [cmd.name, i]))
  builtins.sort((a, b) => (order.get(a.name) ?? 999) - (order.get(b.name) ?? 999))
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return [...builtins, ...skills]
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
