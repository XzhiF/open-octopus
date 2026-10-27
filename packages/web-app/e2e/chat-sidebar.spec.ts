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

  test('侧栏收起为悬浮胶囊，可展开与搜索，跨刷新保留', async ({ page }) => {
    await page.goto('/')
    const aside = page.locator('[data-chat-sidebar]')
    await expect(aside).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: '收起侧栏' }).click()
    await expect(aside).toHaveCount(0)

    const rail = page.getByTestId('chat-sidebar-collapsed')
    await expect(rail).toBeVisible()
    await expect(rail.getByRole('button', { name: '展开侧栏' })).toBeVisible()
    await expect(rail.getByRole('button', { name: '搜索对话' })).toBeVisible()
    await expect(rail.getByRole('button', { name: '开启新对话' })).toBeVisible()

    // Collapsed state survives a reload.
    await page.reload()
    await expect(rail).toBeVisible({ timeout: 15_000 })
    await expect(aside).toHaveCount(0)

    // Rail search re-opens the sidebar with the filter focused.
    await rail.getByRole('button', { name: '搜索对话' }).click()
    await expect(aside).toBeVisible()
    await expect(page.getByTestId('chat-sidebar-search')).toBeFocused()

    await page.getByTestId('chat-sidebar-search').press('Escape')
    await expect(page.getByTestId('chat-sidebar-search')).toHaveCount(0)

    await page.getByRole('button', { name: '收起侧栏' }).click()
    await rail.getByRole('button', { name: '展开侧栏' }).click()
    await expect(aside).toBeVisible()
  })

  test('搜索过滤任务与对话列表', async ({ page }) => {
    const iso = new Date().toISOString()
    const sessions = [
      {
        id: 'sess-alpha',
        title: 'Alpha 方案讨论',
        org: 'default',
        clone_name: null,
        perspective_clone_name: null,
        session_type: 'chat',
        created_at: iso,
        updated_at: iso,
        last_message_at: null,
        is_active: true,
      },
      {
        id: 'sess-beta',
        title: 'Beta 缓存策略',
        org: 'default',
        clone_name: null,
        perspective_clone_name: null,
        session_type: 'chat',
        created_at: iso,
        updated_at: iso,
        last_message_at: null,
        is_active: true,
      },
    ]
    await page.route(
      (url) => url.pathname.endsWith('/api/agent/sessions'),
      (route) => route.fulfill({ json: { items: sessions } }),
    )
    // Session detail only for the two fixtures — /running and /role stay live.
    await page.route(
      (url) => sessions.some((s) => url.pathname.endsWith(`/api/agent/sessions/${s.id}`)),
      (route) => {
        const id = route.request().url().split('/').pop()?.split('?')[0]
        return route.fulfill({
          json: {
            session: sessions.find((s) => s.id === id) ?? sessions[0],
            messages: { items: [], has_more: false, total: 0 },
            has_more: false,
          },
        })
      },
    )

    await page.goto('/')
    const rows = page.locator('[data-session-id]')
    await expect(rows).toHaveCount(2, { timeout: 15_000 })

    await page.getByRole('button', { name: '搜索对话' }).click()
    const filter = page.getByTestId('chat-sidebar-search')
    await expect(filter).toBeFocused()

    await filter.fill('beta')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toHaveAttribute('data-session-id', 'sess-beta')

    await filter.press('Escape')
    await expect(page.getByTestId('chat-sidebar-search')).toHaveCount(0)
    await expect(rows).toHaveCount(2)
  })

  test('新建入口：实体按钮开新对话，任务从会话开始，不打开独立弹窗', async ({ page }) => {
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
    const newMenu = page.getByTestId('sidebar-new')
    await expect(newMenu).toBeVisible({ timeout: 15_000 })
    await newMenu.click()
    await expect(page.getByRole('menuitem', { name: /新建对话/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /新建开发任务/ })).toBeVisible()

    // 新建对话 = lazy main-agent session: empty composer shows its placeholder.
    await page.getByRole('menuitem', { name: /新建对话/ }).click()
    // 等菜单退出动画卸载后再重开：Radix 关闭中再点触发器会被当作「关闭」。
    await expect(page.getByRole('menuitem')).toHaveCount(0)
    await expect(page.locator('textarea').first()).toHaveAttribute('placeholder', /问主 Agent/)

    await newMenu.click()
    await expect(page.getByRole('menuitem', { name: /新建开发任务/ })).toBeVisible()
    await page.getByRole('menuitem', { name: /新建开发任务/ }).click()
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
