# Pattern: Dialog Interact

## When to Use

When an E2E test needs to open, fill, confirm, or cancel a dialog — including the create-workspace dialog, delete confirmation alerts, and unsaved-changes prompts. All dialogs use Radix UI primitives.

## Modules to Import

```js
import { launchBrowser, navigateTo, closeBrowser, clickByTestId, fillByTestId, wait, takeScreenshot } from "../lib/browser.mjs"
import { resolveWebUrl } from "../lib/api.mjs"
import { createResults, record, exitWithResults } from "../lib/reporter.mjs"
```

## Selectors (data-testid)

| Element | Selector | Notes |
|---------|----------|-------|
| Create workspace trigger | `[data-testid="btn-create-workspace"]` | Button on workspace list page |
| Create dialog container | `[data-testid="create-workspace-dialog"]` | Radix `role="dialog"` |
| Name input | `[data-testid="workspace-name-input"]` | Required field |
| Org select | `[data-testid="workspace-org-select"]` | `<select>` element |
| Submit button | `[data-testid="btn-submit-workspace"]` | Inside DialogFooter |
| Cancel button | `[data-testid="btn-cancel-workspace"]` | Closes dialog |
| Delete confirm (list) | `[data-testid="btn-delete-confirm"]` | AlertDialog action |
| Delete cancel (list) | `[data-testid="btn-delete-cancel"]` | AlertDialog cancel |
| Delete confirm (file) | `[data-testid="btn-confirm-delete"]` | In workspace detail |
| Delete cancel (file) | `[data-testid="btn-cancel-delete"]` | In workspace detail |

Radix dialogs render in a portal at document root. Use role selectors as fallback:
- `[role="dialog"]` — standard Dialog
- `[role="alertdialog"]` — AlertDialog (destructive confirmations)

## Example Code

```js
const results = createResults()
const { browser, page } = await launchBrowser()

try {
  const webUrl = resolveWebUrl()
  await navigateTo(page, `${webUrl}/workspaces`, {
    waitForSelector: '[data-testid="workspace-list"]',
  })
  record(results, "page-loaded", true)

  // Open create dialog
  await clickByTestId(page, "btn-create-workspace")
  await page.waitForSelector('[data-testid="create-workspace-dialog"]', { timeout: 3000 })
  record(results, "dialog-opened", true)

  // Fill form
  await fillByTestId(page, "workspace-name-input", `E2E_HARNESS_TEST_${Date.now()}`)
  await page.selectOption('[data-testid="workspace-org-select"]', "xzf")
  record(results, "form-filled", true)

  // Submit and wait for dialog to close
  await clickByTestId(page, "btn-submit-workspace")
  await page.waitForSelector('[data-testid="create-workspace-dialog"]', {
    state: "detached",
    timeout: 10000,
  })
  record(results, "dialog-submitted", true)

  // Verify workspace appears in list
  await wait(1000)
  await takeScreenshot(page, "dialog-after-create")
  record(results, "workspace-visible", true)

} catch (err) {
  record(results, "unexpected-error", false, err.message)
} finally {
  await closeBrowser(browser)
  exitWithResults(results, { title: "Dialog Interact E2E" })
}
```

### Confirming an AlertDialog

```js
// Trigger delete (e.g., click a card's delete menu item first)
await page.waitForSelector('[role="alertdialog"]', { timeout: 3000 })
await clickByTestId(page, "btn-delete-confirm")
await page.waitForSelector('[role="alertdialog"]', { state: "detached", timeout: 5000 })
record(results, "delete-confirmed", true)
```

## Pitfalls & Workarounds

- **Portal rendering**: Radix dialogs render outside the component tree. Locators like `page.locator('[data-testid="create-workspace-dialog"]')` work, but parent-scoped selectors will fail.
- **Animation timing**: Radix dialogs animate open/close. Always `waitForSelector` with `state: "visible"` after opening and `state: "detached"` after closing.
- **AlertDialog vs Dialog**: Destructive actions (delete) use `AlertDialog` (`role="alertdialog"`). Non-destructive forms use `Dialog` (`role="dialog"`). They have different ARIA roles but share the same portal pattern.
- **Select elements**: The org field is a native `<select>`, not a Radix Select. Use `page.selectOption()`, not `clickByTestId`.
- **Dialog dismissal by Escape**: Pressing `Escape` closes any Radix dialog. Use `page.keyboard.press("Escape")` as a reliable cancel mechanism.

## When NOT to Use

- When the action is purely API-based (creating workspaces for setup/teardown) — use `createWorkspace()` from `workspace.mjs` instead of the UI dialog.
- When testing dialog accessibility — use the a11y-architect agent or Playwright's `axe-core` integration.
