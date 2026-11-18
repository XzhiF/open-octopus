// 「等你在场」提醒话术（2026-11-19）：台词必须来自真实 inbox（标题 / 分组），
// 不能是空泛的「你有待办」；只有一条时不假装有清单。

import { describe, it, expect } from 'vitest'
import type { CabinAttentionItem } from '@octopus/shared'
import type { InboxEntry } from '../../rail/inbox-model'
import { buildWaitNudges } from '../wait-nudges'

function item(id: string, over: Partial<CabinAttentionItem> = {}): CabinAttentionItem {
  return {
    id,
    job_id: null,
    stage: 'answer',
    awaiting: 'person',
    title: `事项 ${id}`,
    task_id: null,
    repo: null,
    wt: null,
    deep_link: null,
    ...over,
  }
}

function entry(id: string, over: Partial<CabinAttentionItem> = {}): InboxEntry {
  return {
    item: item(id, over),
    cabinId: 'c1',
    ref: { kind: 'attention', cabinId: 'c1', id },
    rowKey: `attn:${id}`,
  }
}

describe('buildWaitNudges', () => {
  it('没有待办 → 不说话', () => {
    expect(buildWaitNudges([])).toEqual([])
  })

  it('单条：直接点名标题 + 该做什么', () => {
    const lines = buildWaitNudges([entry('a1', { stage: 'review', title: 'M2 · 结算对账' })])
    expect(lines[0]?.text).toContain('M2 · 结算对账')
    expect(lines[0]?.text).toContain('验收')
    expect(lines[0]?.text).toContain('指挥官')
  })

  it('多条：总数 + 前两条标题 + 打开右栏的指路', () => {
    const lines = buildWaitNudges([
      entry('a1', { stage: 'answer', title: '限流阈值定多少' }),
      entry('a2', { stage: 'review', title: 'M2 · 结算对账' }),
    ])
    expect(lines[0]?.text).toContain('2 件事')
    expect(lines[0]?.text).toContain('限流阈值定多少')
    expect(lines[0]?.text).toContain('M2 · 结算对账')
    expect(lines[0]?.text).toContain('✉')
  })

  it('分组提醒各点一条：待验收 / 待拍板 / 受阻，标题逐条来自真实行', () => {
    const lines = buildWaitNudges([
      entry('a1', { stage: 'review', title: '验收产物' }),
      entry('a2', { stage: 'answer', title: '要定的事' }),
      entry('a3', { stage: 'blocked', title: '被卡住的作业' }),
    ]).map((line) => line.text)

    expect(lines.some((text) => text.includes('待验收') && text.includes('验收产物'))).toBe(true)
    expect(lines.some((text) => text.includes('要你拍板') && text.includes('要定的事'))).toBe(true)
    expect(lines.some((text) => text.includes('被卡住的作业'))).toBe(true)
    expect(lines.some((text) => text.startsWith('清单 ·'))).toBe(true)
  })

  it('超长标题压成一行（气泡只有两行宽）', () => {
    const long = '很长的验收标题'.repeat(12)
    const lines = buildWaitNudges([entry('a1', { stage: 'review', title: long })])
    expect(lines[0]?.text).toContain('…')
    expect((lines[0]?.text.length ?? 0)).toBeLessThan(120)
  })

  it('标题缺失时退到 question / 「待办」，不输出空引号', () => {
    const lines = buildWaitNudges([
      entry('a1', { stage: 'answer', title: '', question: '这轮能过吗？' }),
    ])
    expect(lines[0]?.text).toContain('这轮能过吗？')
  })
})
