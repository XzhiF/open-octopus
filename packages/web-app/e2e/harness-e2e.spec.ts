// packages/web-app/e2e/harness-e2e.spec.ts
// E2E browser tests for the Harness UI: floating panel, chatbot, and DAG markers.
// Covers AC1–AC5 from R2-01.
import { test, expect, type Page } from "@playwright/test"

const TEST_PAGE = "/dev/harness-test"

// ─── Mock harness events returned by the REST API ────────────────────

const MOCK_HARNESS_EVENTS = [
  {
    id: "he-001",
    event_type: "diagnosis",
    execution_id: "test-exec-harness-001",
    node_id: "bash-build",
    timestamp: Date.now() - 30_000,
    report_json: JSON.stringify({
      detector: "stale-output",
      severity: "warning",
      pattern: "no-output-timeout",
      nodeId: "bash-build",
      evidence: ["No stdout for 15s"],
      context: { nodeDurationMs: 15000 },
    }),
    action_json: null,
    result_json: null,
    severity: "warning",
  },
  {
    id: "he-002",
    event_type: "intervention",
    execution_id: "test-exec-harness-001",
    node_id: "bash-build",
    timestamp: Date.now() - 20_000,
    report_json: null,
    action_json: JSON.stringify({
      type: "retry",
      reason: "Stale output detected",
    }),
    result_json: JSON.stringify("success"),
    severity: null,
  },
  {
    id: "he-003",
    event_type: "intervention",
    execution_id: "test-exec-harness-001",
    node_id: "python-test",
    timestamp: Date.now() - 10_000,
    report_json: null,
    action_json: JSON.stringify({
      type: "inject",
      reason: "Fix test assertion",
    }),
    result_json: JSON.stringify("success"),
    severity: null,
  },
]

/**
 * Install route interceptors before each test so the harness panel
 * receives deterministic mock data instead of hitting a real server.
 */
async function installApiMocks(page: Page) {
  // Mock the historical harness events REST endpoint
  await page.route("**/api/workspaces/test-workspace-harness/harness/events/test-exec-harness-001*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events: MOCK_HARNESS_EVENTS }),
    })
  })

  // Mock the SSE endpoint — immediately abort so the EventSource doesn't hang
  await page.route("**/api/workspaces/test-workspace-harness/executions/events*", async (route) => {
    await route.abort()
  })

  // Mock the harness-intervene POST endpoint (chatbot)
  await page.route("**/api/workspaces/test-workspace-harness/executions/test-exec-harness-001/harness-intervene", async (route) => {
    const request = route.request()
    if (request.method() === "POST") {
      const body = JSON.parse(request.postData() || "{}")
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          message: `已注入指令: ${body.directive?.message ?? ""}`,
        }),
      })
    } else {
      await route.continue()
    }
  })
}

// ─── AC1: Floating panel visible during running execution ──────────

test.describe("AC1: Floating panel visibility", () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page)
    await page.goto(TEST_PAGE)
    await expect(page.getByTestId("harness-test-title")).toBeVisible({ timeout: 30_000 })
  })

  test("harness floating panel is visible when execution is running", async ({ page }) => {
    const panel = page.getByTestId("harness-floating-panel")
    await expect(panel).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: "e2e/__screenshots__/harness-e2e/panel-collapsed.png", fullPage: true })
  })

  test("collapsed panel shows shield emoji and intervention count", async ({ page }) => {
    const collapsed = page.getByTestId("harness-panel-collapsed")
    await expect(collapsed).toBeVisible({ timeout: 10_000 })

    // Shield emoji is rendered
    await expect(collapsed.getByText("🛡️")).toBeVisible()

    // Intervention count (2 interventions in mock data)
    await expect(collapsed.getByText("2")).toBeVisible()

    // Status label — monitoring (no intervention within 10s of mock timestamp may vary)
    const text = await collapsed.textContent()
    expect(text).toMatch(/监控中|干预中/)
  })
})

// ─── AC2: Collapsed state shows intervention count ─────────────────
// (covered above in the collapsed panel test)

// ─── AC3: Expand / collapse toggle ─────────────────────────────────

test.describe("AC3: Expand / collapse toggle", () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page)
    await page.goto(TEST_PAGE)
    await expect(page.getByTestId("harness-test-title")).toBeVisible({ timeout: 30_000 })
  })

  test("clicking collapsed panel expands it and shows 3 tabs", async ({ page }) => {
    // Start collapsed
    const collapsed = page.getByTestId("harness-panel-collapsed")
    await expect(collapsed).toBeVisible({ timeout: 10_000 })

    // Click to expand
    await collapsed.click()

    // Collapsed panel should disappear
    await expect(collapsed).not.toBeVisible()

    // Expanded panel should show the title
    await expect(page.getByText("🛡️ Harness 监控")).toBeVisible()

    // 3 tabs visible: 监控, 明细, Chatbot
    await expect(page.getByRole("tab", { name: "监控" })).toBeVisible()
    await expect(page.getByRole("tab", { name: "明细" })).toBeVisible()
    await expect(page.getByRole("tab", { name: "Chatbot" })).toBeVisible()

    await page.screenshot({ path: "e2e/__screenshots__/harness-e2e/panel-expanded-tabs.png", fullPage: true })
  })

  test("clicking tabs switches content between monitor, detail, and chatbot", async ({ page }) => {
    // Expand
    await page.getByTestId("harness-panel-collapsed").click()

    // Default tab is "monitor" — should show timeline items
    await expect(page.getByText("干预 2次")).toBeVisible({ timeout: 5_000 })

    // Click "明细" tab
    await page.getByRole("tab", { name: "明细" }).click()
    await expect(page.getByText("点击选择事件查看详情")).toBeVisible({ timeout: 5_000 })

    // Click "Chatbot" tab
    await page.getByRole("tab", { name: "Chatbot" }).click()
    await expect(page.getByText("输入干预指令，发送给正在执行的节点")).toBeVisible({ timeout: 5_000 })
  })

  test("collapse button (minus icon) shrinks panel back", async ({ page }) => {
    // Expand
    await page.getByTestId("harness-panel-collapsed").click()
    await expect(page.getByText("🛡️ Harness 监控")).toBeVisible()

    // Click the collapse (minus) button
    const collapseBtn = page.locator('button[title="收起"]')
    await expect(collapseBtn).toBeVisible()
    await collapseBtn.click()

    // Collapsed panel should reappear
    await expect(page.getByTestId("harness-panel-collapsed")).toBeVisible({ timeout: 5_000 })
  })
})

// ─── AC4: Chatbot input and send button ────────────────────────────

test.describe("AC4: Chatbot input and send", () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page)
    await page.goto(TEST_PAGE)
    await expect(page.getByTestId("harness-test-title")).toBeVisible({ timeout: 30_000 })
  })

  test("chatbot shows input field and send button after expanding", async ({ page }) => {
    // Expand → Chatbot tab
    await page.getByTestId("harness-panel-collapsed").click()
    await page.getByRole("tab", { name: "Chatbot" }).click()

    // Input field visible
    const input = page.getByPlaceholder("输入干预指令...")
    await expect(input).toBeVisible({ timeout: 5_000 })

    // Send button visible — scoped to the chatbot tabpanel to avoid Next.js dev tools button
    const chatbotPanel = page.getByRole("tabpanel", { name: "Chatbot" })
    const sendBtn = chatbotPanel.getByRole("button")
    await expect(sendBtn).toBeVisible()
  })

  test("typing and sending a message shows it in chat history", async ({ page }) => {
    // Expand → Chatbot tab
    await page.getByTestId("harness-panel-collapsed").click()
    await page.getByRole("tab", { name: "Chatbot" }).click()

    const input = page.getByPlaceholder("输入干预指令...")
    await expect(input).toBeVisible({ timeout: 5_000 })

    // Type a message
    const testMessage = "请重试这个节点"
    await input.fill(testMessage)

    // Press Enter to send
    await input.press("Enter")

    // User message should appear in the chat area (exact match — system response also contains the text)
    await expect(page.getByText(testMessage, { exact: true })).toBeVisible({ timeout: 5_000 })

    // System response should appear (from mocked API)
    await expect(page.getByText(/已注入指令/)).toBeVisible({ timeout: 10_000 })

    await page.screenshot({ path: "e2e/__screenshots__/harness-e2e/chatbot-message-sent.png", fullPage: true })
  })

  test("send button is disabled when input is empty", async ({ page }) => {
    // Expand → Chatbot tab
    await page.getByTestId("harness-panel-collapsed").click()
    await page.getByRole("tab", { name: "Chatbot" }).click()

    // The send button should be disabled when input is empty
    const chatbotPanel = page.getByRole("tabpanel", { name: "Chatbot" })
    const sendBtn = chatbotPanel.getByRole("button")
    await expect(sendBtn).toBeDisabled()
  })
})

// ─── AC5: DAG node harness markers (🛡️ badges) ────────────────────

test.describe("AC5: DAG node harness markers", () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page)
    await page.goto(TEST_PAGE)
    await expect(page.getByTestId("harness-test-title")).toBeVisible({ timeout: 30_000 })
  })

  test("node with harness_intervening shows shield icon with pulse", async ({ page }) => {
    const section = page.getByTestId("tc-dag-markers")
    await expect(section).toBeVisible()

    const marker = page.getByTestId("harness-marker-intervening")
    await expect(marker).toBeVisible()
    await expect(marker).toHaveAttribute("title", "Harness 正在干预")

    // The ShieldCheck SVG should have animate-pulse class
    const svg = marker.locator("svg")
    await expect(svg).toBeVisible()
    const classes = await svg.getAttribute("class")
    expect(classes).toContain("animate-pulse")
    expect(classes).toContain("text-violet-500")
  })

  test("node with harness_modified shows shield + checkmark", async ({ page }) => {
    const marker = page.getByTestId("harness-marker-modified")
    await expect(marker).toBeVisible()
    await expect(marker).toHaveAttribute("title", "Harness 已修改并重试")

    // Two SVGs: ShieldCheck + CheckCircle2
    const svgs = marker.locator("svg")
    await expect(svgs).toHaveCount(2)
  })

  test("node with harness_executed shows bot icon", async ({ page }) => {
    const marker = page.getByTestId("harness-marker-executed")
    await expect(marker).toBeVisible()
    await expect(marker).toHaveAttribute("title", "Harness Agent 接管执行")

    const svg = marker.locator("svg")
    await expect(svg).toBeVisible()
    const classes = await svg.getAttribute("class")
    expect(classes).toContain("text-rose-500")
  })

  test("node without harness status has no shield marker", async ({ page }) => {
    const node = page.getByTestId("node-no-harness")
    await expect(node).toBeVisible()

    // No shield icon should be present
    const shield = node.locator('[title*="Harness"]')
    await expect(shield).toHaveCount(0)

    await page.screenshot({ path: "e2e/__screenshots__/harness-e2e/dag-markers.png", fullPage: true })
  })
})
