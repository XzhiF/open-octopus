// 全站暗黑换肤 — 真实页面截图走查
import { launchBrowser } from './lib/browser.mjs'

const BASE = 'http://localhost:3000'
const res = await fetch(`${BASE}/api/workspaces`).then(r => r.json()).catch(() => null)
const list = res?.workspaces ?? res?.data ?? res ?? []
const wsId = Array.isArray(list) && list.length ? (list[0].id ?? list[0].workspace_id) : null
console.log('workspace id:', wsId)

const PAGES = [
  ['home', '/'],
  ['tasks', '/tasks'],
  ['workspaces', '/workspaces'],
  ...(wsId ? [['ws-detail', `/workspaces/${wsId}`]] : []),
  ['scheduler', '/scheduler'],
  ['agent', '/agent'],
  ['resources', '/resources'],
  ['system', '/system/models'],
  ['experience', '/experience'],
  ['settings', '/settings'],
]

const { browser, page } = await launchBrowser()
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR', m.text().slice(0, 120)) })
for (const [name, path] of PAGES) {
  try {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(2500)
    await page.screenshot({ path: `e2e-screenshots/dark-real-${name}.png`, fullPage: name === 'home' })
    console.log('shot', name)
  } catch (e) { console.log('FAIL', name, e.message.slice(0, 100)) }
}
await browser.close()
