// 目录窗增量刷新（2026-11-24）：chokidar 监听根目录 → 结构变化 debounce 后回调
// 所在目录（前端收到 cabin SSE `tree_changed` 后静默重拉）。这里只验证「能收到、
// 目录归属正确」；路由侧的 SSE 广播由 cabins 路由覆盖。

import { describe, it, expect, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import { touchTreeWatch, closeAllTreeWatches, activeTreeWatches } from "../services/tree-watch"
import { clearTreeCache } from "../services/local-tree"

afterEach(() => {
  closeAllTreeWatches()
  clearTreeCache()
})

describe("tree-watch · chokidar 增量刷新", () => {
  it("新文件 → debounce 后回调，dirs 指向文件所在目录", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tree-watch-"))
    fs.mkdirSync(path.join(root, "src"), { recursive: true })

    let resolveEvent!: (dirs: string[]) => void
    const event = new Promise<string[]>((resolve) => { resolveEvent = resolve })
    touchTreeWatch(root, (dirs) => resolveEvent(dirs))
    expect(activeTreeWatches().some((r) => path.resolve(r) === path.resolve(root))).toBe(true)

    // chokidar 首轮扫描就绪后再写入（ignoreInitial: true）。
    await new Promise((resolve) => setTimeout(resolve, 600))
    fs.writeFileSync(path.join(root, "src", "Order.java"), "class Order {}\n")

    const dirs = await Promise.race([
      event,
      new Promise<string[]>((_resolve, reject) => setTimeout(() => reject(new Error("watcher timeout")), 5000)),
    ])
    expect(dirs).toContain("src")

    closeAllTreeWatches()
    fs.rmSync(root, { recursive: true, force: true })
  }, 15_000)
})
