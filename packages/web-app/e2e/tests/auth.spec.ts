// packages/web-app/e2e/tests/auth.spec.ts
// E2E auth tests — login, register, logout, route protection.
import { test, expect } from "@playwright/test"

test.describe("Authentication", () => {
  test("redirects to /login when not authenticated", async ({ page }) => {
    await page.goto("/")
    await expect(page).toHaveURL(/\/login/)
  })

  test("login page shows login form", async ({ page }) => {
    await page.goto("/login")
    await expect(page.getByRole("tab", { name: "登录" })).toBeVisible()
    await expect(page.getByRole("tab", { name: "注册" })).toBeVisible()
    await expect(page.getByLabel("用户名")).toBeVisible()
    await expect(page.getByLabel("密码")).toBeVisible()
    await expect(page.getByRole("button", { name: "登录" })).toBeVisible()
  })

  test("can switch to register tab", async ({ page }) => {
    await page.goto("/login")
    await page.getByRole("tab", { name: "注册" }).click()
    await expect(page.getByLabel("邮箱（可选）")).toBeVisible()
    await expect(page.getByRole("button", { name: "注册" })).toBeVisible()
  })

  test("shows GitHub login button", async ({ page }) => {
    await page.goto("/login")
    await expect(page.getByRole("link", { name: /GitHub/ })).toBeVisible()
  })

  test("register and login flow", async ({ page }) => {
    // Register a new user
    await page.goto("/login")
    await page.getByRole("tab", { name: "注册" }).click()

    await page.getByLabel("用户名").fill("e2e_test_user")
    await page.getByLabel("密码").fill("e2e_test_password_123")
    await page.getByRole("button", { name: "注册" }).click()

    // Should redirect to dashboard after successful registration
    await expect(page).toHaveURL("/", { timeout: 10000 })

    // Should see the user menu with the username
    await expect(page.getByText("e2e_test_user")).toBeVisible()
  })

  test("login with existing user", async ({ page }) => {
    // First register
    await page.goto("/login")
    await page.getByRole("tab", { name: "注册" }).click()
    await page.getByLabel("用户名").fill("login_test_user")
    await page.getByLabel("密码").fill("login_test_password_123")
    await page.getByRole("button", { name: "注册" }).click()
    await expect(page).toHaveURL("/", { timeout: 10000 })

    // Logout
    await page.getByRole("button", { name: /login_test_user/ }).click()
    await page.getByText("退出登录").click()
    await expect(page).toHaveURL(/\/login/, { timeout: 10000 })

    // Login again
    await page.getByLabel("用户名").fill("login_test_user")
    await page.getByLabel("密码").fill("login_test_password_123")
    await page.getByRole("button", { name: "登录" }).click()
    await expect(page).toHaveURL("/", { timeout: 10000 })
  })

  test("login with wrong password shows error", async ({ page }) => {
    await page.goto("/login")
    await page.getByLabel("用户名").fill("nonexistent_user")
    await page.getByLabel("密码").fill("wrong_password")
    await page.getByRole("button", { name: "登录" }).click()

    // Should see error message
    await expect(page.getByText(/用户名或密码错误/)).toBeVisible({ timeout: 5000 })
    // Should still be on login page
    await expect(page).toHaveURL(/\/login/)
  })

  test("header shows user info after login", async ({ page }) => {
    // Register
    await page.goto("/login")
    await page.getByRole("tab", { name: "注册" }).click()
    await page.getByLabel("用户名").fill("header_test_user")
    await page.getByLabel("密码").fill("header_test_pass_123")
    await page.getByRole("button", { name: "注册" }).click()
    await expect(page).toHaveURL("/", { timeout: 10000 })

    // Check header shows user info
    await expect(page.getByText("header_test_user")).toBeVisible()
  })
})
