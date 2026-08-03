/**
 * E2E Harness — browser.mjs
 * Playwright browser management for E2E tests.
 *
 * @module browser
 * @status STABLE
 *
 * Provides launch, screenshot, console capture, and close helpers.
 * All browser operations use Playwright's chromium by default.
 */

import { chromium } from "playwright"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_VIEWPORT = { width: 1440, height: 900 }
const DEFAULT_SCREENSHOT_DIR = path.join(process.cwd(), "e2e-screenshots")

/**
 * Launch a Playwright chromium browser.
 *
 * @param {object} [options]
 * @param {boolean} [options.headless=true]
 * @param {{ width: number, height: number }} [options.viewport]
 * @param {string} [options.locale="zh-CN"]
 * @returns {Promise<{ browser: Browser, context: BrowserContext, page: Page }>}
 */
export async function launchBrowser(options = {}) {
  const {
    headless = true,
    viewport = DEFAULT_VIEWPORT,
    locale = "zh-CN",
  } = options

  const browser = await chromium.launch({ headless })
  const context = await browser.newContext({ viewport, locale })
  const page = await context.newPage()

  return { browser, context, page }
}

/**
 * Take a screenshot of the current page.
 *
 * @param {Page} page - Playwright page object
 * @param {string} name - Screenshot filename (without extension)
 * @param {string} [dir] - Output directory (default: ./e2e-screenshots)
 * @param {object} [options]
 * @param {boolean} [options.fullPage=false]
 * @returns {Promise<string>} absolute path to the screenshot file
 */
export async function takeScreenshot(page, name, dir, options = {}) {
  const outputDir = dir || DEFAULT_SCREENSHOT_DIR
  fs.mkdirSync(outputDir, { recursive: true })

  const filePath = path.join(outputDir, `${name}.png`)
  await page.screenshot({
    path: filePath,
    fullPage: options.fullPage ?? false,
  })

  return filePath
}

/**
 * Capture browser console output.
 * Returns mutable arrays that populate as console events fire.
 *
 * @param {Page} page - Playwright page object
 * @returns {{ errors: string[], warnings: string[], all: Array<{ type: string, text: string }> }}
 */
export function captureConsole(page) {
  const errors = []
  const warnings = []
  const all = []

  page.on("console", (msg) => {
    const entry = { type: msg.type(), text: msg.text() }
    all.push(entry)

    if (msg.type() === "error") errors.push(msg.text())
    if (msg.type() === "warning") warnings.push(msg.text())
  })

  return { errors, warnings, all }
}

/**
 * Navigate to a URL and wait for the page to be ready.
 *
 * @param {Page} page - Playwright page object
 * @param {string} url - Full URL to navigate to
 * @param {object} [options]
 * @param {string} [options.waitUntil="domcontentloaded"]
 * @param {string} [options.waitForSelector] - CSS selector or text to wait for
 * @param {number} [options.timeout=15000]
 * @returns {Promise<void>}
 */
export async function navigateTo(page, url, options = {}) {
  const { waitUntil = "domcontentloaded", waitForSelector, timeout = 15000 } = options

  await page.goto(url, { waitUntil, timeout })

  if (waitForSelector) {
    await page.waitForSelector(waitForSelector, { timeout })
  }
}

/**
 * Wait for a specified duration.
 *
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
export async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Close a Playwright browser instance.
 *
 * @param {Browser} browser
 * @returns {Promise<void>}
 */
export async function closeBrowser(browser) {
  if (browser) {
    await browser.close()
  }
}

/**
 * Click an element by data-testid attribute.
 *
 * @param {Page} page
 * @param {string} testId - data-testid value
 * @param {object} [options]
 * @param {number} [options.timeout=5000]
 * @returns {Promise<boolean>} true if clicked, false if not found
 */
export async function clickByTestId(page, testId, options = {}) {
  const { timeout = 5000 } = options
  const locator = page.locator(`[data-testid="${testId}"]`)

  try {
    await locator.waitFor({ state: "visible", timeout })
    await locator.click()
    return true
  } catch {
    return false
  }
}

/**
 * Fill a form input by data-testid attribute.
 *
 * @param {Page} page
 * @param {string} testId
 * @param {string} value
 * @param {object} [options]
 * @param {number} [options.timeout=5000]
 * @returns {Promise<boolean>}
 */
export async function fillByTestId(page, testId, value, options = {}) {
  const { timeout = 5000 } = options
  const locator = page.locator(`[data-testid="${testId}"]`)

  try {
    await locator.waitFor({ state: "visible", timeout })
    await locator.fill(value)
    return true
  } catch {
    return false
  }
}

/**
 * Get text content of an element by data-testid.
 *
 * @param {Page} page
 * @param {string} testId
 * @param {object} [options]
 * @param {number} [options.timeout=5000]
 * @returns {Promise<string | null>}
 */
export async function getTextByTestId(page, testId, options = {}) {
  const { timeout = 5000 } = options
  const locator = page.locator(`[data-testid="${testId}"]`)

  try {
    await locator.waitFor({ state: "visible", timeout })
    return await locator.textContent()
  } catch {
    return null
  }
}
