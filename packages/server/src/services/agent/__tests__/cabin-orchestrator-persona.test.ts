// packages/server/src/services/agent/__tests__/cabin-orchestrator-persona.test.ts
//
// 2026-11-19 用户 #6/#8：汐音（cabin-orchestrator）不再只是调度者 ——
// 她能调度，也能自己写业务代码。这里钉住那次改版的两个承重点：
//   1. 人格文本允许并默认「自己做」，旧口径「绝不亲自写业务代码」不得回归；
//   2. CloneDef.skills 置空 = 全部共享技能（ADR-006 下这才是事实，
//      角色卡若只写 octo-wiki 会误导模型）。
// 文本断言只钉语义锚点，不抄全文（人格本来就会继续演进）。

import { describe, it, expect } from 'vitest'
import { getBuiltinCloneDef } from '../builtin-clones'

describe('cabin-orchestrator persona — 能调度，也能开发', () => {
  it('registered as 舱调度者 with isolated memory', () => {
    const def = getBuiltinCloneDef('cabin-orchestrator')
    expect(def).not.toBeNull()
    expect(def!.displayName).toBe('舱调度者')
    expect(def!.type).toBe('built-in')
    expect(def!.memoryScope).toBe('isolated')
  })

  it('declares no skill whitelist — the role card must say 全部共享技能', () => {
    const def = getBuiltinCloneDef('cabin-orchestrator')!
    expect(def.skills).toEqual([])
  })

  it('grants direct development (自己做) while keeping dispatch', () => {
    const persona = getBuiltinCloneDef('cabin-orchestrator')!.persona
    // 新的默认：小到中等改动自己做。
    expect(persona).toContain('自己写业务代码')
    expect(persona).toContain('自己做')
    expect(persona).toContain('派任务 doer')
    // 旧口径不得回归。
    expect(persona).not.toContain('绝不亲自写业务代码')
    expect(persona).not.toContain('代码工作永远委派')
  })

  it('keeps the direct-work discipline (commit / worktree / note)', () => {
    const persona = getBuiltinCloneDef('cabin-orchestrator')!.persona
    expect(persona).toContain('git commit')
    expect(persona).toContain('worktree')
    expect(persona).toContain('cabin_note_job')
  })
})
