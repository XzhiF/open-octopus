// AI Native 工作台体验版：任务会话 + 悬浮 dock + 任务窗口。
import { test, expect } from '@playwright/test'
import { appWindow } from './helpers/desktop'

test.describe('AI Native · 任务工作台体验版', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('任务会话打开变更窗口；最小化/恢复；切换任务隐藏与恢复', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('task-session-section')).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(1_500)

    const items = page.locator('[data-testid="task-session-item"][data-task-status="awaiting_review"]')
    const count = await items.count()
    test.skip(count === 0, '当前库没有待验收任务，跳过任务工作台体验测试')

    await items.first().click()
    await page.waitForSelector('[data-testid="task-workbench"]')
    const dock = page.getByTestId('task-dock')
    await expect(dock).toBeVisible()
    await expect(dock.locator('[data-dock-module]')).toHaveCount(5)

    await dock.locator('[data-dock-module="changes"]').click()
    const changesWindow = page.locator('[data-task-window="changes"]')
    await expect(changesWindow).toBeVisible({ timeout: 10_000 })
    await expect(changesWindow.getByText('变更 ·', { exact: false })).toBeVisible()

    await changesWindow.getByRole('button', { name: '最小化窗口' }).click()
    await expect(changesWindow).toHaveCount(0)
    await expect(dock.locator('[data-dock-module="changes"]')).toHaveAttribute('data-minimized', 'true')
    await dock.locator('[data-dock-module="changes"]').click()
    await expect(changesWindow).toBeVisible()

    const firstTaskId = await items.first().getAttribute('data-task-id')
    if (count > 1) {
      await items.nth(1).click()
      await page.waitForTimeout(500)
      await expect(changesWindow).toHaveCount(0)
      await page.locator(`[data-testid="task-session-item"][data-task-id="${firstTaskId}"]`).click()
      await page.waitForTimeout(500)
      await expect(changesWindow).toBeVisible()
    }

    // 主会话切换：任务工作台退出；再回任务会话，窗口按任务状态恢复。
    const mainSession = page.locator('nav[aria-label="会话列表"]').getByText('自我介绍', { exact: true })
    if (await mainSession.count()) {
      await mainSession.first().click()
      await expect(page.getByTestId('task-workbench')).toHaveCount(0)
      await page.locator(`[data-testid="task-session-item"][data-task-id="${firstTaskId}"]`).click()
      await expect(page.getByTestId('task-workbench')).toBeVisible()
      await expect(changesWindow).toBeVisible()
    }

    await changesWindow.getByRole('button', { name: '关闭窗口' }).click()
    await expect(changesWindow).toHaveCount(0)

    // 任务会话不应影响应用窗口条：没有新增 app window。
    await expect(appWindow(page, 'tasks')).toHaveCount(0)
  })
})
