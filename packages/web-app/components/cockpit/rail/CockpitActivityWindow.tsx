'use client'

// v22 十四轮 · 右栏「活动」二级大窗。
//
// 几何按原型：右侧与一级浮层左缘**齐平**（无缝），从右缘向左展开 420ms；
// 一级列表宽度固定，不被这扇窗拖着变宽。窗里按活动类型分流：
//   · 子代理 → 直接复用作业坞「子代理」详情窗（SubagentWindow）：
//     主 Agent 的指令 / 操作日志（thinking + 工具，可展开）/ 最终汇报 / token / 费用。
//     组件内部每 2s 拉详情，运行中实时跟随。
//   · 后台作业 → 启动命令 + 运行状态。服务端只保留 background_tasks 电平
//     （结束即出队，不存输出），这里不伪造日志。

import { useMemo } from 'react'
import { useCockpitState } from '../state/CockpitStateProvider'
import { CockpitFaceHead } from '../face/CockpitFaceHead'
import { SubagentWindow } from '@/components/chat-workbench/subagent-window'
import { isSubagentLive, subagentTitle } from '@/lib/subagent-format'
import { useCockpitActivityFeed } from './activity-feed'
import { activityItems } from './activity-model'

export function CockpitActivityWindow() {
  const { activitySel, selectActivity } = useCockpitState()
  const feed = useCockpitActivityFeed()

  const items = useMemo(
    () => activityItems(feed.runs, feed.backgrounds),
    [feed.runs, feed.backgrounds],
  )
  const item = activitySel ? items.find((entry) => entry.id === activitySel) ?? null : null
  if (!item) return null

  const isSubagent = item.kind === 'subagent'
  const live = isSubagent ? isSubagentLive(item.run) : true
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
        <BackgroundDetail
          taskId={item.task.id}
          description={item.task.description}
          taskType={item.task.taskType}
        />
      )}
    </section>
  )
}

function BackgroundDetail({
  taskId,
  description,
  taskType,
}: {
  taskId: string
  description: string
  taskType?: string
}) {
  return (
    <div className="ck12-actwin-b">
      <div className="ck12-act-meta">
        <span className="ck12-act-chip is-run">● 运行中</span>
        <span className="ck12-act-chip">{taskType ?? 'bash'}</span>
        <span className="ck12-act-chip">run_in_background</span>
        <span className="ck12-act-chip ck12-act-chip-id" title={taskId}>id {taskId}</span>
        <span className="ck12-act-sp" />
      </div>

      <div className="ck12-act-body">
        <div className="ck12-act-prompt">
          <div className="k">⌁ 启动命令</div>
          <pre>{description}</pre>
        </div>
        <div className="ck12-act-note">
          后台作业只保留运行中的电平（结束即出队）；服务端不存终端输出，运行输出请回主对话对应回合查看。
        </div>
      </div>

      <div className="ck12-act-tfoot">
        <span className="ck12-act-chip">run_in_background</span>
        <span className="ck12-act-sp" />
        <span>后台电平实时 · 只读</span>
      </div>
    </div>
  )
}
