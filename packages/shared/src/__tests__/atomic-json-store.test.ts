/**
 * AtomicJsonStore 单元测试
 */
import { describe, it, expect, afterEach } from "vitest"
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { AtomicJsonStore } from "../resource/atomic-json-store"

const TEST_DIR = join(tmpdir(), "atomic-store-test-" + Date.now())

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true })
  }
}

describe("AtomicJsonStore", () => {
  afterEach(cleanup)

  it("写入并读取 JSON 数据", () => {
    mkdirSync(TEST_DIR, { recursive: true })
    const store = new AtomicJsonStore<{ count: number }>(join(TEST_DIR, "test.json"))

    store.write({ count: 42 })
    const data = store.read()
    expect(data.count).toBe(42)
  })

  it("文件不存在时 readOrDefault 返回默认值", () => {
    mkdirSync(TEST_DIR, { recursive: true })
    const store = new AtomicJsonStore<{ value: string }>(join(TEST_DIR, "missing.json"))

    const data = store.readOrDefault({ value: "default" })
    expect(data.value).toBe("default")
  })

  it("写入后创建 .bak 备份文件", () => {
    mkdirSync(TEST_DIR, { recursive: true })
    const filePath = join(TEST_DIR, "backup-test.json")
    const store = new AtomicJsonStore<{ v: number }>(filePath)

    store.write({ v: 1 })
    store.write({ v: 2 })

    // .bak 应该包含第一次写入的内容
    expect(existsSync(`${filePath}.bak`)).toBe(true)
  })

  it("主文件损坏时回退到备份", () => {
    mkdirSync(TEST_DIR, { recursive: true })
    const filePath = join(TEST_DIR, "fallback.json")
    const store = new AtomicJsonStore<{ v: number }>(filePath)

    store.write({ v: 1 })
    store.write({ v: 2 })

    // 破坏主文件
    writeFileSync(filePath, "CORRUPTED", "utf-8")

    const data = store.read()
    expect(data.v).toBe(1) // 从 .bak 恢复
  })

  it("自动创建不存在的目录", () => {
    const deepPath = join(TEST_DIR, "a", "b", "c", "store.json")
    const store = new AtomicJsonStore<{ ok: boolean }>(deepPath)

    store.write({ ok: true })
    expect(store.read().ok).toBe(true)
  })

  it("exists() 正确反映文件状态", () => {
    mkdirSync(TEST_DIR, { recursive: true })
    const store = new AtomicJsonStore<{}>(join(TEST_DIR, "exists.json"))

    expect(store.exists()).toBe(false)
    store.write({})
    expect(store.exists()).toBe(true)
  })
})
