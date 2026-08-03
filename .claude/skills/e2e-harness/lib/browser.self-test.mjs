/**
 * Self-test for browser.mjs
 * Run: node lib/browser.self-test.mjs
 * Requires: Playwright chromium installed (npx playwright install chromium)
 * Optional: dev web-app running for navigation test
 */

import { createResults, record, exitWithResults } from "./reporter.mjs"
import { launchBrowser, takeScreenshot, captureConsole, closeBrowser, navigateTo } from "./browser.mjs"
import { resolveWebUrl } from "./api.mjs"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const results = createResults()

async function main() {
  let browser = null

  try {
    // Test 1: Launch browser
    const launched = await launchBrowser({ headless: true })
    browser = launched.browser
    const launchOk = !!launched.browser && !!launched.page
    record(results, "launchBrowser", launchOk, `headless=true`)

    // Test 2: Take screenshot
    const page = launched.page
    await page.setContent("<h1>Harness Test</h1>")
    const tmpDir = path.join(os.tmpdir(), `e2e-harness-screenshot-${Date.now()}`)
    const screenshotPath = await takeScreenshot(page, "self-test", tmpDir)
    const screenshotOk = fs.existsSync(screenshotPath)
    record(results, "takeScreenshot", screenshotOk, `path=${screenshotPath}`)
    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true }) } catch { /* ignore */ }

    // Test 3: Capture console
    const consoleCapture = captureConsole(page)
    await page.evaluate(() => {
      window.console.log("test message")
      window.console.error("test error")
    })
    // Give a moment for events to fire
    await new Promise((r) => setTimeout(r, 200))
    const consoleOk = consoleCapture.all.length > 0
    record(results, "captureConsole captures events", consoleOk, `events=${consoleCapture.all.length}, errors=${consoleCapture.errors.length}`)

    // Test 4: Navigate to web app (optional — web app may not be running)
    try {
      const webUrl = resolveWebUrl()
      await navigateTo(page, webUrl, { timeout: 5000 })
      record(results, "navigateTo web-app", true, `url=${webUrl}`)
    } catch (err) {
      record(results, "navigateTo web-app (optional)", true, `web-app not running — skipped (${err.message?.slice(0, 40)})`)
    }

  } catch (err) {
    record(results, "Unexpected error", false, err instanceof Error ? err.message : String(err))
  } finally {
    if (browser) await closeBrowser(browser)
    exitWithResults(results, { title: "browser.mjs self-test" })
  }
}

main()
