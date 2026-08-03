# Pattern: Tab Switch

## When to Use

When an E2E test needs to navigate between editor tabs in the workspace detail view — switching between execution panels, workflow editors, text editors, and image viewers. Tabs appear in a horizontal bar below the workspace header.

## Modules to Import

```js
import { launchBrowser, navigateTo, closeBrowser, clickByTestId, wait, takeScreenshot, getTextByTestId } from "../lib/browser.mjs"
import { resolveWebUrl } from "../lib/api.mjs"
import { createWorkspace, cleanupWorkspace } from "../lib/workspace.mjs"
import { createResults, record, exitWithResults } from "../lib/reporter.mjs"
```

## Selectors (data-testid)

| Element | Selector | Notes |
|---------|----------|-------|
| Workspace detail root | `[data-testid="workspace-detail"]` | Top-level container |
| Workspace header | `[data-testid="workspace-header"]` | Name, badge, toggles |
| Tab bar | `[data-testid="tab-bar"]` | Horizontal scrollable strip |
| Individual tab | `[data-testid="tab-bar"] > button` | Each tab is a `<button>` |
| Active tab | `[data-testid="tab-bar"] > button.border-primary` | Has `border-primary` class |
| Tab close icon | Tab button `> span > svg.lucide-x` | Only on closable tabs |
| File tree toggle | `[data-testid="file-tree-toggle"]` | Show/hide left sidebar |
| Chat toggle | `[data-testid="chat-toggle"]` | Show/hide right panel |

Tab types by icon: execution (GitBranch), detail (Play), workflow-editor (violet GitBranch), text-editor (FileCode), image-viewer (green FileImage), schedule (blue Clock).

## Example Code

```js
const results = createResults()
let ws = null
const { browser, page } = await launchBrowser()

try {
  // Setup: create workspace via API
  ws = await createWorkspace("tab-switch-demo")
  record(results, "workspace-created", !!ws.id)

  // Navigate to workspace detail
  const webUrl = resolveWebUrl()
  await navigateTo(page, `${webUrl}/workspaces/${ws.id}`, {
    waitForSelector: '[data-testid="workspace-detail"]',
  })
  record(results, "detail-loaded", true)

  // Read current active tab text
  const tabBar = page.locator('[data-testid="tab-bar"]')
  const activeTab = tabBar.locator("button.border-primary")
  const activeText = await activeTab.textContent()
  record(results, "has-active-tab", !!activeText, `tab="${activeText?.trim()}"`)

  // Count total tabs
  const tabCount = await tabBar.locator("button").count()
  record(results, "tab-count", tabCount > 0, `count=${tabCount}`)

  // Click a specific tab by text content
  const targetTab = tabBar.getByText("执行", { exact: false })
  if (await targetTab.count() > 0) {
    await targetTab.first().click()
    await wait(500)
    record(results, "tab-switched", true)
  } else {
    record(results, "tab-switched", false, "target tab not found")
  }

  // Close a closable tab (click the X icon)
  const closableTabs = tabBar.locator("button:has(svg.lucide-x)")
  if (await closableTabs.count() > 0) {
    const closeIcon = closableTabs.first().locator("span svg.lucide-x")
    await closeIcon.click()
    await wait(300)
    record(results, "tab-closed", true)
  }

  await takeScreenshot(page, "tab-switch-result")

} catch (err) {
  record(results, "unexpected-error", false, err.message)
} finally {
  await closeBrowser(browser)
  if (ws) await cleanupWorkspace(ws.id)
  exitWithResults(results, { title: "Tab Switch E2E" })
}
```

### Handling Unsaved Changes Dialog

```js
// If a tab has unsaved edits (orange ● indicator), closing triggers AlertDialog
const dirtyIndicator = page.locator("text=●")
if (await dirtyIndicator.count() > 0) {
  // Click close on the dirty tab
  // AlertDialog appears: "取消" | "不保存" | "保存"
  await page.getByRole("button", { name: "不保存" }).click()
  await page.waitForSelector('[role="alertdialog"]', { state: "detached" })
}
```

## Pitfalls & Workarounds

- **Default tab**: The workspace detail page always opens with a default execution tab. Tests that expect a specific tab should explicitly click it rather than assuming state.
- **Tab overflow**: The tab bar scrolls horizontally when many tabs are open. Use `tabBar.getByText("name").scrollIntoViewIfNeeded()` before clicking if the tab is off-screen.
- **Close icon vs tab click**: The close `<span>` is nested inside the tab `<button>`. Clicking the X triggers `stopPropagation` — but Playwright clicks on the SVG center, which may land on the parent button. Use `force: true` or target the `<span>` wrapper.
- **Unsaved changes guard**: Closing a tab with dirty state (`●` indicator) triggers an AlertDialog. Always check for dirty state before asserting tab count after close.
- **Context menu**: Right-clicking the tab bar opens a context menu with "关闭其他标签" / "关闭所有标签". Use `page.click('[data-testid="tab-bar"]', { button: "right" })` to trigger it.

## When NOT to Use

- When you only need to verify execution results — use the API (`getExecution`, `pollExecution`) instead of the browser.
- When testing tab persistence across page reloads — that's a state management concern, not a tab UI pattern.
