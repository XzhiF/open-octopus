// Expert identity switch (role card) + @ expert subagent dispatch picker.
// Two deliberately different surfaces:
//   - identity chip → session-level lead role switch
//   - @ in composer → one-turn subagent dispatch (identity unchanged)

import { test, expect, request as playwrightRequest } from '@playwright/test'

const API = 'http://127.0.0.1:3001'
// 不钉 org：应用侧会话列表走服务端默认 org，测试的预置数据必须落在同一域。
const AUTH = { Authorization: 'Bearer agent' }

test.describe('专家身份切换 / @ 派发', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('身份 chip 切换主专家；@ 打开专家子代理选择器', async ({ page }) => {
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

      // 名册会越装越多：弹层里先按关键词过滤再点选。
      const search = page.getByTestId('identity-search')
      await expect(search).toBeFocused()
      await search.fill('sre')
      await expect(page.locator('[data-expert-option="product-manager"]')).toHaveCount(0)

      const sre = page.locator('[data-expert-option="engineering-sre"]')
      await expect(sre).toBeVisible()
      await sre.click()
      await expect(chip).toHaveAttribute('data-expert-id', 'engineering-sre')
      await expect(chip).toContainText('SRE')

      // The role is persisted server-side.
      const role = await api.get(`/api/agent/sessions/${session.id}/role`)
      expect((await role.json() as { active_expert: string }).active_expert).toBe('engineering-sre')

      // @ expert = subagent dispatch, not identity change.
      const ta = page.locator('[data-tui-dock] textarea').first()
      await ta.click()
      await ta.type('@')
      await expect(page.getByTestId('expert-mention-picker')).toBeVisible()
      await page.locator('[data-testid="expert-mention-item"][data-expert-id="product-manager"]').click()
      await expect(ta).toHaveValue(/@产品经理/)
      // Identity is still SRE.
      await expect(chip).toHaveAttribute('data-expert-id', 'engineering-sre')
    } finally {
      await api.delete(`/api/agent/sessions/${session.id}`)
      await api.dispose()
    }
  })
})
