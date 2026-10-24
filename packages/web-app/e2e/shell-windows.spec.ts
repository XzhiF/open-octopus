// 桌面壳 v1：浮动窗口、拖拽/缩放、持久化、总览、运行中 agent。
import { test, expect } from '@playwright/test'
import {
  appWindow,
  bootId,
  dragWindow,
  focusApp,
  openApp,
} from './helpers/desktop'

test.describe('桌面壳 · 窗口', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('应用单实例；拖拽、缩放、最大化、最小化、关闭', async ({ page }) => {
    await page.goto('/')
    await openApp(page, '今日')
    await openApp(page, '工作空间')
    await expect(page).toHaveURL(/\/workspaces$/)

    const dashboard = appWindow(page, 'dashboard')
    await openApp(page, '今日')
    await expect(dashboard).toHaveCount(1)
    await expect(page).toHaveURL(/\/dashboard$/)

    const before = await dashboard.boundingBox()
    await dragWindow(page, 'dashboard', 100, 50)
    await expect
      .poll(async () => Math.round((await dashboard.boundingBox())!.x))
      .toBeGreaterThan(Math.round(before!.x) + 60)

    const widthBefore = (await dashboard.boundingBox())!.width
    const se = await dashboard.locator('[data-resize-dir="se"]').boundingBox()
    await page.mouse.move(se!.x + se!.width / 2, se!.y + se!.height / 2)
    await page.mouse.down()
    await page.mouse.move(se!.x + se!.width / 2 + 80, se!.y + se!.height / 2 + 60, { steps: 8 })
    await page.mouse.up()
    await expect
      .poll(async () => (await dashboard.boundingBox())!.width)
      .toBeGreaterThan(widthBefore + 40)

    await dashboard.getByRole('button', { name: '最大化窗口' }).click()
    const maximized = await dashboard.boundingBox()
    expect(Math.round(maximized!.height)).toBe(900 - 40)
    await dashboard.getByRole('button', { name: '最大化窗口' }).click()

    await dashboard.locator('[data-window-titlebar]').dblclick({ position: { x: 300, y: 18 } })
    await expect
      .poll(async () => Math.round((await dashboard.boundingBox())!.height))
      .toBe(900 - 40)
    await dashboard.locator('[data-window-titlebar]').dblclick({ position: { x: 300, y: 18 } })
    await expect
      .poll(async () => Math.round((await dashboard.boundingBox())!.height))
      .toBeLessThan(900 - 40)

    await dashboard.getByRole('button', { name: '最小化窗口' }).click()
    await expect(dashboard).toBeHidden()
    await expect(page).toHaveURL(/\/workspaces$/)
    await focusApp(page, 'dashboard')
    await expect(dashboard).toBeVisible()
    await expect(page).toHaveURL(/\/dashboard$/)

    const boot = await bootId(page)
    await dashboard.getByRole('button', { name: '关闭窗口' }).click()
    await expect(dashboard).toHaveCount(0)
    await expect(page).toHaveURL(/\/workspaces$/)
    expect(await bootId(page)).toBe(boot)

    await page.goBack()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(appWindow(page, 'dashboard')).toBeVisible()
  })

  test('三色灯左侧整条不可拖拽，灯点外仍可关闭', async ({ page }) => {
    await page.goto('/')
    await openApp(page, '任务看板')
    const win = appWindow(page, 'tasks')
    const bar = await win.locator('[data-window-titlebar]').boundingBox()
    const close = await win.getByRole('button', { name: '关闭窗口' }).boundingBox()
    const cx = close!.x + close!.width / 2
    const cy = close!.y + close!.height / 2

    const hit = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y)
        return {
          noDrag: !!el?.closest('[data-no-drag]'),
          cursor: el ? getComputedStyle(el).cursor : '',
        }
      },
      { x: cx, y: bar!.y + 30 },
    )
    expect(hit.noDrag).toBe(true)
    expect(hit.cursor).not.toBe('grab')

    const before = await win.boundingBox()
    await page.mouse.move(cx, bar!.y + 30)
    await page.mouse.down()
    await page.mouse.move(cx + 90, bar!.y + 40, { steps: 6 })
    await page.mouse.up()
    await expect
      .poll(async () => Math.round((await win.boundingBox())!.x))
      .toBe(Math.round(before!.x))

    // 2px outside the 12px dot still lands in the expanded hit area.
    await page.mouse.click(cx + 8, cy)
    await expect(win).toHaveCount(0)
  })

  test('默认任务窗口五列自适应，无横向滚动', async ({ page }) => {
    await page.goto('/tasks')
    const win = appWindow(page, 'tasks')
    await expect(win).toBeVisible()
    await expect(page.locator('[data-task-column]')).toHaveCount(5)

    const scroll = page.getByTestId('task-board-scroll')
    expect(await scroll.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)

    const draft = await page.locator('[data-task-column="draft"]').boundingBox()
    const done = await page.locator('[data-task-column="done"]').boundingBox()
    expect(Math.round(draft!.y)).toBe(Math.round(done!.y))
    expect(draft!.width).toBeGreaterThan(220)
  })

  test('详情深链、刷新恢复与窗口布局持久化', async ({ page }) => {
    await page.goto('/workspaces')
    const link = page.locator('[data-window-id="workspaces"] a[href^="/workspaces/"]').first()
    await expect(link).toBeVisible({ timeout: 20_000 })
    const href = await link.getAttribute('href')
    expect(href).toMatch(/^\/workspaces\//)

    await page.goto(href!)
    const win = appWindow(page, 'workspaces')
    await expect(win.locator('[data-window-layer="detail"]')).toBeVisible({ timeout: 20_000 })
    const detailUrl = page.url()

    await page.reload()
    await expect(win).toBeVisible({ timeout: 20_000 })
    await expect(page).toHaveURL(detailUrl)
    await expect(win.locator('[data-window-layer="detail"]')).toBeVisible({ timeout: 20_000 })

    await page.goBack()
    await expect(page).toHaveURL(/\/workspaces$/)
    await expect(win.locator('[data-window-layer="detail"]')).toHaveCount(0)
    await page.goForward()
    await expect(page).toHaveURL(detailUrl)
    await expect(win.locator('[data-window-layer="detail"]')).toBeVisible({ timeout: 20_000 })

    await dragWindow(page, 'workspaces', 70, 40)
    const dragged = await win.boundingBox()
    await page.waitForTimeout(600)
    await page.reload()
    await expect(win).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => Math.round((await win.boundingBox())!.x))
      .toBe(Math.round(dragged!.x))
  })

  test('窗口总览：桌面 + 打开窗口，点击格子聚焦', async ({ page }) => {
    await page.goto('/')
    await openApp(page, '任务看板')
    await openApp(page, '工作空间')

    await page.getByRole('button', { name: '窗口总览' }).click()
    await expect(page.getByTestId('mission-control')).toBeVisible()
    await expect(page.locator('[data-mc-tile]')).toHaveCount(3)

    await page.locator('[data-mc-tile="tasks"]').click()
    await expect(page.getByTestId('mission-control')).toHaveCount(0)
    await expect(page).toHaveURL(/\/tasks$/)
  })

  test('隐藏窗口的全局快捷键被门禁', async ({ page }) => {
    await page.goto('/')
    await openApp(page, '任务看板')
    await openApp(page, '工作空间')

    const inactiveBlocked = await page.evaluate(() => {
      const el = document.querySelector('[data-window-id="tasks"]')!
      const event = new KeyboardEvent('keydown', {
        key: 'k',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      })
      el.dispatchEvent(event)
      return event.defaultPrevented
    })
    const activeAllowed = await page.evaluate(() => {
      const el = document.querySelector('[data-window-id="workspaces"]')!
      const event = new KeyboardEvent('keydown', {
        key: 'k',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      })
      el.dispatchEvent(event)
      return event.defaultPrevented
    })

    expect(inactiveBlocked).toBe(true)
    expect(activeAllowed).toBe(false)
  })

  test('运行中的 agent：最新在最右，点击最小化窗口并回到对话桌面', async ({ page }) => {
    await page.route('**/api/agent/sessions/running*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 's-new',
              title: 'Beta 分析',
              clone_name: null,
              session_type: 'main',
              started_at: new Date().toISOString(),
              stream_count: 1,
            },
            {
              id: 's-old',
              title: 'Alpha 调研',
              clone_name: null,
              session_type: 'main',
              started_at: new Date(Date.now() - 60_000).toISOString(),
              stream_count: 1,
            },
          ],
        }),
      }),
    )

    await page.goto('/')
    await expect(page.locator('[data-running-agent]')).toHaveCount(2, { timeout: 10_000 })
    const newest = await page.locator('[data-running-agent="s-new"]').boundingBox()
    const oldest = await page.locator('[data-running-agent="s-old"]').boundingBox()
    expect(newest!.x).toBeGreaterThan(oldest!.x)

    await openApp(page, '任务看板')
    await page.locator('[data-running-agent="s-old"]').click()
    await expect(page).toHaveURL(/\/$/)
    await expect(appWindow(page, 'tasks')).toBeHidden()
  })
})

test.describe('桌面壳 · 中屏', () => {
  test.use({ viewport: { width: 900, height: 800 } })

  test('窗口强制最大化铺满 stage', async ({ page }) => {
    await page.goto('/')
    await openApp(page, '任务看板')
    await openApp(page, '工作空间')
    for (const id of ['tasks', 'workspaces']) {
      const box = await appWindow(page, id).boundingBox()
      expect(Math.round(box!.x)).toBe(0)
      expect(Math.round(box!.y)).toBe(40)
      expect(Math.round(box!.width)).toBe(900)
      expect(Math.round(box!.height)).toBe(800 - 40)
    }
  })

  test('中屏任务看板三列重排，无横向滚动', async ({ page }) => {
    await page.goto('/tasks')
    await expect(appWindow(page, 'tasks')).toBeVisible()

    const scroll = page.getByTestId('task-board-scroll')
    expect(await scroll.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)

    const draft = await page.locator('[data-task-column="draft"]').boundingBox()
    const ready = await page.locator('[data-task-column="ready"]').boundingBox()
    const running = await page.locator('[data-task-column="running"]').boundingBox()
    const awaiting = await page.locator('[data-task-column="awaiting_review"]').boundingBox()
    expect(Math.round(draft!.y)).toBe(Math.round(ready!.y))
    expect(Math.round(running!.y)).toBe(Math.round(draft!.y))
    expect(Math.round(awaiting!.y)).toBeGreaterThan(Math.round(draft!.y))
    expect(draft!.width).toBeGreaterThan(240)
  })
})
