import { describe, it, expect, beforeEach } from 'vitest'
import {
  CABIN_DRAFT_KEY,
  CABIN_DIR_PROJECTS_KEY,
  echoProjectsForDir,
  readCabinDraft,
  rememberDirProjects,
} from '../cabin-draft'

describe('cabin-draft · 存储', () => {
  beforeEach(() => window.localStorage.clear())

  it('readCabinDraft 容忍坏数据', () => {
    window.localStorage.setItem(CABIN_DRAFT_KEY, 'not json')
    expect(readCabinDraft()).toBeNull()
  })

  it('目录 → 项目回显是本地记忆（关联关系，不搬代码）', () => {
    expect(echoProjectsForDir('/tmp/ledger')).toEqual([])
    rememberDirProjects('/tmp/ledger', [{ org: 'XzhiF', repo: 'ledger' }])
    expect(echoProjectsForDir('/tmp/ledger')).toEqual([{ org: 'XzhiF', repo: 'ledger' }])
    expect(JSON.parse(window.localStorage.getItem(CABIN_DIR_PROJECTS_KEY) ?? '{}')).toHaveProperty('/tmp/ledger')
  })
})