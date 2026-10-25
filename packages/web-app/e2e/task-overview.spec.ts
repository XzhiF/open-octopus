// 任务概览：一个任务一个结果面（计划/变更/验收）+ 对话内项目 chip。
import { test, expect } from '@playwright/test'
import { openApp } from './helpers/desktop'

test.describe('任务窗口 · 概览与项目绑定', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('草稿任务：计划/变更/验收三个视图，项目 chip 可打开选择器', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('task-session-section')).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(1_500)
    const draft = page.locator('[data-testid="task-session-item"][data-task-status="draft"]').first()
    test.skip((await draft.count()) === 0, '当前库没有草稿任务')
    await draft.click()
    await expect(page.getByTestId('task-overview-trigger')).toBeVisible()

    const chip = page.getByTestId('task-project-chip')
    await expect(chip).toBeVisible()
    await chip.click()
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭项目选择' }).click()

    await page.getByTestId('task-overview-trigger').click()
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-overview-tab]')).toHaveCount(4)
    await expect(page.getByTestId('task-overview-enqueue')).toBeVisible()
    await page.locator('[data-overview-tab="changes"]').click()
    await expect(page.getByText('还没有代码变更')).toBeVisible()
    await page.locator('[data-overview-tab="acceptance"]').click()
    await expect(page.getByText('入队并执行后才能验收')).toBeVisible()
    await page.getByRole('button', { name: '关闭任务概览' }).click()
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
  })

  test('待验收任务：验收视图内嵌控制台', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('task-session-section')).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(1_500)
    const awaiting = page.locator('[data-testid="task-session-item"][data-task-status="awaiting_review"]').first()
    test.skip((await awaiting.count()) === 0, '当前库没有待验收任务')
    await awaiting.click()
    await page.getByTestId('task-overview-trigger').click()
    await page.locator('[data-overview-tab="acceptance"]').click()
    await expect(page.locator('[data-acceptance-modal]')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '关闭任务概览' }).click()
  })

  test('任务看板点卡片 → 打开对应 chat 并关闭看板', async ({ page }) => {
    await page.goto('/')
    await openApp(page, '任务看板')
    await page.waitForTimeout(2_000)
    const card = page.locator('[data-task-card]').first()
    test.skip((await card.count()) === 0, '当前库没有任务卡片')
    await card.click()
    await expect(page.locator('[data-window-id="tasks"]')).toHaveCount(0, { timeout: 10_000 })
    await expect(
      page.locator('[data-testid="task-session-item"][aria-current="page"]'),
    ).toBeVisible({ timeout: 10_000 })
  })
})
