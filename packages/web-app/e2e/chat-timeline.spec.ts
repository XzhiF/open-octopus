// 用户输入历史（右侧时间线）：≥2 轮才显示；悬停展开提示词列表；点击滚动到该轮。
import { test, expect } from '@playwright/test'

const iso = new Date().toISOString()

const SESSION = {
  id: 'sess-timeline',
  title: '时间线测试',
  org: 'default',
  clone_name: null,
  perspective_clone_name: null,
  session_type: 'chat',
  created_at: iso,
  updated_at: iso,
  last_message_at: null,
  is_active: true,
}

function filler(tag: string): string {
  return Array.from({ length: 30 }, (_, i) => `${tag} 第 ${i + 1} 行内容，用于撑高转录便于滚动验证。`).join('\n')
}

function message(id: string, role: 'user' | 'assistant', content: string) {
  return { id, session_id: SESSION.id, role, content, created_at: iso, ...(role === 'assistant' ? { timeline: [] } : {}) }
}

async function mockSession(page: import('@playwright/test').Page, messages: ReturnType<typeof message>[]) {
  await page.route(
    (url) => url.pathname.endsWith('/api/agent/sessions'),
    (route) => route.fulfill({ json: { items: [SESSION] } }),
  )
  await page.route(
    (url) => url.pathname.endsWith(`/api/agent/sessions/${SESSION.id}`),
    (route) =>
      route.fulfill({
        json: {
          session: SESSION,
          messages: { items: messages, has_more: false, total: messages.length },
          has_more: false,
        },
      }),
  )
}

test.describe('用户输入历史', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('悬停展开提示词列表，点击跳转到该轮', async ({ page }) => {
    await mockSession(page, [
      message('u1', 'user', '第一个问题：解释一下时间线'),
      message('a1', 'assistant', filler('回答一')),
      message('u2', 'user', '第二个问题：再补充一些细节'),
      message('a2', 'assistant', filler('回答二')),
      message('u3', 'user', '第三个问题：最后确认一下'),
      message('a3', 'assistant', filler('回答三')),
    ])

    await page.goto('/')
    const rail = page.getByTestId('chat-timeline')
    await expect(rail).toBeVisible({ timeout: 15_000 })

    // 悬停展开：列表出现三条截断的提示词。
    await rail.hover()
    const rows = page.locator('[data-timeline-id]')
    await expect(rows).toHaveCount(3)
    await expect(rows.first()).toContainText('第一个问题')
    await expect(rows.nth(2)).toContainText('第三个问题')

    // 当前轮（贴底时最后一条）高亮。
    await expect(rows.nth(2)).toHaveAttribute('aria-current', 'true')

    // 点击第一条 → 转录滚动到该轮，且该轮变为高亮。
    await rows.first().click()
    await expect(page.locator('[data-message-id="u1"]')).toBeInViewport()
    await expect(rows.first()).toHaveAttribute('aria-current', 'true')

    // 点第三条 → 回到最后一轮。
    await rows.nth(2).click()
    await expect(page.locator('[data-message-id="u3"]')).toBeInViewport()
    await expect(rows.nth(2)).toHaveAttribute('aria-current', 'true')
  })

  test('Esc 关闭悬停展开的面板，移出再移入可重开', async ({ page }) => {
    await mockSession(page, [
      message('u1', 'user', '第一个问题：解释一下时间线'),
      message('a1', 'assistant', filler('回答一')),
      message('u2', 'user', '第二个问题：再补充一些细节'),
      message('a2', 'assistant', filler('回答二')),
      message('u3', 'user', '第三个问题：最后确认一下'),
      message('a3', 'assistant', filler('回答三')),
    ])

    await page.goto('/')
    const rail = page.getByTestId('chat-timeline')
    await expect(rail).toBeVisible({ timeout: 15_000 })

    await rail.hover()
    await expect(rail).toHaveAttribute('data-open', 'true')
    await expect(page.getByTestId('chat-timeline-list')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(rail).not.toHaveAttribute('data-open', 'true')
    // 鼠标仍停在原位，面板淡出且不会立刻重开。
    await expect
      .poll(() =>
        page
          .getByTestId('chat-timeline-list')
          .evaluate((el) => getComputedStyle(el.parentElement as HTMLElement).opacity),
      )
      .toBe('0')

    // 移出再移入 → 重新展开。
    await page.mouse.move(400, 300)
    await rail.hover()
    await expect(rail).toHaveAttribute('data-open', 'true')
  })

  test('只有一条用户输入时不显示', async ({ page }) => {
    await mockSession(page, [
      message('u1', 'user', '唯一的问题'),
      message('a1', 'assistant', filler('回答')),
    ])

    await page.goto('/')
    await expect(page.locator('[data-message-id="u1"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('chat-timeline')).toHaveCount(0)
  })
})