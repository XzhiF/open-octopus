'use client'

// v22 十四轮 · 右栏「活动」二级大窗。
//
// 几何按原型：右侧与一级浮层左缘**齐平**（无缝），从右缘向左展开 420ms；
// 一级列表宽度固定，不被这扇窗拖着变宽。窗里按活动类型分流：
//   · 子代理 → 直接复用作业坞「子代理」详情窗（SubagentWindow）：
//     主 Agent 的指令 / 操作日志（thinking + 工具，可展开）/ 最终汇报 / token / 费用。
//     组件内部每 2s 拉详情，运行中实时跟随。
//   · 后台作业 → CockpitBackgroundDetail（启动命令 / 端口 / 日志尾 / 停止作业）。
//     2026-11-24 用户 #1：运行中可读 SDK 实时输出尾，结束后读 output_file 留档。

import { useMemo } from 'react'
import { useCockpitState } from '../state/CockpitStateProvider'
import { CockpitFaceHead } from '../face/CockpitFaceHead'
import { SubagentWindow } from '@/components/chat-workbench/subagent-window'
import { isSubagentLive, subagentTitle } from '@/lib/subagent-format'
import { useCockpitActivityFeed } from './activity-feed'
import { activityItems, activityIsLive } from './activity-model'
import { CockpitBackgroundDetail } from './CockpitBackgroundDetail'

export function CockpitActivityWindow() {
  const { activitySel, selectActivity } = useCockpitState()
  const feed = useCockpitActivityFeed()

  const items = useMemo(
    () => activityItems(feed.runs, feed.backgrounds, feed.backgroundRuns),
    [feed.runs, feed.backgrounds, feed.backgroundRuns],
  )
  const item = activitySel ? items.find((entry) => entry.id === activitySel) ?? null : null
  if (!item) return null

  const isSubagent = item.kind === 'subagent'
  const live = isSubagent ? isSubagentLive(item.run) : activityIsLive(item)
  const title = isSubagent ? subagentTitle(item.run) : item.task.description
  const sub = isSubagent
    ? `子代理 · ${live ? '运行中' : '已结束'} · 只读`
    : `后台作业 · ${live ? '运行中' : '已结束'} · 只读`

  return (
    <section
      className="ck12-treewin ck12-actwin"
      data-testid="cockpit-activity-window"
      data-kind={item.kind}
      aria-label="活动详情"
    >
      <CockpitFaceHead
        testId="cockpit-activity-window-head"
        closeTestId="cockpit-activity-window-close"
        glyph={isSubagent ? '◈' : '⌁'}
        title={`活动详情 · ${title}`}
        sub={sub}
        onClose={() => selectActivity(null)}
        closeLabel="关闭活动详情"
      />

      {isSubagent ? (
        <div className="ck12-actwin-b">
          <SubagentWindow
            key={item.run.id}
            sessionId={feed.sessionId}
            agentId={item.run.id}
          />
        </div>
      ) : (
        <div className="ck12-actwin-b">
          <CockpitBackgroundDetail sessionId={feed.sessionId} item={item} />
        </div>
      )}
    </section>
  )
}
