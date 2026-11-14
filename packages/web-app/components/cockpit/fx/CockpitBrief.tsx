'use client'

// S8 owns this file —— 到达简报（v12 .brief）：340px，right:26 top:66，10s 自动收。
// 硬约束（plans §1.6）：**不渲染任何按钮**（含关闭）—— Esc 走 layer.closeTop。
// 同一时刻多条到达合并成一张（标题后缀 +N），不叠窗。
//
// 数据（plans §1.5）：arrivals 是「新增 attention id」；title / stage 从编队行里
// 现查（`attn:` 行，或 job 行上的 attention），查不到就跳过 —— 不编造。
// 阶段色直接复用 ATTENTION_STAGE_META 的 tone（token 已存在，不新造色）。

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { CabinAttentionItem } from '@octopus/shared'
import { ATTENTION_STAGE_META } from '@/components/cabin/cabin-meta'
import { moodPortrait } from '@/components/cabin/cockpit'
import { useCockpitFleet } from '../fleet/CockpitFleetProvider'
import type { CockpitRow } from '../fleet/fleet-model'
import { useCockpitState } from '../state/CockpitStateProvider'

/** 10s 自动收（plans §0.3）。 */
export const BRIEF_MS = 10_000
/** 比聊天浮窗（60）低：Esc 先收交互层，最后才轮到这个只报信的浮层。 */
const BRIEF_LAYER_PRIORITY = 40

export interface CockpitBriefItem {
  title: string
  /** 例：等你验收 / 待回答。 */
  stageLabel: string
  /** 一句说明。 */
  detail: string
  /** CSS 颜色（var(--pop-*)），由阶段 tone 派生。 */
  color: string
  time: string
  demo?: boolean
}

interface BriefView {
  items: CockpitBriefItem[]
  demo: boolean
}

/**
 * 阶段色：从既有 ATTENTION_STAGE_META.tone（如 `border-pop-green/50 text-pop-green`）
 * 里抽出 pop-* token，拼成 var(--pop-*) —— 与列表里的徽章同源，不另起色板。
 */
export function attentionColor(stage: CabinAttentionItem['stage']): string {
  const tone = ATTENTION_STAGE_META[stage]?.tone ?? ''
  const token = /text-(pop-[a-z]+)/.exec(tone)?.[1]
  return token ? `var(--${token})` : 'var(--ck-a)'
}

/** 阶段标签复用既有词表；person 等待时补「等你」，与原型 briefK 一致。 */
export function attentionStageLabel(item: CabinAttentionItem): string {
  const label = ATTENTION_STAGE_META[item.stage]?.label ?? item.stage
  return item.awaiting === 'person' ? `等你${label}` : label
}

export function briefItemOf(item: CabinAttentionItem): CockpitBriefItem {
  return {
    title: item.title,
    stageLabel: attentionStageLabel(item),
    detail: item.question || item.detail || '已进编队 · 不用点',
    color: attentionColor(item.stage),
    time: '刚刚 · 汐音整理',
  }
}

/** 从编队行里找 arrival id 对应的 attention（`attn:` 行 / job 行上挂的 attention）。 */
function findAttention(rows: readonly CockpitRow[], id: string): CabinAttentionItem | null {
  for (const row of rows) {
    if (row.kind === 'attention' && row.item.id === id) return row.item
    if (row.kind === 'job' && row.attention?.id === id) return row.attention
  }
  return null
}

/** arrivals 顺序即到达顺序；同批合并成一张卡，查不到的行跳过。 */
export function collectArrivals(
  arrivals: readonly string[],
  rows: readonly CockpitRow[],
): CockpitBriefItem[] {
  const items: CockpitBriefItem[] = []
  const seen = new Set<string>()
  for (const id of arrivals) {
    if (seen.has(id)) continue
    seen.add(id)
    const attention = findAttention(rows, id)
    if (attention) items.push(briefItemOf(attention))
  }
  return items
}

/** 台词（fx.say 由 S7 气泡 / S1 ticker 消费，S8 不直接依赖它们）。 */
export function arrivalLine(item: CockpitBriefItem): string {
  return `有新回流：${item.title} · ${item.stageLabel}，已进编队。`
}

const DEMO_ITEM: CockpitBriefItem = {
  title: '演示 · 一条新回流',
  stageLabel: '演示到达',
  detail: '这是演示触发器生成的简报，没有写入编队数据。',
  color: 'var(--pop-amber)',
  time: '刚刚 · 演示',
  demo: true,
}

/**
 * 演示触发器门禁：**仅 DEV 且 ?demo=1**。
 * 生产构建里 `import.meta.env.DEV/PROD` 是静态常量，整段条件渲染会被摇掉。
 *
 * 注意：S1 的 CockpitUrlSync 水合后会把不认识的 query 参数清掉（只保留
 * job/task/attn/tab），所以这里在模块加载时先把 ?demo=1 记下来；渲染期再读一次
 * 是为了让测试可以在 render 前改 URL（模块早已加载）。
 */
const DEMO_AT_LOAD =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('demo') === '1'

export function demoArrivalEnabled(): boolean {
  if (import.meta.env.PROD || !import.meta.env.DEV) return false
  if (DEMO_AT_LOAD) return true
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('demo') === '1'
}

export function CockpitBrief() {
  const { rows, arrivals } = useCockpitFleet()
  const { fx, layer } = useCockpitState()
  const [brief, setBrief] = useState<BriefView | null>(null)
  /** 同一批 arrivals 的签名：provider 每 tick 都给新数组，用它挡住重复触发。 */
  const handledRef = useRef('')

  // ── 到达 → 脉冲 + 边缘流光 + 台词 + 简报 ────────────────────────────
  useEffect(() => {
    if (arrivals.length === 0) {
      // 空 tick 重置签名：同一条 attention 被移除后再次到达时还能再报一次。
      handledRef.current = ''
      return
    }
    const signature = arrivals.join('|')
    if (signature === handledRef.current) return
    handledRef.current = signature

    const items = collectArrivals(arrivals, rows)
    if (items.length === 0) return

    const first = items[0]
    fx.pulse(first.color)
    fx.edge(first.color)
    fx.say(arrivalLine(first), 'alert')
    setBrief({ items, demo: false })
  }, [arrivals, rows, fx])

  // ── 10s 自动收（新简报会重置计时）────────────────────────────────────
  useEffect(() => {
    if (!brief) return
    const timer = window.setTimeout(() => setBrief(null), BRIEF_MS)
    return () => window.clearTimeout(timer)
  }, [brief])

  // ── Esc：注册进唯一的 layer 栈，可提前收 ─────────────────────────────
  const closeBrief = useCallback(() => setBrief(null), [])
  useEffect(() => {
    if (!brief) return
    return layer.register('brief', BRIEF_LAYER_PRIORITY, closeBrief)
  }, [brief, layer, closeBrief])

  // ── 演示触发器（不伪造编队数据，只走 fx + 一张标注「演示」的简报）─────
  const runDemo = useCallback(() => {
    fx.pulse(DEMO_ITEM.color)
    fx.edge(DEMO_ITEM.color)
    fx.say('演示到达：一条新回流已进编队。', 'alert')
    setBrief({ items: [DEMO_ITEM], demo: true })
  }, [fx])

  const extra = brief ? brief.items.length - 1 : 0
  const first = brief?.items[0]

  return (
    <>
      {demoArrivalEnabled() && (
        <button
          type="button"
          className="ck12-demo"
          data-testid="cockpit-demo-arrival"
          title="演示到达（仅 dev + ?demo=1）"
          aria-label="演示到达"
          onClick={runDemo}
        >
          ⌁
        </button>
      )}

      {brief && first && (
        <aside
          className="ck12-brief"
          style={{ '--ck12-brief-tone': first.color } as CSSProperties}
          role="status"
          aria-live="polite"
          data-testid="cockpit-brief"
          data-demo={brief.demo ? '1' : undefined}
        >
          <div className="ck12-brief-h">
            <span className="ck12-brief-av" aria-hidden="true">
              <img src={moodPortrait(brief.demo ? 'wink' : 'alert')} alt="" />
            </span>
            <span className="ck12-brief-id">
              <b>汐音 · 简报</b>
              <span className="ck12-brief-kicker">
                <i className="ck12-brief-dot" aria-hidden="true" />
                {first.stageLabel}
              </span>
            </span>
            {brief.demo && <span className="ck12-brief-demo">演示</span>}
          </div>

          <div className="ck12-brief-tx">
            <b>{first.title}</b>
            {extra > 0 && <span className="ck12-brief-more"> +{extra}</span>}
            <br />
            {first.detail}
          </div>

          <div className="ck12-brief-f">
            <span className="ck12-brief-time">{first.time}</span>
            <span className="ck12-brief-hint">已进编队 · 不用点</span>
          </div>
        </aside>
      )}
    </>
  )
}
