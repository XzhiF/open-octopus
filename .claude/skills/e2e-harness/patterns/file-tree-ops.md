# Pattern: File Tree Ops

## When to Use

When an E2E test needs to create, rename, or delete files and folders through the sidebar file tree in the workspace detail view. The tree is backed by Yjs CRDT and uses right-click context menus for operations.

## Modules to Import

```js
import { launchBrowser, navigateTo, closeBrowser, clickByTestId, wait, takeScreenshot } from "../lib/browser.mjs"
import { resolveWebUrl } from "../lib/api.mjs"
import { createWorkspace, cleanupWorkspace } from "../lib/workspace.mjs"
import { createResults, record, exitWithResults } from "../lib/reporter.mjs"
```

## Selectors (data-testid)

| Element | Selector | Notes |
|---------|----------|-------|
| File tree toggle | `[data-testid="file-tree-toggle"]` | Show/hide sidebar |
| Tree search input | Sidebar header `input[placeholder="搜索文件..."]` | Fuzzy filter |
| New item button | Sidebar header `button:has(svg.lucide-plus)` | Dropdown trigger |
| Refresh button | Sidebar header `button:has(svg.lucide-refresh-cw)` | Syncs from disk |
| Tree node | Tree area `button` (recursive) | File or directory |
| Context menu | `[data-radix-menu-content]` or `role="menu"` | Right-click menu |
| Create input | Inline `input[placeholder="输入文件名..."]` | Appears in tree |
| Rename input | Inline `input` with current name | Autofocused |
| Delete confirm | `[data-testid="btn-confirm-delete"]` | AlertDialog |
| Delete cancel | `[data-testid="btn-cancel-delete"]` | AlertDialog |

## Example Code

### Create a File via the "+" Dropdown

```js
const results = createResults()
let ws = null
const { browser, page } = await launchBrowser()

try {
  ws = await createWorkspace("file-tree-demo")
  const webUrl = resolveWebUrl()

  await navigateTo(page, `${webUrl}/workspaces/${ws.id}`, {
    waitForSelector: '[data-testid="workspace-detail"]',
  })

  // Ensure file tree sidebar is visible
  const toggleBtn = page.locator('[data-testid="file-tree-toggle"]')
  // If sidebar is hidden, click toggle to show it
  if (await toggleBtn.isVisible()) {
    record(results, "sidebar-visible", true)
  }

  // Click the "+" button in the file tree header to open dropdown
  const plusBtn = page.locator('[class*="border-b"] button:has(svg.lucide-plus)').first()
  await plusBtn.click()
  await wait(300)

  // Click "新建文件" from the dropdown menu
  await page.getByRole("menuitem", { name: "新建文件" }).click()
  await wait(300)

  // Type filename in the inline input and press Enter
  const fileInput = page.locator('input[placeholder="输入文件名..."]')
  await fileInput.fill("e2e-test-workflow.yaml")
  await fileInput.press("Enter")
  await wait(1000) // Wait for Yjs sync

  record(results, "file-created", true, "e2e-test-workflow.yaml")
  await takeScreenshot(page, "file-tree-after-create")

} catch (err) {
  record(results, "unexpected-error", false, err.message)
} finally {
  await closeBrowser(browser)
  if (ws) await cleanupWorkspace(ws.id)
  exitWithResults(results, { title: "File Tree Ops E2E" })
}
```

### Rename + Delete via Context Menu

```js
// --- Rename ---
const fileNode = page.locator("button").filter({ hasText: "e2e-test-workflow.yaml" })
await fileNode.click({ button: "right" })
await wait(300)
await page.getByRole("menuitem", { name: "重命名" }).click()
const renameInput = page.locator("input").filter({ has: page.locator(".focus\\:ring-primary") }).last()
await renameInput.fill("renamed-workflow.yaml")
await renameInput.press("Enter")
await wait(1000)
record(results, "file-renamed", true)

// --- Delete ---
const renamed = page.locator("button").filter({ hasText: "renamed-workflow.yaml" })
await renamed.click({ button: "right" })
await wait(300)
await page.getByRole("menuitem", { name: "删除" }).click()
await clickByTestId(page, "btn-confirm-delete")
await page.waitForSelector('[role="alertdialog"]', { state: "detached", timeout: 5000 })
record(results, "file-deleted", true)
```

## Pitfalls & Workarounds

- **Yjs sync delay**: Always `wait(1000)` after create/rename/delete before asserting tree state.
- **Context menu positioning**: Right-click menu renders at cursor position. Call `scrollIntoViewIfNeeded()` before right-clicking if the node is off-screen.
- **Inline input blur**: Create/rename inputs submit on `blur` or `Enter`; `Escape` cancels. If `fill()` triggers premature blur, use `pressSequentially()`.
- **Directory vs file**: The "+" dropdown offers both at root. Right-click on a directory scopes create to that directory.
- **Delete cascading**: Deleting a directory shows descendant file count in the AlertDialog.
- **Search filter active**: Clear the search input before asserting tree changes — filtered trees hide non-matching nodes.

## When NOT to Use

- When you only need a workflow file for execution — use `createWorkflow()` from `execution.mjs` via API.
- When testing file content editing — open the file in a tab first (see `tab-switch.md`).
- When bulk operations are needed — the UI tree is one-at-a-time; use the API instead.
