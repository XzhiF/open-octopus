import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as Y from "yjs"
import fs from "fs"
import path from "path"
import os from "os"
import { populateFromDisk, getNestedYMap } from "../services/yjs"

let testDir: string

beforeEach(() => {
  testDir = path.join(os.tmpdir(), `yjs-test-${Date.now()}`)
  fs.mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
})

describe("populateFromDisk", () => {
  it("populates Y.Map with files and directories", () => {
    fs.writeFileSync(path.join(testDir, "README.md"), "# Hello")
    fs.mkdirSync(path.join(testDir, "src"))
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "export {}")

    const doc = new Y.Doc()
    const tree = doc.getMap("fileTree")
    populateFromDisk(testDir, tree)

    expect(tree.has("README.md")).toBe(true)
    expect(tree.has("src")).toBe(true)

    const src = tree.get("src") as Y.Map<unknown>
    expect(src).toBeInstanceOf(Y.Map)
    expect(src.has("index.ts")).toBe(true)

    const readme = tree.get("README.md") as Y.Map<unknown>
    expect(readme.get("content").toString()).toBe("# Hello")
  })

  it("skips hidden files except .claude", () => {
    fs.writeFileSync(path.join(testDir, ".hidden"), "secret")
    fs.mkdirSync(path.join(testDir, ".claude"))
    fs.writeFileSync(path.join(testDir, ".claude", "config.json"), "{}")

    const doc = new Y.Doc()
    const tree = doc.getMap("fileTree")
    populateFromDisk(testDir, tree)

    expect(tree.has(".hidden")).toBe(false)
    expect(tree.has(".claude")).toBe(true)
  })

  it("clears existing entries before populating", () => {
    fs.writeFileSync(path.join(testDir, "old.md"), "old")
    const doc = new Y.Doc()
    const tree = doc.getMap("fileTree")
    populateFromDisk(testDir, tree)
    expect(tree.has("old.md")).toBe(true)

    fs.unlinkSync(path.join(testDir, "old.md"))
    fs.writeFileSync(path.join(testDir, "new.md"), "new")
    populateFromDisk(testDir, tree)
    expect(tree.has("old.md")).toBe(false)
    expect(tree.has("new.md")).toBe(true)
  })
})

describe("getNestedYMap", () => {
  it("creates nested maps for a path", () => {
    const doc = new Y.Doc()
    const root = doc.getMap("root")
    const deep = getNestedYMap(root, ["a", "b", "c"])
    expect(deep).toBeInstanceOf(Y.Map)
    const a = root.get("a") as Y.Map<unknown>
    const b = a.get("b") as Y.Map<unknown>
    expect(b.get("c")).toBe(deep)
  })

  it("reuses existing intermediate maps", () => {
    const doc = new Y.Doc()
    const root = doc.getMap("root")
    const first = getNestedYMap(root, ["x", "y"])
    const second = getNestedYMap(root, ["x", "y"])
    expect(first).toBe(second)
  })
})