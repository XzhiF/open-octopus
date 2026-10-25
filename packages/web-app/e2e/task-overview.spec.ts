// 任务浮窗：右侧竖向作业坞（模块/文件/活动同列）+ 对话内项目 chip。
import { test, expect } from '@playwright/test'
import { openApp } from './helpers/desktop'

test.describe('任务窗口 · 竖向作业坞与项目绑定', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('草稿任务：坞内直达计划/专家，入队按钮可见，项目 chip 可用', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('task-session-section')).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(1_500)
    const draft = page.locator('[data-testid="task-session-item"][data-task-status="draft"]').first()
    test.skip((await draft.count()) === 0, '当前库没有草稿任务')
    await draft.click()

    const dock = page.getByTestId('workspace-explorer-dock')
    await expect(dock).toBeVisible()
    await expect(page.getByTestId('task-enqueue')).toBeVisible()
    await expect(dock.locator('[data-dock-module]')).toHaveCount(2)
    await expect(dock.locator('[data-dock-module="plan"]')).toBeVisible()
    await expect(dock.locator('[data-dock-module="experts"]')).toBeVisible()
    await expect(dock.locator('[data-dock-module="changes"]')).toHaveCount(0)
    await expect(dock.locator('[data-dock-module="acceptance"]')).toHaveCount(0)
    // no nested tabs / inspector
    await expect(page.locator('[data-inspector-tab]')).toHaveCount(0)
    await expect(page.locator('[data-testid="workspace-inspector"]')).toHaveCount(0)

    const chip = page.getByTestId('task-project-chip')
    await expect(chip).toBeVisible()
    await chip.click()
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭项目选择' }).click()

    await dock.locator('[data-dock-module="plan"]').click()
    await expect(page.locator('[data-task-window="plan"]')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '关闭窗口' }).last().click()
    await expect(page.locator('[data-task-window="plan"]')).toHaveCount(0)
  })

  test('待验收任务：坞内直达验收，窗口内嵌控制台', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('task-session-section')).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(1_500)
    const awaiting = page.locator('[data-testid="task-session-item"][data-task-status="awaiting_review"]').first()
    test.skip((await awaiting.count()) === 0, '当前库没有待验收任务')
    await awaiting.click()
    const dock = page.getByTestId('workspace-explorer-dock')
    await expect(dock.locator('[data-dock-module="acceptance"]')).toBeVisible()
    await dock.locator('[data-dock-module="acceptance"]').click()
    await expect(page.locator('[data-task-window="acceptance"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-acceptance-modal]')).toBeVisible({ timeout: 10_000 })
  })

  test('任务看板点卡片 → 打开对应 chat 并关闭看板', async ({ page }) => {
    await page.goto('/')
    await openApp(page, '任务看板')
    await page.waitForTimeout(2_000)
    const card = page.locator(
      '[data-task-card][data-task-status="done"], [data-task-card][data-task-status="ready"], [data-task-card][data-task-status="awaiting_review"]',
    ).first()
    test.skip((await card.count()) === 0, '当前库没有可打开对话的任务卡片')
    await card.click()
    await expect(page.locator('[data-window-id="tasks"]')).toHaveCount(0, { timeout: 10_000 })
    await expect(
      page.locator('[data-testid="task-session-item"][aria-current="page"]'),
    ).toBeVisible({ timeout: 10_000 })
  })
})
