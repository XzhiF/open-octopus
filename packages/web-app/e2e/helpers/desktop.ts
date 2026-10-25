import { expect, type Page } from '@playwright/test'

export const APP_IDS: Record<string, string> = {
  今日: 'dashboard',
  任务看板: 'tasks',
  工作空间: 'workspaces',
  Agent: 'agent',
  知识中心: 'knowledge',
  资源: 'resources',
  系统调度: 'scheduler',
  系统管理: 'system',
  设置: 'settings',
}

/** Open (or focus) an app through the Octopus logo menu. */
export async function openApp(page: Page, app: keyof typeof APP_IDS | string): Promise<string> {
  const id = APP_IDS[app] ?? app
  await page.getByRole('button', { name: 'Octopus 菜单' }).click()
  const item = page.locator(`[data-app-id="${id}"]`)
  await expect(item).toBeVisible({ timeout: 5_000 })
  await item.click()
  // Radix closes with a short animation; wait for the menu to unmount before
  // interacting with the window underneath (the menu overlays the titlebar).
  await expect(page.locator(`[data-app-id="${id}"]`)).toHaveCount(0, { timeout: 5_000 })
  await expect(page.locator(`[data-window-id="${id}"]`)).toBeVisible({ timeout: 20_000 })
  return id
}

export function appWindow(page: Page, id: string) {
  return page.locator(`[data-window-id="${id}"]`)
}

export async function focusApp(page: Page, id: string): Promise<void> {
  await page.locator(`[data-window-icon="${id}"]`).click()
}

export async function closeAllWindows(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Octopus 菜单' }).click()
  await page.getByText('关闭所有窗口').click()
}

export async function bootId(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => (window as unknown as { __OCTOPUS_BOOT_ID__?: string }).__OCTOPUS_BOOT_ID__,
  )
}

export async function dragWindow(page: Page, id: string, dx: number, dy: number): Promise<void> {
  const bar = await appWindow(page, id).locator('[data-window-titlebar]').boundingBox()
  if (!bar) throw new Error(`window ${id} has no title bar`)
  const x = bar.x + bar.width / 2
  const y = bar.y + 18
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(300)
}
