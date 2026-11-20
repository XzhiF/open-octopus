'use client'

// v21 二轮（原型 cockpit-v21.html · 通讯台头部遥测）：
//   MODEL <模型 · 思考档> │ CTX <占用K / 上限 · 占用% + 内部进度条> │ TOKEN <tok · ¥>
//   三枚都以芯片为中心向下展开，宽度 / 位置夹在通讯台内（prototype posDrop）。
//
// 数据全部真源：
//   · 模型 / 思考强度 / 上下文窗口 ← chat（composer 上报的进程级设置）
//   · 上下文构成 ← chat.contextUsage（classic ContextUsagePanel 单源）
//   · 本会话 token 账 ← chat.usage（classic SessionCostLedger 单源）
//   · 本舱按主体 ← useCabinUsage（30s 轮询，失败留上次值）
//
// 与右栏「消耗」划清：那里的面板 = 本舱账本（全域累计、只读）；
// 这里的下拉 = 本会话明细，底部有「本舱账本 →」入口。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { ContextUsagePanel } from '@/components/agent/chat/context-usage-panel'
import { SessionCostLedger } from '@/components/agent/chat/session-cost-ledger'
import { useBillingCurrency } from '@/lib/billing-currency'
import { formatCost, formatTokenCount } from '@/lib/format'
import {
  COMPOSER_CONTEXT_OPTIONS,
  DEFAULT_MODEL_PRESETS,
  type ComposerContext,
  type ComposerEffort,
} from '@/lib/agent/composer-settings'
import { useCabinUsage } from '../bridge/use-cabin-usage'
import { useCockpitState } from '../state/CockpitStateProvider'
import type { CockpitChatApi } from '../state/cockpit-state'

/** Esc 顺序：遥测下拉（65）在通讯台（60）之上，先收下拉。 */
const TELEMETRY_LAYER_PRIORITY = 65

type DropKind = 'model' | 'ctx' | 'tok'

const MODELS = [
  { id: 'pro-max', desc: '最强 · 复杂重构与 Spec 共建', tag: '' },
  { id: 'pro', desc: '均衡 · 日常执行', tag: '默认' },
  { id: 'se', desc: '轻量 · 快，走查与轻任务', tag: '' },
] as const

/** 原型 EFFORTS 文案（classic 的「中 / 最大」在舱里显示为「标准 / 极深」）。 */
const EFFORTS: Array<{ id: ComposerEffort; label: string }> = [
  { id: 'low', label: '低' },
  { id: 'medium', label: '标准' },
  { id: 'high', label: '高' },
  { id: 'max', label: '极深' },
]

const ROW_COLORS = [
  'var(--ck12-sky)',
  'var(--ck12-violet, #7B4DFF)',
  'var(--ck12-green)',
  'var(--ck12-hazard)',
  'var(--ck12-red)',
  'var(--ck12-pink)',
] as const

function effortLabelOf(effort: ComposerEffort | null | undefined): string {
  return EFFORTS.find((item) => item.id === effort)?.label ?? String(effort ?? '')
}

export function CockpitConsoleTelemetry() {
  const { chat, entryCabinId, openPanel, layer } = useCockpitState()
  const { usage, stale } = useCabinUsage(entryCabinId)
  const currency = useBillingCurrency()

  const [open, setOpen] = useState<DropKind | null>(null)
  const [geom, setGeom] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)

  const telemRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const chipRefs = useRef<Record<DropKind, HTMLButtonElement | null>>({
    model: null,
    ctx: null,
    tok: null,
  })

  const toggle = useCallback((kind: DropKind) => {
    setOpen((current) => (current === kind ? null : kind))
  }, [])
  const close = useCallback(() => setOpen(null), [])

  // 位置：以芯片为中心向下展开，夹在通讯台内（原型 posDrop）。
  useLayoutEffect(() => {
    if (!open) return
    const hostEl = telemRef.current?.closest<HTMLElement>('.ck12-comms')
    const chip = chipRefs.current[open]
    if (!hostEl || !chip) return
    const place = () => {
      const host = hostEl.getBoundingClientRect()
      const btn = chip.getBoundingClientRect()
      const width = Math.max(220, Math.min(380, host.width - 12))
      let left = btn.left + btn.width / 2 - width / 2
      left = Math.max(host.left + 6, Math.min(left, host.right - width - 6))
      const top = btn.bottom - host.top + 6
      const maxHeight = Math.max(120, Math.min(360, host.bottom - btn.bottom - 16))
      setGeom({ left: left - host.left, top, width, maxHeight })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  // 点外面收起。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (telemRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  // Esc：先收下拉（层栈 65 > 通讯台 60）。
  useEffect(() => {
    if (!open) return
    return layer.register('cockpit-console-telemetry', TELEMETRY_LAYER_PRIORITY, close)
  }, [open, layer, close])

  // Escape 走层栈时不会到 React 的 onKeyDown；这里再兜一层 pointer 关不掉时的焦点场景。
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const tokenTotal = chat?.usage?.totals.tokens ?? null
  const tokenLabel = tokenTotal == null ? '未就绪' : formatTokenCount(tokenTotal)
  const sessionCost = chat?.usage?.totals.cost.usd ?? null
  const sessionCostLabel = sessionCost == null
    ? '—'
    : formatCost(sessionCost, chat?.usage?.totals.cost.complete ?? true, currency)
  // 上下文芯片（2026-11-19 用户）：与 classic ContextUsageChip 同形 ——
  // `80.1K / 1M · 8.0%` + 芯片内进度条，不再只显示百分比。
  const ctx = chat?.contextUsage ?? null
  const ctxPct = ctx == null
    ? null
    : Math.min(100, Math.max(0, Number.isFinite(ctx.percentage) ? ctx.percentage : 0))
  const ctxTone = ctxPct == null ? 'ok' : ctxPct >= 85 ? 'hot' : ctxPct >= 60 ? 'warn' : 'ok'
  const ctxTokensLabel = ctx == null
    ? ''
    : `${formatTokenCount(ctx.totalTokens)} / ${formatTokenCount(ctx.maxTokens, 0)}`
  const modelLabel = chat
    ? `${chat.model} · ${effortLabelOf(chat.effort)}`
    : '未就绪'

  const startLedger = useCallback(() => {
    setOpen(null)
    openPanel('ledger')
  }, [openPanel])

  return (
    <span className="ck12-telem" ref={telemRef}>
      <button
        ref={(node) => { chipRefs.current.model = node }}
        type="button"
        className="ck12-tc ck12-tcc"
        aria-expanded={open === 'model'}
        title="模型设置 · 模型 / 思考强度 / 最大上下文"
        data-testid="cockpit-con-model"
        onClick={() => toggle('model')}
      >
        <i>MODEL</i>
        <b>{modelLabel}</b>
      </button>
      <button
        ref={(node) => { chipRefs.current.ctx = node }}
        type="button"
        className="ck12-tc ck12-tcc is-ctx"
        data-tone={ctxTone}
        aria-expanded={open === 'ctx'}
        title={ctx
          ? `上下文占用 ${ctxTokensLabel} · 点击看构成与压缩`
          : '上下文占用 · 未就绪 · 点击看构成与压缩'}
        data-testid="cockpit-con-ctx"
        onClick={() => toggle('ctx')}
      >
        <i>CTX</i>
        {ctx && ctxPct != null ? (
          <b className="ck12-ctx-val" data-testid="cockpit-con-ctx-value">
            <span className="ck12-ctx-tok">{ctxTokensLabel}</span>
            <span className="ck12-ctx-pct">
              {ctx.estimated ? '~' : ''}
              {ctxPct.toFixed(1)}%
            </span>
          </b>
        ) : (
          <b>未就绪</b>
        )}
        {ctx && ctxPct != null && (
          <>
            <span className="ck12-ctx-fill" aria-hidden="true" style={{ width: `${ctxPct}%` }} />
            <span className="ck12-ctx-bar" aria-hidden="true">
              <i style={{ width: `${ctxPct}%` }} />
            </span>
          </>
        )}
      </button>
      <button
        ref={(node) => { chipRefs.current.tok = node }}
        type="button"
        className="ck12-tc ck12-tcc is-tok"
        aria-expanded={open === 'tok'}
        title="本次会话 token / 费用 · 点击看明细（只读）"
        data-testid="cockpit-con-token"
        onClick={() => toggle('tok')}
      >
        <i>TOKEN</i>
        <b>{tokenLabel} · {sessionCostLabel}</b>
      </button>

      {open && geom && (
        <div
          ref={panelRef}
          className="ck12-telemdrop"
          data-testid={`cockpit-con-drop-${open}`}
          style={{
            left: geom.left,
            top: geom.top,
            width: geom.width,
            maxHeight: geom.maxHeight,
          }}
        >
          {open === 'model' && (
            <ModelDrop chat={chat} onClose={close} />
          )}
          {open === 'ctx' && (
            <CtxDrop
              chat={chat}
              usage={usage}
              stale={stale}
              currency={currency}
              onClose={close}
              onLedger={startLedger}
            />
          )}
          {open === 'tok' && (
            <TokDrop chat={chat} currency={currency} onClose={close} onLedger={startLedger} />
          )}
        </div>
      )}
    </span>
  )
}

function DropHead({
  title,
  note,
  onClose,
}: {
  title: string
  note: string
  onClose: () => void
}) {
  return (
    <div className="ck12-tp-h">
      <button type="button" className="ck12-tp-x" title="关闭" aria-label="关闭" onClick={onClose}>
        <X className="size-2.5" aria-hidden="true" />
      </button>
      <b>{title}</b>
      <span>{note}</span>
    </div>
  )
}

function ModelDrop({ chat, onClose }: { chat: CockpitChatApi | null; onClose: () => void }) {
  if (!chat) {
    return (
      <>
        <DropHead title="模型设置" note="每个模型独立预设" onClose={onClose} />
        <div className="ck12-tp-empty">未就绪 · 主会话还没有接通</div>
      </>
    )
  }
  const presetOf = (id: string) => DEFAULT_MODEL_PRESETS[id] ?? DEFAULT_MODEL_PRESETS.pro
  const apply = (id: string) => {
    const preset = presetOf(id)
    chat.setModel(id)
    chat.setEffort(preset.effort)
    chat.setContext(preset.context)
  }

  return (
    <>
      <DropHead title="模型设置" note="每个模型独立预设" onClose={onClose} />
      <div className="ck12-mp-list">
        {MODELS.map((model) => {
          const preset = presetOf(model.id)
          const active = chat.model === model.id
          return (
            <button
              key={model.id}
              type="button"
              className={`ck12-mp-row${active ? ' is-on' : ''}`}
              aria-pressed={active}
              data-testid={`cockpit-model-${model.id}`}
              onClick={() => apply(model.id)}
            >
              <span className="ck12-mp-rad" aria-hidden="true" />
              <span className="ck12-mp-main">
                <b>
                  {model.id}
                  {model.tag && <span className="ck12-mp-tag">{model.tag}</span>}
                </b>
                <span>{model.desc}</span>
              </span>
              <span className="ck12-mp-pre">
                {effortLabelOf(preset.effort)} · {preset.context === '1m' ? '1M' : '200k'}
                <i>{active ? '当前' : '预设'}</i>
              </span>
            </button>
          )
        })}
      </div>

      <div className="ck12-mp-sect"><span>思考强度</span><small>{chat.model}</small></div>
      <div className="ck12-mp-seg">
        {EFFORTS.map((effort) => (
          <button
            key={effort.id}
            type="button"
            className={`ck12-mp-opt${chat.effort === effort.id ? ' is-on' : ''}`}
            aria-pressed={chat.effort === effort.id}
            data-testid={`cockpit-effort-${effort.id}`}
            onClick={() => chat.setEffort(effort.id)}
          >
            {effort.label}
          </button>
        ))}
      </div>

      <div className="ck12-mp-sect"><span>最大上下文</span><small>{chat.model}</small></div>
      <div className="ck12-mp-seg is-two">
        {COMPOSER_CONTEXT_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`ck12-mp-opt${chat.contextWindow === option.id ? ' is-on' : ''}`}
            aria-pressed={chat.contextWindow === option.id}
            data-testid={`cockpit-context-${option.id}`}
            onClick={() => chat.setContext(option.id as ComposerContext)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="ck12-tp-f">仅影响对话 · 切换模型将重建会话缓存</div>
    </>
  )
}

function CtxDrop({
  chat,
  usage,
  stale,
  currency,
  onClose,
  onLedger,
}: {
  chat: CockpitChatApi | null
  usage: ReturnType<typeof useCabinUsage>['usage']
  stale: boolean
  currency: ReturnType<typeof useBillingCurrency>
  onClose: () => void
  onLedger: () => void
}) {
  const rows = usage?.byJob ?? []
  const subagents = usage?.subagents ?? null
  const maxCost = Math.max(
    0,
    ...rows.map((row) => row.totals.cost.usd ?? 0),
    subagents?.cost.usd ?? 0,
  )
  const context = chat?.contextUsage ?? null

  const compact = () => {
    if (!chat) return
    chat.submit('/compact')
    toast.success('已请汐音压缩上下文')
    onClose()
  }

  return (
    <>
      <DropHead title="上下文与消耗" note="本会话 · 本轮" onClose={onClose} />
      <div className="ck12-tp-b">
        {context ? (
          <ContextUsagePanel contextUsage={context} />
        ) : (
          <div className="ck12-tp-empty">未就绪 · 这一轮还没有上下文数据</div>
        )}

        <div className="ck12-tp-sep" />
        <div className="ck12-tp-sub">本舱按主体<small>{stale ? '读取失败 · 上次值' : '30s 刷新'}</small></div>
        {rows.map((row, index) => {
          const usd = row.totals.cost.usd
          const width = usd != null && maxCost > 0 ? Math.max(3, (usd / maxCost) * 100) : 0
          const color = ROW_COLORS[index % ROW_COLORS.length]
          return (
            <div className="ck12-tp-row" key={row.job_id ?? `${row.kind}:${row.label}:${index}`}>
              <span className="nm">
                <i className="ck12-ct-dot" style={{ backgroundColor: color }} />
                <span title={row.label}>{row.label}</span>
              </span>
              <span className="ck12-tp-bar"><i style={{ width: `${width}%`, backgroundColor: color }} /></span>
              <b>{usd == null ? '—' : formatCost(usd, row.totals.cost.complete, currency)}</b>
            </div>
          )
        })}
        {subagents && subagents.count > 0 && (
          <div className="ck12-tp-row">
            <span className="nm">
              <i className="ck12-ct-dot" style={{ backgroundColor: 'var(--ck12-violet, #7B4DFF)' }} />
              子代理 · {subagents.count}
            </span>
            <span className="ck12-tp-bar">
              <i
                style={{
                  width: `${subagents.cost.usd != null && maxCost > 0 ? Math.max(3, (subagents.cost.usd / maxCost) * 100) : 0}%`,
                  backgroundColor: 'var(--ck12-violet, #7B4DFF)',
                }}
              />
            </span>
            <b>{subagents.cost.usd == null ? '—' : formatCost(subagents.cost.usd, subagents.cost.complete, currency)}</b>
          </div>
        )}
        {rows.length === 0 && (!subagents || subagents.count === 0) && (
          <div className="ck12-tp-row"><span className="nm">— · 本舱还没有用量</span></div>
        )}
      </div>
      <div className="ck12-tp-f">
        <button type="button" className="ck12-tp-btn" onClick={compact} disabled={!chat}>压缩上下文</button>
        <span className="ck12-tp-sp" />
        <button type="button" className="ck12-tp-btn is-go" onClick={onLedger}>本舱账本 →</button>
      </div>
    </>
  )
}

function TokDrop({
  chat,
  currency: _currency,
  onClose,
  onLedger,
}: {
  chat: CockpitChatApi | null
  currency: ReturnType<typeof useBillingCurrency>
  onClose: () => void
  onLedger: () => void
}) {
  const usage = chat?.usage ?? null
  return (
    <>
      <DropHead
        title="本会话 token 账"
        note={usage ? `${usage.totalCalls} 次请求` : '未就绪'}
        onClose={onClose}
      />
      <div className="ck12-tp-b">
        {usage ? (
          <SessionCostLedger usage={usage} contextUsage={chat?.contextUsage ?? null} hideFooter />
        ) : (
          <div className="ck12-tp-empty">未就绪 · 主会话还没有 token 账</div>
        )}
      </div>
      <div className="ck12-tp-f">
        <span>单价 = 每 1M token · 现算不落库</span>
        <span className="ck12-tp-sp" />
        <button type="button" className="ck12-tp-btn is-go" onClick={onLedger}>本舱账本 →</button>
      </div>
    </>
  )
}
