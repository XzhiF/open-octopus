// 右栏「活动」纯模型：裁剪 / 分组 / 列表文案。
import { describe, it, expect } from 'vitest'
import type { BackgroundTaskInfo, SubagentRunSummary } from '@/lib/agent/api'
import {
  activityItems,
  activityMeta,
  activityRightLabel,
  activityTitle,
  groupActivity,
  trimSubagentRuns,
} from '../activity-model'

function run(over: Partial<SubagentRunSummary> = {}): SubagentRunSummary {
  return {
    id: 'sa-1',
    session_id: 'sess-main',
    parent_tool_use_id: null,
    agent_type: 'Explore',
    description: '对账差异定位',
    prompt: '定位差异',
    status: 'running',
    started_at: '2026-11-21T09:38:00.000Z',
    ended_at: null,
    summary: null,
    model: 'qwen3.7-plus',
    input_tokens: 12_400,
    output_tokens: 14_800,
    cache_read_tokens: 9_600,
    cache_creation_tokens: 0,
    tool_uses: 4,
    duration_ms: null,
    step_count: 18,
    cost_usd: 0.06,
    cost_complete: 1,
    ...over,
  }
}

const BG: BackgroundTaskInfo = {
  id: 'bg-1',
  description: 'pnpm vitest run src/settlement',
  taskType: 'local_bash',
}

describe('activity-model · 子代理裁剪', () => {
  it('运行中全留（先起的在前），已结束最近 12 条、按结束时间倒序', () => {
    const liveA = run({ id: 'live-a', started_at: '2026-11-21T09:00:00.000Z' })
    const liveB = run({ id: 'live-b', started_at: '2026-11-21T09:10:00.000Z' })
    const done = Array.from({ length: 15 }, (_, index) => run({
      id: `done-${index}`,
      status: 'completed',
      ended_at: `2026-11-21T08:${String(index).padStart(2, '0')}:00.000Z`,
    }))
    const trimmed = trimSubagentRuns([...done, liveB, liveA])
    expect(trimmed.slice(0, 2).map((item) => item.id)).toEqual(['live-a', 'live-b'])
    expect(trimmed).toHaveLength(14)
    expect(trimmed[2].id).toBe('done-14')
  })
})

describe('activity-model · 分组 / 文案', () => {
  it('liveCount = 运行中子代理 + 后台作业；已结束的子代理不算', () => {
    const items = activityItems(
      [run(), run({ id: 'sa-done', status: 'completed', ended_at: '2026-11-21T09:40:00.000Z' })],
      [BG],
    )
    const groups = groupActivity(items)
    expect(groups.subLive).toBe(1)
    expect(groups.subTotal).toBe(2)
    expect(groups.bgLive).toBe(1)
    expect(groups.liveCount).toBe(2)
  })

  it('标题 / 元信息 / 右列读数', () => {
    const [sub, bg] = activityItems([run()], [BG])
    expect(activityTitle(sub)).toBe('对账差异定位')
    expect(activityMeta(sub)).toContain('Explore')
    expect(activityMeta(sub)).toContain('18 步')
    expect(activityMeta(sub)).toContain('36.8K tok')
    // started_at 2026-11-21T09:38Z；now 偏 2m12s
    expect(activityRightLabel(sub, Date.parse('2026-11-21T09:40:12.000Z'))).toContain('2m 12s')

    expect(activityTitle(bg)).toBe(BG.description)
    expect(activityMeta(bg)).toBe('local_bash · run_in_background')
    expect(activityRightLabel(bg, Date.now())).toBe('运行中')
  })

  it('已结束子代理右列显示终态，不再走计时', () => {
    const [done] = activityItems(
      [run({ status: 'failed', ended_at: '2026-11-21T09:40:00.000Z' })],
      [],
    )
    expect(activityRightLabel(done, Date.now())).toBe('失败')
  })
})
