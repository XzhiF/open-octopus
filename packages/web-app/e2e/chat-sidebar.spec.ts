// 对话侧栏：可拖拽宽度（持久化）+ 运行中 Agent 标识。
import { test, expect } from '@playwright/test'
import { openApp } from './helpers/desktop'

test.describe('对话侧栏', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('拖拽改宽并跨刷新保留；运行中的会话带标记', async ({ page }) => {
    await page.goto('/')
    const aside = page.locator('[data-chat-sidebar]')
    await expect(aside).toBeVisible({ timeout: 15_000 })

    const before = await aside.evaluate((el) => Math.round(el.getBoundingClientRect().width))
    const handle = page.getByTestId('chat-sidebar-resizer')
    const box = await handle.boundingBox()
    expect(box).not.toBeNull()
    if (!box) return

    await page.mouse.move(box.x + box.width / 2, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + 200, { steps: 8 })
    await page.mouse.up()

    const after = await aside.evaluate((el) => Math.round(el.getBoundingClientRect().width))
    expect(after).toBeGreaterThan(before + 50)

    await page.reload()
    await expect(aside).toBeVisible({ timeout: 15_000 })
    const persisted = await aside.evaluate((el) => Math.round(el.getBoundingClientRect().width))
    expect(persisted).toBe(after)

    // 双击复位到默认 236。
    await page.getByTestId('chat-sidebar-resizer').dblclick()
    await expect
      .poll(() => aside.evaluate((el) => Math.round(el.getBoundingClientRect().width)))
      .toBe(236)

    const row = page.locator('[data-session-id]').first()
    const sessionId = await row.getAttribute('data-session-id')
    test.skip(!sessionId, '当前库没有会话，跳过运行中标识测试')

    await page.route('**/api/agent/sessions/running*', (route) =>
      route.fulfill({
        json: {
          items: [{
            id: sessionId,
            title: '运行中会话',
            clone_name: null,
            session_type: 'chat',
            started_at: new Date().toISOString(),
            stream_count: 1,
          }],
        },
      }),
    )
    await page.reload()
    const running = page.locator('[data-running-session="true"]')
    await expect(running).toHaveCount(1, { timeout: 10_000 })
    await expect(running).toHaveAttribute('title', /Agent 运行中/)
  })

  test('新建菜单：任务从会话开始，不打开独立弹窗', async ({ page }) => {
    const session = {
      id: 'sess-e2e-author',
      title: '新任务',
      org: 'default',
      clone_name: 'task-author',
      perspective_clone_name: null,
      session_type: 'clone_direct',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_message_at: null,
      is_active: true,
    }
    await page.route('**/api/clones/task-author/sessions', (route) =>
      route.request().method() === 'POST' ? route.fulfill({ json: session }) : route.continue(),
    )
    await page.route('**/api/clones/task-author/sessions/sess-e2e-author/running*', (route) =>
      route.fulfill({ json: { running: false, partial: false } }),
    )
    await page.route('**/api/clones/task-author/sessions/sess-e2e-author*', (route) =>
      route.fulfill({
        json: { session, messages: { items: [], has_more: false, total: 0 }, has_more: false },
      }),
    )

    await page.goto('/')
    await page.getByRole('button', { name: '新建' }).click()
    await expect(page.getByRole('menuitem', { name: /新建对话/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /新建任务/ })).toBeVisible()

    await page.getByRole('menuitem', { name: /新建任务/ }).click()
    await expect(page.getByTestId('pending-task-item')).toBeVisible()
    await expect(page.getByTestId('pending-task-item')).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('textarea').first()).toHaveAttribute(
      'placeholder',
      /描述要开发的任务/,
    )
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
  })

  test('任务看板的新建任务回到统一会话，不再开模板弹窗', async ({ page }) => {
    const session = {
      id: 'sess-board-author',
      title: '新任务',
      org: 'default',
      clone_name: 'task-author',
      perspective_clone_name: null,
      session_type: 'clone_direct',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_message_at: null,
      is_active: true,
    }
    await page.route('**/api/clones/task-author/sessions', (route) =>
      route.request().method() === 'POST' ? route.fulfill({ json: session }) : route.continue(),
    )
    await page.route('**/api/clones/task-author/sessions/sess-board-author/running*', (route) =>
      route.fulfill({ json: { running: false, partial: false } }),
    )
    await page.route('**/api/clones/task-author/sessions/sess-board-author*', (route) =>
      route.fulfill({
        json: { session, messages: { items: [], has_more: false, total: 0 }, has_more: false },
      }),
    )

    await page.goto('/')
    await openApp(page, '任务看板')
    await page.locator('[data-task-new]').click()

    await expect(page.getByTestId('pending-task-item')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-template-picker]')).toHaveCount(0)
  })
})
