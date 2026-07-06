import { test, expect } from '@playwright/test'

// Workspace ID for test-workspace (UUID, not name — API requires UUID)
const TEST_WORKSPACE_ID = '569873c2-d648-4bbc-bf11-ef5b37761507'

test('completed agent node shows Turn-Centric Timeline', async ({ page }) => {
  await page.goto(`/workspaces/${TEST_WORKSPACE_ID}`)

  // The execution flow tab is a button, not role="tab"
  const flowTab = page.getByRole('button', { name: '执行流程图' })
  await expect(flowTab).toBeVisible({ timeout: 10000 })

  const node = page.locator('[data-node-id*="agent"]').first()
  if (await node.count() > 0) {
    await node.click()

    await expect(page.getByRole('tab', { name: '追踪' })).toBeVisible({ timeout: 10000 })

    await page.getByRole('tab', { name: '追踪' }).click()

    await expect(page.getByText(/turn/i)).toBeVisible({ timeout: 10000 })
  }
})

test('bash node does not show traces tab', async ({ page }) => {
  await page.goto(`/workspaces/${TEST_WORKSPACE_ID}`)

  const node = page.locator('[data-node-id*="bash"]').first()
  if (await node.count() > 0) {
    await node.click()
    await expect(page.getByRole('tab', { name: '追踪' })).not.toBeVisible()
  }
})
