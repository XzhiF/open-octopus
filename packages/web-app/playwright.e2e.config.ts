import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/system-models.spec.ts",
  fullyParallel: false,
  forbidOnly: false,
  retries: 1,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3500",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
