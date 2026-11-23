'use client'

// v21 二轮（原型 cockpit-v21.html · HUD）—— 54px 抬头条：
//
//   [← 经典模式] │ 舱籍 chip(32) │ SCENE pill(居中) │ ▤ tok │ ¥ 消耗 │ ✎ 便签
//
// 纪律：
//   · 读数全部来自真源（chat 遥测 / getCabinUsage / 舱籍）；拿不到就写「未就绪」，
//     绝不把缺失值写成 0。
//   · 右上不再有模型切换与 ♪ ◐ ✦：模型 / 上下文 / 会话 token 明细都在通讯台头部
//     （MODEL / CTX / TOKEN 下拉），消耗完整账在右栏「消耗」；设置从「更多 → 设置」进。
//   · 2026-11-23 用户 #2：上下文百分比读数删除（常被 compact，常温显示价值不大）；
//     上下文明细仍在通讯台头部 CTX 芯片。两枚读数只读：不可点、无所指弹层。
//   · 2026-11-23 用户 #3：最右新增「✎ 便签」—— classic 快速便签的入口（带条数徽标）。
//   · v21 四轮：删掉原型左上的指挥官徽（16 / 指挥官 / CMDR·ID —— 偏高且无信息量，
//     与右侧 32px chip 不齐）；导航只留一枚同高的「经典模式」返回钮。
//   · v22 #7（2026-11-23 用户）：返回钮右边加「⚛ 知识中心」—— classic 的
//     knowledge 搬进全舱（点开是舱内知识窗，不换页、不丢作战现场）。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useBillingCurrency } from '@/lib/billing-currency'
import { formatCost, formatTokenCount } from '@/lib/format'
import { useCockpitEntry } from '../entry/use-cockpit-entry'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCabinOptional } from '@/components/cabin/cabin-provider'
import { CockpitProjectsPopover } from '../projects/CockpitProjectsPopover'
import { CockpitRepoBinder } from '../projects/CockpitRepoBinder'
import { HudClock } from './HudClock'
import { useCabinProjects } from '../projects/use-cabin-projects'
import { openCockpitKnowledge } from '../face/CockpitKnowledgeWindow'
import { useCabinUsage } from '../bridge/use-cabin-usage'
import { SCENES } from '../scene/scene-model'
import { cabinAudio } from '@/lib/cabin-audio'
import { toggleCockpitNotes, useCockpitNotesOpen, useQuickNoteCount } from './notes-store'

/** 金额读数拆成「符号进六角、数字进 b」——原型 ¥ 徽 + 1.28。 */
function splitCost(label: string): { unit: string; value: string } {
  const match = label.match(/^(≈)?([¥$])(.+)$/)
  if (!match) return { unit: '¥', value: label }
  return { unit: `${match[1] ?? ''}${match[2]}`, value: match[3] }
}

export function CockpitHud() {
  const { entryCabinId, chat, sceneIndex, travel } = useCockpitState()
  const { exitCockpit } = useCockpitEntry()
  const cabinCtx = useCabinOptional()
  const cabinName = cabinCtx?.cabin?.name ?? '作战舱'
  const { usage, stale } = useCabinUsage(entryCabinId)
  const currency = useBillingCurrency()
  const notesOpen = useCockpitNotesOpen()
  const noteCount = useQuickNoteCount()

  const {
    projects, loading: projectsLoading, error: projectsError, refetch: refetchProjects,
  } = useCabinProjects(entryCabinId)
  const [bindOpen, setBindOpen] = useState(false)
  const closeBinder = useCallback(() => setBindOpen(false), [])

  // 2026-11-19 用户 #5：绑定新项目可能是在对话里让汐音做的 —— 本轮结束时补拉舱籍，
  // 左上角「N 项目」chip / 浮层不用整页刷新就能变。
  const streaming = chat?.streaming ?? false
  const wasStreaming = useRef(false)
  useEffect(() => {
    if (wasStreaming.current && !streaming) refetchProjects()
    wasStreaming.current = streaming
  }, [streaming, refetchProjects])

  // ── 读数（真源，缺值 → 未就绪）────────────────────────────────────────
  const tokenTotal = chat?.usage?.totals.tokens ?? null
  const tokenLabel = tokenTotal == null ? '未就绪' : formatTokenCount(tokenTotal)

  const costUsd = usage?.grand.totals.cost.usd ?? null
  const costComplete = usage?.grand.totals.cost.complete ?? true
  const cost = splitCost(costUsd == null ? '—' : formatCost(costUsd, costComplete, currency))
  const costTitle = stale
    ? '本舱累计消耗 · 上次读取失败，显示上次成功值'
    : '本舱累计消耗 · 只读（完整账在右栏 消耗）'

  const scene = SCENES[sceneIndex] ?? SCENES[0]

  return (
    <header className="ck12-hud" data-testid="cockpit-hud">
      {/* 唯一保留的导航入口：回 classic 舱页。高度与舱籍 chip 同为 32px，
          左组（经典 / 舱籍）与右组（SCENE / 三读数）在同一条中线上。 */}
      <button
        type="button"
        className="ck12-hud-classic"
        onClick={() => exitCockpit(entryCabinId)}
        title="返回 classic 模式（作战舱）"
        aria-label="返回 classic 模式（作战舱）"
        data-testid="cockpit-back"
      >
        <span className="ck12-hud-classic-i" aria-hidden="true">←</span>
        <b>经典模式</b>
      </button>

      {/* v22 #7：知识中心（classic Octopus 菜单里的那一项，换皮搬到全舱）。
          与返回钮同高同壳；点开是舱内窗口，作战现场不中断。 */}
      <button
        type="button"
        className="ck12-hud-classic ck12-hud-kc"
        onClick={() => openCockpitKnowledge()}
        title="知识中心 · 星空知识库（全局 wiki · 只读）"
        aria-label="打开知识中心"
        data-testid="cockpit-knowledge"
      >
        <span className="ck12-hud-classic-i" aria-hidden="true">⚛</span>
        <b>知识中心</b>
      </button>

      <CockpitProjectsPopover
        cabinId={entryCabinId}
        cabinName={cabinName}
        projects={projects}
        loading={projectsLoading}
        error={projectsError}
        onRefetch={refetchProjects}
        onBind={() => setBindOpen(true)}
      />

      <div className="ck12-sceneread" role="group" aria-label="舱景与当前时间">
        <span className="ck12-sr-k" aria-hidden="true">SCENE</span>
        <button
          type="button"
          className="ck12-sr-scene"
          onClick={() => travel()}
          title={`当前 ${scene.name} · 点击跃迁到下一幕`}
          data-testid="cockpit-scene-pill"
        >
          <span className="ck12-sr-dot" aria-hidden="true" />
          <b>{scene.name}</b>
        </button>
        <span className="ck12-sr-sep" aria-hidden="true" />
        <HudClock />
      </div>

      {/* pill 是绝对定位（与底部通讯停靠 pill 同一条视口中轴），
          用弹性占位把右侧三读数钉回右缘。 */}
      <span className="ck12-hud-sp" aria-hidden="true" />

      <span
        className="ck12-hudcur is-tok"
        title={tokenTotal == null ? '本会话 token · 未就绪（明细在通讯台头部 TOKEN）' : `本会话 ${tokenTotal.toLocaleString()} tokens · 只读（明细在通讯台头部 TOKEN）`}
        data-testid="ck12-rig-tokens"
      >
        <span className="ck12-hudcur-i" aria-hidden="true">▤</span>
        <b>{tokenLabel}</b>
      </span>

      <span className="ck12-hudcur is-cost" title={costTitle} data-testid="ck12-rig-cost">
        <span className="ck12-hudcur-i" aria-hidden="true">{cost.unit}</span>
        <b>{cost.value}</b>
      </span>

      <button
        type="button"
        className={`ck12-hudcur is-notes${notesOpen ? ' on' : ''}`}
        aria-expanded={notesOpen}
        aria-haspopup="dialog"
        title="便签 · 快速记事（本地自动保存）"
        data-testid="cockpit-notes-btn"
        onClick={() => {
          toggleCockpitNotes()
          cabinAudio.blip(660, 0.04)
        }}
      >
        <span className="ck12-hudcur-i" aria-hidden="true">✎</span>
        <b>便签</b>
        {noteCount > 0 && (
          <i className="ck12-nbadge" data-testid="cockpit-notes-badge">
            {noteCount > 99 ? '99+' : noteCount}
          </i>
        )}
      </button>

      <CockpitRepoBinder
        open={bindOpen}
        cabinId={entryCabinId}
        cabinPath={entryCabinId === cabinCtx?.cabin?.id ? cabinCtx?.cabin?.path ?? null : null}
        projects={projects}
        onClose={closeBinder}
        onSaved={() => { refetchProjects() }}
      />
    </header>
  )
}
