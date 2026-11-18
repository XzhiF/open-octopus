'use client'

// 放行窗（2026-11-17 用户口径）：
// inbox 里的「待放行」不再跳任务线程 —— 像问答窗一样直接弹浮窗，汐音用一两句话
// 总结「现在卡在哪、要你定什么」，给选项；选完当场执行（ready / trigger / resume），
// 回执停 1.5s 后自动关窗，行从「要我处理」消项。
//
// 动作由 attention.start_kind 决定：
//   enqueue → draft：立即开跑（静默 ready → trigger）/ 先入列
//   trigger → ready：立即触发
//   resume  → paused：恢复推进
// 落点与问答窗同一纪律：classic 贴编队 / inbox 左侧；cockpit 贴右栏
// 「要我处理」左侧（与 classic 同义 —— 挨着待办悬浮，不跑回左侧编队）。

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, Loader2, X, Zap } from 'lucide-react'
import type { CabinAttentionItem } from '@octopus/shared'
import type { CockpitLayerApi } from '@/components/cockpit/state/cockpit-state'
import { readyTask, resumeTask, triggerTask } from '@/lib/tasks-api'
import { openTaskInChat } from '../modules/ui'
import { nextZ } from '../z-order'
import { readFleetLeft, readRightRailLeft } from './ask-window-layer'
import {
  askRect,
  askWindowContext,
  clampLeft,
  windowWidthFor,
  type AskPlacement,
} from './ask-window-model'
import './ask-window.css'

type StartKind = 'enqueue' | 'trigger' | 'resume'
type Choice = 'launch' | 'enqueue' | 'trigger' | 'resume'

interface Option {
  id: Choice
  label: string
  impact: string
}

const SUMMARY: Record<StartKind, string> = {
  enqueue: '规格和 phase 绑定已经齐了，可以开跑 phase 1。',
  trigger: '任务已入列，下一步就是触发执行。',
  resume: '这一轮被暂停了，可以从暂停点恢复推进。',
}

const RECEIPT: Record<Choice, string> = {
  launch: '✓ 已开跑 · 入列并触发 phase 1，已从「要我处理」消项',
  enqueue: '✓ 已入列 · 等你触发，已从「要我处理」消项',
  trigger: '✓ 已触发执行，已从「要我处理」消项',
  resume: '✓ 已恢复推进，已从「要我处理」消项',
}

function kindOf(item: CabinAttentionItem): StartKind {
  if (item.start_kind) return item.start_kind
  // 兼容旧服务端：从标题后缀兜底（新服务端一定带 start_kind）。
  if (item.title.includes('· 待触发')) return 'trigger'
  if (item.title.includes('· 待恢复')) return 'resume'
  return 'enqueue'
}

function optionsOf(kind: StartKind): Option[] {
  if (kind === 'trigger') {
    return [{ id: 'trigger', label: '立即触发', impact: '马上开跑当前 phase' }]
  }
  if (kind === 'resume') {
    return [{ id: 'resume', label: '恢复推进', impact: '从暂停点继续这一轮' }]
  }
  return [
    { id: 'launch', label: '立即开跑', impact: '入列并马上触发 phase 1（推荐）' },
    { id: 'enqueue', label: '先入列，稍后触发', impact: '只入列，不马上消耗 token' },
  ]
}

function itemName(item: CabinAttentionItem): string {
  return item.title.replace(/\s*·\s*待(入列|触发|恢复)$/, '') || item.title
}

/** 乐观消项键：同一任务从「待入列」变成「待触发」时 attention id 不变，
 *  必须把动作一起算进键里，否则先入列后的新待办会被旧回执一起藏住。 */
export function startDecisionKey(item: CabinAttentionItem): string {
  return `${item.id}:${item.start_kind ?? kindOf(item)}`
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const missing = (err as Error & { missing?: unknown }).missing
    const suffix = Array.isArray(missing) && missing.length > 0
      ? `（缺：${missing.join('、')}）`
      : ''
    return err.message + suffix
  }
  return String(err)
}

/** 放行窗落点（v21 四轮）：classic 贴编队 / inbox 左侧；cockpit 贴右栏
 *  「要我处理」左侧 —— 与 classic 同义，挨着待办悬浮，守住 10px 间距。 */
function placementFor(mode: 'classic' | 'cockpit'): AskPlacement {
  const viewport = { w: window.innerWidth, h: window.innerHeight }
  if (mode === 'cockpit') {
    const width = windowWidthFor('cockpit', viewport.w)
    const railLeft = readRightRailLeft()
    const left = railLeft == null ? viewport.w - width - 24 : railLeft - width - 10
    return { left: clampLeft(left, width, viewport.w), top: 62, width }
  }
  return askRect('classic', { fleetLeft: readFleetLeft(), openCount: 0, viewport })
}

export interface StartWindowProps {
  item: CabinAttentionItem
  onClose: () => void
  /** 执行成功：inbox 立即乐观消项（键含动作，见 startDecisionKey），并触发一次刷新。 */
  onDecided: (decisionKey: string) => void
  /** 放置模式：classic 贴编队左缘、cockpit 贴编队右缘（默认 classic，行为不变）。 */
  mode?: 'classic' | 'cockpit'
  /** cockpit：Esc 走唯一层栈（priority 125 —— 先于 inbox 120 收放行窗）。 */
  escLayer?: CockpitLayerApi
}

export function StartWindow({ item, onClose, onDecided, mode = 'classic', escLayer }: StartWindowProps) {
  const taskId = item.task_id
  const kind = kindOf(item)
  const options = optionsOf(kind)

  const [mounted, setMounted] = useState(false)
  const [choice, setChoice] = useState<Choice>(options[0]?.id ?? 'enqueue')
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [z, setZ] = useState(() => nextZ())

  const [pos, setPos] = useState<AskPlacement>(() => {
    if (typeof window === 'undefined') return { left: 0, top: 56, width: 520 }
    return placementFor(mode)
  })

  const rootRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => setMounted(true), [])
  useEffect(() => { rootRef.current?.focus() }, [])

  // Esc：cockpit 走唯一层栈（125 > inbox 120）；classic 只关这一扇，
  // 若问答窗已处理（preventDefault）则让位。
  useEffect(() => {
    if (escLayer) {
      return escLayer.register('cabin-start-window', 125, () => closeRef.current())
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      closeRef.current()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [escLayer])

  // resize：只夹 x（与问答窗同纪律）；宽度按模式重取。
  useEffect(() => {
    const onResize = () => {
      setPos((prev) => {
        const width = mode === 'cockpit'
          ? windowWidthFor('cockpit', window.innerWidth)
          : Math.min(520, Math.max(240, window.innerWidth - 24))
        const left = clampLeft(prev.left, width, window.innerWidth)
        return { left, top: prev.top, width }
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [mode])

  // 成功回执停 1.5s 后自动关窗（与问答窗同口径）。
  useEffect(() => {
    if (!receipt) return
    const timer = window.setTimeout(() => closeRef.current(), 1_500)
    return () => window.clearTimeout(timer)
  }, [receipt])

  // ── 拖动 ────────────────────────────────────────────────────────────
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
  const posRef = useRef(pos)
  posRef.current = pos

  const beginDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: posRef.current.left,
      top: posRef.current.top,
    }
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const width = posRef.current.width
    const left = Math.max(8, Math.min(
      drag.left + (event.clientX - drag.x),
      Math.max(8, window.innerWidth - width - 8),
    ))
    const top = Math.max(0, drag.top + (event.clientY - drag.y))
    setPos({ left, top, width })
  }, [])

  const endDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
  }, [])

  const execute = useCallback(async () => {
    if (!taskId || busy) return
    setBusy(true)
    setError(null)
    try {
      if (choice === 'launch') {
        await readyTask(taskId, { silentCard: true })
        await triggerTask(taskId)
      } else if (choice === 'enqueue') {
        await readyTask(taskId)
      } else if (choice === 'trigger') {
        await triggerTask(taskId)
      } else {
        await resumeTask(taskId)
      }
      onDecided(startDecisionKey(item))
      setReceipt(RECEIPT[choice])
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [busy, choice, item, onDecided, taskId])

  if (!mounted) return null

  const name = itemName(item)
  const ctx = askWindowContext(item, { ask_id: '' })
  const done = !!receipt

  return createPortal(
    <section
      ref={rootRef}
      tabIndex={-1}
      className={`ck-askwin ck-startwin ck-askwin--${mode}`}
      style={{ left: pos.left, top: pos.top, width: pos.width, zIndex: z }}
      data-testid={`cabin-start-window-${item.id}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`startwin-title-${item.id}`}
      onPointerDownCapture={() => setZ(nextZ())}
    >
      <header
        className="ck-askwin-h"
        onPointerDown={beginDrag}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="ck-askwin-lights">
          <button
            type="button"
            className="ck-askwin-x"
            aria-label="关闭放行窗"
            title="关闭（Esc）"
            onClick={onClose}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
        <span className="ck-askwin-glyph" aria-hidden="true">⚑</span>
        <span className="ck-askwin-tag">放行</span>
        <span className="ck-askwin-title" id={`startwin-title-${item.id}`}>
          {item.handle && <b className="ck-askwin-handle">{item.handle}</b>}
          {name}
        </span>
        <span className="ck-askwin-pill" data-state={done ? 'done' : 'wait'}>
          {done ? '已执行' : '待放行'}
        </span>
        {ctx && <span className="ck-askwin-ctx">{ctx}</span>}
        <span className="ck-askwin-grip" aria-hidden="true">⠿</span>
      </header>

      <div className="ck-askwin-body">
        <div className="ck-askwin-from">
          <span className="ck-askwin-av" aria-hidden="true">汐</span>
          <span><b>汐音</b> · {SUMMARY[kind]}</span>
        </div>

        {item.detail && <div className="ck-startwin-detail">{item.detail}</div>}

        {done ? (
          <div className="ck-askwin-receipt" data-testid="cabin-start-window-receipt">
            <CheckCircle2 className="size-4 shrink-0 text-pop-green" aria-hidden="true" />
            <span>{receipt}</span>
          </div>
        ) : (
          <>
            <div className="ck-askwin-q">要现在放行吗？</div>
            <div className="ck-askwin-opts" role="radiogroup" aria-label="放行方式">
              {options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={choice === option.id}
                  className="ck-askwin-opt"
                  data-on={choice === option.id ? 'true' : undefined}
                  data-testid={`cabin-start-window-opt-${option.id}`}
                  onClick={() => setChoice(option.id)}
                >
                  <span className="ck-askwin-radio" aria-hidden="true" />
                  <span className="ck-askwin-optmain">
                    <span>{option.label}</span>
                    <span className="ck-askwin-optimpact">· {option.impact}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="ck-askwin-sendrow">
              <button
                type="button"
                className="ck-askwin-send ck-startwin-exec"
                data-testid="cabin-start-window-exec"
                disabled={busy}
                onClick={() => void execute()}
              >
                {busy ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : null}
                {busy ? '执行中…' : '确认执行'}
              </button>
            </div>
            {error && (
              <div className="ck-askwin-err" data-testid="cabin-start-window-error">
                <span>{error}</span>
              </div>
            )}
          </>
        )}
      </div>

      <footer className="ck-askwin-foot">
        <span className="ck-askwin-sig">
          <Zap className="size-3" aria-hidden="true" />
          选中后汐音直接执行，回执 1.5s 后自动收起
        </span>
        {!done && taskId && (
          <button
            type="button"
            className="ck-askwin-dismiss"
            data-testid="cabin-start-window-open-task"
            onClick={() => { openTaskInChat(taskId); onClose() }}
          >
            打开任务详情
          </button>
        )}
        <button type="button" className="ck-askwin-close" onClick={onClose}>关闭</button>
      </footer>
    </section>,
    document.body,
  )
}
