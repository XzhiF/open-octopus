import { defineConfig, devices } from "@playwright/test"

// usage-admin-3 票05 · browser 走查唯一入口（隔离端口经 env 注入，禁默认端口）
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/usage-admin-05.spec.ts",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3339",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
