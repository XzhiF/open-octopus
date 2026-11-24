'use client'

// 活动日志大窗（2026-11-24 用户 #1）· 右栏「更多 → ▤ 活动日志」打开。
//
// 与右栏「活动」浮层的关系：浮层是「手边正在跑的」，这扇窗是「全部」——
// 运行中置顶 + 已结束留档（后台作业走 background_runs，子代理走 subagent_runs）。
// 左侧列表（类型筛选 + 搜索），右侧详情复用两套既有渲染：
//   · 子代理 → 作业坞 SubagentWindow；
//   · 后台作业 → CockpitBackgroundDetail（命令 / 端口 / 日志尾 / 停止作业）。
// 只读为主；唯一的写操作是「停止作业」（二次确认，只停那一个）。

import { useEffect, useMemo, useState } from 'react'
import { useCockpitState } from '../state/CockpitStateProvider'
import { CockpitFaceHead } from '../face/CockpitFaceHead'
import { SubagentWindow } from '@/components/chat-workbench/subagent-window'
import {
  activityIsLive,
  activityItems,
  activityMeta,
  activityRightLabel,
  activityTitle,
  type ActivityItem,
} from './activity-model'
import { useCockpitActivityFeed } from './activity-feed'
import { CockpitBackgroundDetail } from './CockpitBackgroundDetail'
import { setActivityLogOpen, useActivityLogOpen } from './activity-log-store'

const ACTIVITY_LOG_LAYER_ID = 'cockpit-activity-log'
/** 与目录 / 变更窗同层：互不依赖，后开的在上面由 DOM 顺序决定。 */
const ACTIVITY_LOG_LAYER_PRIORITY = 67

type LogFilter = 'all' | 'background' | 'subagent'

function kindLabel(item: ActivityItem): string {
  return item.kind === 'subagent' ? '◈ 子代理' : '⌁ 后台'
}

export function CockpitActivityLogWindow() {
  const open = useActivityLogOpen()
  const { layer } = useCockpitState()
  const feed = useCockpitActivityFeed()
  const [filter, setFilter] = useState<LogFilter>('all')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // Esc：关窗（层栈 67）。关掉后注销，不占位。
  useEffect(() => {
    if (!open) return
    return layer.register(ACTIVITY_LOG_LAYER_ID, ACTIVITY_LOG_LAYER_PRIORITY, () => {
      setActivityLogOpen(false)
    })
  }, [open, layer])

  // 运行中计时每秒走；没有运行中活动就停（避免空转重渲染）。
  const hasTimer = useMemo(
    () => feed.runs.some((run) => run.status === 'running') || feed.backgrounds.length > 0,
    [feed.runs, feed.backgrounds],
  )
  useEffect(() => {
    if (!open || !hasTimer) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open, hasTimer])

  const items = useMemo(
    () => activityItems(feed.runs, feed.backgrounds, feed.backgroundRuns),
    [feed.runs, feed.backgrounds, feed.backgroundRuns],
  )

  const counts = useMemo(() => {
    let background = 0
    let subagent = 0
    let live = 0
    for (const item of items) {
      if (item.kind === 'subagent') subagent += 1
      else background += 1
      if (activityIsLive(item)) live += 1
    }
    return { all: items.length, background, subagent, live }
  }, [items])

  // 运行中置顶（稳定排序保留「子代理 → 后台」的原顺序）。
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return items
      .filter((item) => {
        if (filter === 'background' && item.kind !== 'background') return false
        if (filter === 'subagent' && item.kind !== 'subagent') return false
        if (!needle) return true
        const hay = [
          activityTitle(item),
          activityMeta(item),
          item.kind === 'background' ? item.task.id : item.run.id,
          item.kind === 'background' ? item.record?.summary ?? '' : item.run.summary ?? '',
        ].join(' ').toLowerCase()
        return hay.includes(needle)
      })
      .sort((a, b) => Number(activityIsLive(b)) - Number(activityIsLive(a)))
  }, [items, filter, q])

  // 选中的那条被筛掉 / 消失 → 退回第一条。
  const current = useMemo(
    () => filtered.find((item) => item.id === sel) ?? filtered[0] ?? null,
    [filtered, sel],
  )

  if (!open) return null

  const selected = current

  return (
    <section
      className="ck12-treewin ck12-actlogwin"
      data-testid="cockpit-activity-log"
      aria-label="活动日志"
    >
      <CockpitFaceHead
        testId="cockpit-activity-log-head"
        closeTestId="cockpit-activity-log-close"
        glyph="▤"
        title="活动日志"
        sub={`运行中 ${counts.live} · 留档 ${counts.all} 条 · 只读`}
        onClose={() => setActivityLogOpen(false)}
        closeLabel="关闭活动日志"
      />

      <div className="ck12-al-tools">
        <div className="seg" role="tablist" aria-label="活动类型筛选">
          {([
            ['all', `全部 ${counts.all}`],
            ['background', `后台作业 ${counts.background}`],
            ['subagent', `子代理 ${counts.subagent}`],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={filter === key ? 'is-on' : undefined}
              data-testid={`cockpit-actlog-filter-${key}`}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="搜索 命令 / 描述 / id / 摘要"
          aria-label="搜索活动"
          data-testid="cockpit-actlog-search"
        />
        <span className="hint">运行中置顶 · 已结束留档</span>
      </div>

      <div className="ck12-al-body">
        <div className="ck12-al-list" data-testid="cockpit-actlog-list">
          {filtered.length === 0 ? (
            <div className="ck12-al-empty">
              <b>◌</b>
              {items.length === 0 ? '这个会话还没有后台活动' : '没有匹配的活动'}
            </div>
          ) : (
            filtered.map((item) => {
              const live = activityIsLive(item)
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`ck12-al-row${current?.id === item.id ? ' is-on' : ''}`}
                  data-testid={`cockpit-actlog-row-${item.kind}-${item.kind === 'background' ? item.task.id : item.run.id}`}
                  onClick={() => setSel(item.id)}
                >
                  <span className="r1">
                    <span className={`tone ${item.kind === 'background' ? 'is-bg' : 'is-sub'}`}>
                      {kindLabel(item)}
                    </span>
                    <span className="name">{activityTitle(item)}</span>
                    <span className={`go${live ? ' is-live' : ''}`}>
                      {activityRightLabel(item, now)}
                    </span>
                  </span>
                  <span className="r2">{activityMeta(item, now)}</span>
                </button>
              )
            })
          )}
        </div>

        <div className="ck12-al-detail" data-testid="cockpit-actlog-detail">
          {!selected ? (
            <div className="ck12-al-empty">
              <b>▤</b>选择左边一条查看详情
            </div>
          ) : (
            <div className="ck12-al-detail-fill">
              {selected.kind === 'subagent' ? (
                <SubagentWindow
                  key={selected.run.id}
                  sessionId={feed.sessionId}
                  agentId={selected.run.id}
                />
              ) : (
                <CockpitBackgroundDetail sessionId={feed.sessionId} item={selected} />
              )}
            </div>
          )}
        </div>
      </div>

      <div className="ck12-al-foot">
        <span>后台作业 · 命令 / 端口 / 日志尾 / 停止 · 子代理 · 指令 / 工具 / token</span>
        <span className="sp" />
        <span>Esc 关窗</span>
      </div>
    </section>
  )
}
