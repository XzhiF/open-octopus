// packages/server/vitest.config.ts
// retro④：真 git/DB 重试用例在全量并发负载下顶穿默认 5s（tasks-takeover / tasks-ledger-columns 实测抖动）。
// server 包级放闸 20s：只放宽挂起上限，不改变任何断言。
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
