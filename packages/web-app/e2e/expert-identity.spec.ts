// Identity switch (role card; v59 identities are clones) + @ subagent dispatch.
// Two deliberately different surfaces:
//   - identity chip → session-level lead role switch (clone roster)
//   - @ in composer → one-turn subagent dispatch (identity unchanged)

import { test, expect, request as playwrightRequest } from '@playwright/test'

const API = 'http://127.0.0.1:3001'
// 不钉 org：应用侧会话列表走服务端默认 org，测试的预置数据必须落在同一域。
const AUTH = { Authorization: 'Bearer agent' }

test.describe('身份切换（分身）/ @ 派发', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('身份 chip 切换分身；@ 打开专家子代理选择器', async ({ page }) => {
    const api = await playwrightRequest.newContext({ baseURL: API, extraHTTPHeaders: AUTH })
    const title = `E2E 专家切换 ${Date.now()}`
    const created = await api.post('/api/agent/sessions', { data: {} })
    expect(created.status()).toBe(201)
    const session = await created.json() as { id: string; title: string }

    try {
      // Give it a recognizable title so the sidebar row is unambiguous.
      await api.put(`/api/agent/sessions/${session.id}`, { data: { title } })

      await page.goto('/')
      await expect(page.getByTestId('task-session-section')).toBeVisible({ timeout: 15_000 })
      await page.waitForTimeout(1_000)
      const row = page.getByText(title, { exact: true }).first()
      await expect(row).toBeVisible({ timeout: 10_000 })
      await row.click()

      const chip = page.getByTestId('expert-identity-chip')
      await expect(chip).toBeVisible({ timeout: 10_000 })
      await expect(chip).toHaveAttribute('data-expert-id', '')
      await chip.click()

      // 名册会越装越多：弹层里先按关键词过滤再点选（身份名册 = 系统分身）。
      const search = page.getByTestId('identity-search')
      await expect(search).toBeFocused()
      await search.fill('全栈')
      await expect(page.locator('[data-expert-option="archive"]')).toHaveCount(0)

      const workspace = page.locator('[data-expert-option="workspace"]')
      await expect(workspace).toBeVisible()
      await workspace.click()
      await expect(chip).toHaveAttribute('data-expert-id', 'workspace')
      await expect(chip).toContainText('全栈开发助手')

      // The identity is persisted server-side as a clone switch.
      const role = await api.get(`/api/agent/sessions/${session.id}/role`)
      const roleBody = await role.json() as { active_expert: string; active_kind: string }
      expect(roleBody.active_expert).toBe('workspace')
      expect(roleBody.active_kind).toBe('clone')

      // @ = one-turn subagent consult of a clone, not an identity change.
      const ta = page.locator('[data-tui-dock] textarea').first()
      await ta.click()
      await ta.type('@')
      await expect(page.getByTestId('clone-mention-picker')).toBeVisible()
      await page.locator('[data-testid="clone-mention-item"][data-clone-name="archive"]').click()
      await expect(ta).toHaveValue(/@@archive/)
      // Identity is still the clone.
      await expect(chip).toHaveAttribute('data-expert-id', 'workspace')
    } finally {
      await api.delete(`/api/agent/sessions/${session.id}`)
      await api.dispose()
    }
  })
})
