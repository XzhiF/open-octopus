// 桌面壳 v1：Octopus 菜单 + 打开窗口 + 桌面常驻对话。
import { test, expect } from '@playwright/test'
import {
  appWindow,
  bootId,
  closeAllWindows,
  openApp,
} from './helpers/desktop'

test.describe('桌面壳 · 全局 header', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('logo 菜单列出 9 个应用；打开今日窗口且对话保持挂载', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('desktop-stage')).toBeVisible()
    const boot = await bootId(page)

    await page.getByRole('button', { name: 'Octopus 菜单' }).click()
    await expect(page.locator('[data-app-id]')).toHaveCount(9)
    await page.locator('[data-app-id="dashboard"]').click()

    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(appWindow(page, 'dashboard')).toBeVisible()
    await expect(appWindow(page, 'dashboard').getByRole('heading', { name: '今日' }).first()).toBeVisible()
    expect(await bootId(page)).toBe(boot)

    await closeAllWindows(page)
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('[data-window-id]')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '对话', level: 1 })).toBeVisible()
  })

  test('旧 Agent 对话入口重定向到对话桌面，不创建 Agent 窗口', async ({ page }) => {
    await page.goto('/agent?tab=chat')
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('[data-window-id="agent"]')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: '对话', level: 1 })).toBeVisible()
  })

  test('对话草稿在打开/关闭应用窗口后保留', async ({ page }) => {
    await page.goto('/')
    const composer = page.locator('textarea').first()
    await expect(composer).toBeVisible({ timeout: 20_000 })
    await composer.fill('draft-survives-window')

    await openApp(page, '任务看板')
    await expect(page).toHaveURL(/\/tasks$/)

    await appWindow(page, 'tasks').getByRole('button', { name: '关闭窗口' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('textarea').first()).toHaveValue('draft-survives-window')
  })

  test('菜单「关闭所有窗口」清空桌面', async ({ page }) => {
    await page.goto('/')
    await openApp(page, '任务看板')
    await openApp(page, '工作空间')
    await expect(page.locator('[data-window-id]')).toHaveCount(2)
    await closeAllWindows(page)
    await expect(page.locator('[data-window-id]')).toHaveCount(0)
    await expect(page).toHaveURL(/\/$/)
  })

  test('菜单点外部 / Esc 关闭', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Octopus 菜单' }).click()
    await expect(page.locator('[data-app-id="tasks"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-app-id="tasks"]')).toHaveCount(0)

    await page.getByRole('button', { name: 'Octopus 菜单' }).click()
    await expect(page.locator('[data-app-id="tasks"]')).toBeVisible()
    await page.mouse.click(1100, 500)
    await expect(page.locator('[data-app-id="tasks"]')).toHaveCount(0)
  })
})

test.describe('桌面壳 · 窄屏', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('logo 打开抽屉，应用全屏，总览为底部面板', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Octopus 菜单' }).click()
    await expect(page.locator('[data-app-id]')).toHaveCount(9)
    await page.locator('[data-app-id="settings"]').click()

    await expect(page).toHaveURL(/\/settings$/)
    const win = appWindow(page, 'settings')
    await expect(win).toBeVisible()
    const box = await win.boundingBox()
    expect(Math.round(box!.width)).toBe(375)
    expect(Math.round(box!.height)).toBe(812 - 40)

    await page.getByRole('button', { name: '窗口总览' }).click()
    await expect(page.getByTestId('mission-control')).toBeVisible()
    await expect(page.locator('[data-mc-tile]')).toHaveCount(2)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('mission-control')).toHaveCount(0)
  })
})
