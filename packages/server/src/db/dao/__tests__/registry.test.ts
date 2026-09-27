/**
 * registry.ts（B0.5 §5 方案1 外提）零行为变化钉桩：
 *   1. eager 与 lazy 两张注册表的键集合一致（index.ts 消费面 d.<key> 全覆盖）。
 *   2. lazyDAO 时序不变 —— createLazyDAOs() 不触 DB；首次属性访问才构造
 *      （构造即调 getDb()，未接线时抛 "Database not initialized"，与旧 index.ts 同款）。
 *   3. eager createAllDAOs 在真 sqlite 句柄上全部构造成功（含构造函数带 DDL 的 ArchiveDraftDAO）。
 */
import { describe, it, expect } from 'vitest'
import { initDb, closeDb } from '../../connection'
import { createAllDAOs, createLazyDAOs } from '../registry'

const KEYS = [
  'workspace', 'execution', 'tokenUsage', 'scheduleConfig', 'scheduleRun', 'chat',
  'org', 'agentSession', 'evolution', 'clone', 'safety', 'pendingReview',
  'knowledgeEffectiveness', 'archive', 'archiveDraft', 'interactionMessage',
  'agentVersion', 'harness', 'task',
] as const

describe('dao registry (B0.5 §5)', () => {
  it('19 个 DAO 键齐全且 eager/lazy 两张表一致', () => {
    expect(Object.keys(createLazyDAOs()).sort()).toEqual([...KEYS].sort())
    const db = initDb(':memory:') // 自带 applySchema
    try {
      expect(Object.keys(createAllDAOs(db)).sort()).toEqual([...KEYS].sort())
    } finally {
      closeDb()
    }
  })

  it('lazy：注册本身不触 DB，首次属性访问才构造（时序 = 旧 index.ts）', () => {
    const d = createLazyDAOs() // 不得抛 —— 此刻没有任何 getDb() 调用
    expect(d).toBeTruthy()
    // 本文件从未 initDb()（vitest 模块隔离），首访必须死在 "Database not initialized"
    expect(() => (d.org as any).findAll()).toThrow(/Database not initialized/)
    // 失败构造不落缓存：接线后同一 Proxy 能真正工作由既有 suite（route-snapshot 等）背书
    expect(() => (d.org as any).findAll()).toThrow(/Database not initialized/)
  })
})
