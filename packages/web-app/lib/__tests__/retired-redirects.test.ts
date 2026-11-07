// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { retiredRedirectTarget, KNOWLEDGE_CENTER, DASHBOARD } from '../retired-redirects'

describe('旧路由退役重定向（/wiki、/experience → /knowledge；/workspaces → /dashboard）', () => {
  it('重定向目标判定：退役前缀命中，新世界路径放行', () => {
    expect(retiredRedirectTarget('/wiki')).toBe(KNOWLEDGE_CENTER)
    expect(retiredRedirectTarget('/experience')).toBe(KNOWLEDGE_CENTER)
    expect(retiredRedirectTarget('/wiki/prj-octopus')).toBe(KNOWLEDGE_CENTER)
    expect(retiredRedirectTarget('/experience/review')).toBe(KNOWLEDGE_CENTER)
    expect(retiredRedirectTarget('/knowledge')).toBeNull()
    expect(retiredRedirectTarget('/wikixy')).toBeNull()
    expect(retiredRedirectTarget('/workspaces')).toBe(DASHBOARD)
    expect(retiredRedirectTarget('/workspaces/12')).toBe(DASHBOARD)
    expect(retiredRedirectTarget('/workspaces/12/executions/e1/observability')).toBe(DASHBOARD)
    expect(retiredRedirectTarget('/agent')).toBeNull()
  })

  it('退役路由目录已物理删除', () => {
    const root = process.cwd()
    expect(fs.existsSync(path.join(root, 'app', 'wiki'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'app', 'experience'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'app', 'workspaces'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'components', 'workspaces'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'components', 'settings', 'log-analysis'))).toBe(false)
  })
})
