import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachActiveStreamInput,
  findBackgroundWaitStream,
  getActiveStreamBackgroundTasks,
  getActiveStreamPhase,
  listActiveStreams,
  registerActiveStream,
  setActiveStreamBackgroundTasks,
  setActiveStreamPhase,
  unregisterActiveStream,
} from '../services/agent/agent-service'

const PREFIX = 'test-running-'

describe('listActiveStreams', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists only sessions with live streams and reports the earliest start', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-23T10:00:00.000Z'))
    const firstA = registerActiveStream(`${PREFIX}a`, () => {})
    vi.setSystemTime(new Date('2026-10-23T10:00:01.000Z'))
    const firstB = registerActiveStream(`${PREFIX}b`, () => {})
    const secondB = registerActiveStream(`${PREFIX}b`, () => {})

    try {
      const list = listActiveStreams().filter((item) => item.sessionId.startsWith(PREFIX))
      expect(list.map((item) => item.sessionId)).toEqual([`${PREFIX}b`, `${PREFIX}a`])
      expect(list[0].streamCount).toBe(2)
      expect(new Date(list[0].startedAt).toISOString()).toBe('2026-10-23T10:00:01.000Z')
    } finally {
      unregisterActiveStream(`${PREFIX}a`, firstA)
      unregisterActiveStream(`${PREFIX}b`, firstB)
      unregisterActiveStream(`${PREFIX}b`, secondB)
    }
  })

  it('drops sessions once their last stream unregisters', () => {
    const stream = registerActiveStream(`${PREFIX}c`, () => {})
    expect(listActiveStreams().some((item) => item.sessionId === `${PREFIX}c`)).toBe(true)
    unregisterActiveStream(`${PREFIX}c`, stream)
    expect(listActiveStreams().some((item) => item.sessionId === `${PREFIX}c`)).toBe(false)
  })

  // 2026-11-04：后台任务电平进注册表，header / running 探测才能说清「在跑什么」。
  it('carries background tasks on the session and clears them on demand', () => {
    const stream = registerActiveStream(`${PREFIX}d`, () => {})
    try {
      setActiveStreamBackgroundTasks(`${PREFIX}d`, [
        { id: 'bg-1', description: 'mvn spring-boot:run', taskType: 'local_bash' },
      ])
      expect(getActiveStreamBackgroundTasks(`${PREFIX}d`)).toEqual([
        { id: 'bg-1', description: 'mvn spring-boot:run', taskType: 'local_bash' },
      ])
      const item = listActiveStreams().find((s) => s.sessionId === `${PREFIX}d`)
      expect(item?.backgroundTasks).toEqual([
        { id: 'bg-1', description: 'mvn spring-boot:run', taskType: 'local_bash' },
      ])

      // REPLACE 语义：空数组 / null 都清空
      setActiveStreamBackgroundTasks(`${PREFIX}d`, [])
      expect(getActiveStreamBackgroundTasks(`${PREFIX}d`)).toEqual([])
      setActiveStreamBackgroundTasks(`${PREFIX}d`, [{ id: 'bg-2', description: 'another' }])
      setActiveStreamBackgroundTasks(`${PREFIX}d`, null)
      expect(getActiveStreamBackgroundTasks(`${PREFIX}d`)).toEqual([])
    } finally {
      setActiveStreamBackgroundTasks(`${PREFIX}d`, null)
      unregisterActiveStream(`${PREFIX}d`, stream)
    }
  })

  // 2026-11-23 用户 #8：后台等待期 = 模型空闲，允许把用户消息注进同一条查询。
  it('phase / inject：只有 background-wait 且单流时给注入通道', () => {
    const stream = registerActiveStream(`${PREFIX}e`, () => {})
    try {
      expect(getActiveStreamPhase(`${PREFIX}e`)).toBe('generating')
      expect(findBackgroundWaitStream(`${PREFIX}e`)).toBeNull()

      let injected: string | null = null
      attachActiveStreamInput(`${PREFIX}e`, stream, (text) => { injected = text; return true })
      // 生成中不给注入（否则等于并发第二条 SDK 查询，2026-11-10 事故）。
      expect(findBackgroundWaitStream(`${PREFIX}e`)).toBeNull()

      setActiveStreamBackgroundTasks(`${PREFIX}e`, [])
      setActiveStreamPhase(`${PREFIX}e`, stream, 'background-wait')
      expect(getActiveStreamPhase(`${PREFIX}e`)).toBe('background-wait')
      const target = findBackgroundWaitStream(`${PREFIX}e`)
      expect(target?.streamId).toBe(stream)
      expect(target!.inject('服务起来了吗？')).toBe(true)
      expect(injected).toBe('服务起来了吗？')

      // 后台清空 = CLI 即将唤醒续轮：相位收回 generating，注入通道关闭。
      setActiveStreamBackgroundTasks(`${PREFIX}e`, [{ id: 'bg-1', description: 'dev' }])
      setActiveStreamPhase(`${PREFIX}e`, stream, 'background-wait')
      setActiveStreamBackgroundTasks(`${PREFIX}e`, [])
      expect(getActiveStreamPhase(`${PREFIX}e`)).toBe('generating')
      expect(findBackgroundWaitStream(`${PREFIX}e`)).toBeNull()
    } finally {
      unregisterActiveStream(`${PREFIX}e`, stream)
    }
  })

  it('phase / inject：两条并发流时不给注入通道', () => {
    const a = registerActiveStream(`${PREFIX}f`, () => {})
    const b = registerActiveStream(`${PREFIX}f`, () => {})
    try {
      attachActiveStreamInput(`${PREFIX}f`, a, () => true)
      setActiveStreamPhase(`${PREFIX}f`, a, 'background-wait')
      expect(findBackgroundWaitStream(`${PREFIX}f`)).toBeNull()
      // 另一条流还在生成 → 会话整体仍是 generating（任一流生成即忙）。
      expect(getActiveStreamPhase(`${PREFIX}f`)).toBe('generating')
    } finally {
      unregisterActiveStream(`${PREFIX}f`, a)
      unregisterActiveStream(`${PREFIX}f`, b)
    }
  })
})
