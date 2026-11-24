'use client'

// v22 十四轮（2026-11-21 用户）· 右栏「活动」一级浮层：
// 与「要我处理」同一套 inbox 姿势 —— 贴着右栏向左浮出，纵向对齐「活动」按钮。
//
// 列表只列**正在跑**的子代理 / 后台作业（2026-11-24 用户 #2：已结束的一律不进
// 浮层，历史去「更多 → ▤ 活动日志」）。
// 入口是**常住按钮**：没有活动时也点得开，列表给空态；运行中活动全部结束时
// 浮层不自动收（与「变更」的条件出现不同，2026-11-21 用户）。
// 点一条 → 列表左边缘无缝接出大详情窗（CockpitActivityWindow），一级宽度固定
// 378 不变；Esc 先收详情、再收浮层。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCockpitActivityFeed } from './activity-feed'
import {
  activityItems,
  activityIsLive,
  activityMeta,
  activityRawId,
  activityRightLabel,
  activityTitle,
  groupActivity,
  type ActivityItem,
} from './activity-model'

/** 与 inbox 同层：两者互斥，谁开着就只收谁。 */
const ACTIVITY_LAYER_PRIORITY = 120

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

function ActivityRow({
  item,
  active,
  now,
  onPick,
}: {
  item: ActivityItem
  active: boolean
  now: number
  onPick: () => void
}) {
  const live = activityIsLive(item)
  const kindLabel = item.kind === 'subagent' ? '◈ 子代理' : '⌁ 后台'
  return (
    <button
      type="button"
      className={`ck12-ip-row${active ? ' is-on' : ''}`}
      data-testid={`cockpit-activity-row-${item.kind}-${activityRawId(item)}`}
      data-kind={item.kind}
      title={`${activityTitle(item)} · ${live ? '运行中' : '已结束'}`}
      onClick={onPick}
    >
      <span className="ck12-ip-r1">
        <span className={`ck12-ip-type${item.kind === 'subagent' ? ' is-sub' : ' is-bg'}`}>
          {kindLabel}
        </span>
        <span className="ck12-ip-name">{activityTitle(item)}</span>
        <span className={`ck12-ip-go${live ? ' is-live' : ''}`}>
          {activityRightLabel(item, now)}
        </span>
      </span>
      <span className="ck12-ip-q">{activityMeta(item, now)}</span>
    </button>
  )
}

export function CockpitActivityPopover() {
  const { activitySel, selectActivity, closeActivity, layer } = useCockpitState()
  const feed = useCockpitActivityFeed()
  const popRef = useRef<HTMLDivElement | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [top, setTop] = useState<number | null>(null)

  // 只留运行中：已结束的子代理 / 后台作业留档归「更多 → 活动日志」。
  const items = useMemo(
    () => activityItems(feed.runs, feed.backgrounds, feed.backgroundRuns).filter(activityIsLive),
    [feed.runs, feed.backgrounds, feed.backgroundRuns],
  )
  const groups = useMemo(() => groupActivity(items), [items])

  // 计时只在有 live 子代理时每秒走。
  const hasLiveTimer = groups.subLive > 0
  useEffect(() => {
    if (!hasLiveTimer) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasLiveTimer])

  // 选中的那条被裁掉 / 已从电平里消失 → 回列表。
  useEffect(() => {
    if (activitySel && !items.some((item) => item.id === activitySel)) selectActivity(null)
  }, [items, activitySel, selectActivity])

  // Esc：先收详情，再收浮层（与原型同序）。
  useEffect(
    () => layer.register('cockpit-activity', ACTIVITY_LAYER_PRIORITY, () => {
      if (activitySel) selectActivity(null)
      else closeActivity()
    }),
    [layer, activitySel, selectActivity, closeActivity],
  )

  // 纵向对齐右栏「活动」按钮（原型 positionActPop）：量按钮中心，clamp 在视口内。
  useLayoutEffect(() => {
    const measure = () => {
      const button = document.querySelector<HTMLElement>('[data-testid="cockpit-menu-activity"]')
      const pop = popRef.current
      if (!button || !pop) return
      const rect = button.getBoundingClientRect()
      const height = pop.offsetHeight
      const centered = rect.top + rect.height / 2 - height / 2
      setTop(Math.round(clamp(
        centered,
        52,
        Math.max(52, window.innerHeight - height - 8),
      )))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [activitySel, groups.liveCount])

  const noActivity = groups.liveCount === 0

  return (
    <div
      ref={popRef}
      className={`ck12-inboxpop ck12-actpop${activitySel ? ' is-detail' : ''}`}
      style={top != null ? { top } : undefined}
      data-testid="cockpit-activity-popover"
      role="dialog"
      aria-label="活动"
    >
      <div className="ck12-ip-listwrap">
        <div className="ck12-ip-h">
          <button
            type="button"
            className="ck12-ipx"
            aria-label="收起活动"
            title="收起（Esc）"
            onClick={closeActivity}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
          <span className="ck12-ip-t">活动</span>
          <b className="ck12-ip-total">{groups.liveCount}</b>
          <span className="ck12-ip-brk">
            子代理 {groups.subLive} · 后台 {groups.bgLive}
          </span>
        </div>

        <div className="ck12-ip-body">
          {noActivity ? (
            <div className="ck12-ip-empty">
              <b>✓</b>当前没有运行中的后台作业
              <small>历史去 更多 → ▤ 活动日志</small>
            </div>
          ) : (
            <>
              {groups.subLive > 0 && (
                <>
                  <div className="ck12-ip-group" data-group="sub">
                    <span>子代理</span>
                    <b>{groups.subLive}</b>
                  </div>
                  {groups.subagents.map((item) => (
                    <ActivityRow
                      key={item.id}
                      item={item}
                      active={activitySel === item.id}
                      now={now}
                      onPick={() => selectActivity(item.id)}
                    />
                  ))}
                </>
              )}

              {groups.bgLive > 0 && (
                <>
                  <div className="ck12-ip-group" data-group="bg">
                    <span>后台作业</span>
                    <b>{groups.bgLive}</b>
                  </div>
                  {groups.backgrounds.map((item) => (
                    <ActivityRow
                      key={item.id}
                      item={item}
                      active={activitySel === item.id}
                      now={now}
                      onPick={() => selectActivity(item.id)}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </div>

        <div className="ck12-ip-foot">
          <span>只显示运行中 · 历史在 活动日志</span>
          <span className="ck12-ip-sp" />
          {feed.error && (
            <span className="ck12-act-err" title={feed.error}>⚠ 活动刷新失败 · 沿上一帧</span>
          )}
          <span>Esc 收起</span>
        </div>
      </div>
    </div>
  )
}
