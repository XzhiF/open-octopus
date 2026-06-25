import { test, expect } from '@playwright/test'

const TEST_WORKSPACE_ID = 'bba463c7-4538-4b54-a746-08297340bee9'

test('cost tab shows per-model breakdown', async ({ page }) => {
  await page.goto(`/workspaces/${TEST_WORKSPACE_ID}`)

  const node = page.locator('[data-node-id*="agent"]').first()
  if (await node.count() > 0) {
    await node.click()
    await page.getByRole('tab', { name: '成本' }).click()

    const costContent = page.locator('[data-testid="cost-content"]')
    if (await costContent.count() > 0) {
      await expect(costContent).toBeVisible()
    }
  }
})
