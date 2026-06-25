import { test, expect } from '@playwright/test'

test('Dashboard page loads', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  await expect(page.getByText('工作流编排平台概览')).toBeVisible()
})

test('Stats cards show data', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('text=活跃工作空间')).toBeVisible()
  await expect(page.locator('text=运行中任务')).toBeVisible()
  await expect(page.locator('text=今日完成')).toBeVisible()
})

test('Hero Metrics display', async ({ page }) => {
  await page.goto('/')
  // Hero metrics are loaded asynchronously — wait for them to appear
  await expect(page.getByText('总执行')).toBeVisible({ timeout: 10000 })
  await expect(page.getByText('成功率')).toBeVisible({ timeout: 10000 })
  await expect(page.getByText('总成本')).toBeVisible({ timeout: 10000 })
  await expect(page.getByText('平均耗时')).toBeVisible({ timeout: 10000 })
})
