// PROTOTYPE walk — 全站暗黑 TUI 原型逐页截图
import { launchBrowser } from './lib/browser.mjs'

const PAGES = ['dash','tasks','ws','wsd','exp','sched','agent','res','sys','log']
const { browser, page } = await launchBrowser()
for (const p of PAGES) {
  await page.goto(`http://localhost:3000/prototype/site-dark-tui.html#${p}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(250)
  await page.screenshot({ path: `e2e-screenshots/site-dark-${p}.png`, fullPage: p === 'dash' || p === 'tasks' || p === 'ws' })
  console.log('shot', p)
}
await browser.close()
