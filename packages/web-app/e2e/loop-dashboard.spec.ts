import { test, expect } from '@playwright/test'

test.describe('Loop Dashboard', () => {
  test('shows empty state when no archive data', async ({ page }) => {
    await page.goto('/loop-dashboard')
    await expect(page.locator('text=暂无归档数据')).toBeVisible({ timeout: 10000 })
  })

  test('page loads without JS errors', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto('/loop-dashboard')
    await page.waitForLoadState('networkidle')
    expect(errors).toHaveLength(0)
  })
})
