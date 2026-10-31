import { describe, expect, it } from 'vitest'
import type { StepExecution } from '@/lib/types'
import { totalElapsedMs } from '../run-window'

const step = (completedAt: string) => ({ stepId: 's', stepName: 's', status: 'completed', completedAt }) as StepExecution
const T = (iso: string) => Date.parse(iso)

// 用户的两条硬要求：① 一秒一秒增加 ② 不会因为窗口重开而重置。
// ①由「live 分支吃调用方喂进来的 now」保证，②由「起点取服务端 started_at、
// 终态取服务端 completed_at，两者都与组件挂载时刻无关」保证。
describe('totalElapsedMs —— 运行窗口总耗时', () => {
  const started = '2026-10-30T10:00:00.000Z'

  it('运行中：按 now 逐秒推进', () => {
    const at = (sec: number) => totalElapsedMs(started, null, true, T(started) + sec * 1000)
    expect(at(12)).toBe(12_000)
    expect(at(13)).toBe(13_000)
  })

  it('已结束：锁死在 completed_at - started_at，喂多大 now 都不再涨', () => {
    const end = '2026-10-30T10:04:20.000Z'
    expect(totalElapsedMs(started, end, false, Date.now())).toBe(260_000)
    expect(totalElapsedMs(started, end, false, T(end) + 86_400_000)).toBe(260_000)
  })

  it('重开窗口不重置：同一轮执行两次挂载读到同一个数（终态）', () => {
    const end = '2026-10-30T10:04:20.000Z'
    const first = totalElapsedMs(started, end, false, T(started) + 1000)
    const reopen = totalElapsedMs(started, end, false, T(started) + 9_999_000)
    expect(reopen).toBe(first)
  })

  it('运行中重开也不重置：起点仍是服务端 started_at', () => {
    const mountedAt = T(started) + 300_000
    expect(totalElapsedMs(started, null, true, mountedAt + 5_000)).toBe(305_000)
  })

  it('中止态缺 completed_at：退到最后一个节点的回执时间', () => {
    const steps = [step('2026-10-30T10:01:00.000Z'), step('2026-10-30T10:02:30.000Z')]
    expect(totalElapsedMs(started, null, false, Date.now(), steps)).toBe(150_000)
  })

  it('既无 completed_at 也无节点回执、且已结束：宁可不显示（0/null），不拿打开时刻凑数', () => {
    expect(totalElapsedMs(started, null, false, Date.now(), [])).toBeNull()
  })

  it('缺 started_at（排队中）→ null；时钟倒挂 → 夹到 0 不给负数', () => {
    expect(totalElapsedMs(null, null, true, Date.now())).toBeNull()
    expect(totalElapsedMs(undefined, undefined, true, Date.now())).toBeNull()
    expect(totalElapsedMs('2026-10-30T10:05:00.000Z', started, false, Date.now())).toBe(0)
  })
})
