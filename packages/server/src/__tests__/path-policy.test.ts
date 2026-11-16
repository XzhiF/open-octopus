// 工作目录路径策略：允许 home 之外的项目目录，只挡系统敏感目录。
// 规则按平台维护（Windows / macOS / Linux），这里只断言当前宿主平台可验证的部分。

import { describe, it, expect, afterAll } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import {
  browseDirectory,
  createDirectory,
  isSensitivePath,
  PathPolicyError,
  resolveSelectableDirectory,
} from "../services/path-policy"

// os.tmpdir() on macOS resolves under /private/var, which the policy (rightly)
// blocks as system-sensitive. Use a home-based temp base instead.
const TEMP_BASE = fs.mkdtempSync(path.join(os.homedir(), ".octopus-path-policy-test-"))

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(TEMP_BASE, prefix))
}

afterAll(() => {
  fs.rmSync(TEMP_BASE, { recursive: true, force: true })
})

describe("path-policy", () => {
  it("文件系统根不能选作 cwd", () => {
    const root = process.platform === "win32" ? `${process.env.SystemDrive ?? "C:"}\\` : "/"
    expect(isSensitivePath(root)).toBe(true)
  })

  it("系统敏感目录被挡住", () => {
    if (process.platform === "win32") {
      const sysRoot = process.env.SystemRoot ?? "C:\\Windows"
      expect(isSensitivePath(sysRoot)).toBe(true)
      expect(isSensitivePath(path.join(sysRoot, "System32"))).toBe(true)
    } else {
      expect(isSensitivePath("/etc")).toBe(true)
      expect(isSensitivePath("/etc/hosts")).toBe(true)
      expect(isSensitivePath("/usr/bin")).toBe(true)
    }
  })

  it("home 下的凭据 / 平台数据目录被挡住", () => {
    expect(isSensitivePath(path.join(os.homedir(), ".ssh"))).toBe(true)
    expect(isSensitivePath(path.join(os.homedir(), ".gnupg"))).toBe(true)
    expect(isSensitivePath(path.join(os.homedir(), ".octopus"))).toBe(true)
  })

  it("普通项目目录（含 home 之外）可选", () => {
    const dir = tempDir("octo-cwd-")
    try {
      expect(isSensitivePath(dir)).toBe(false)
      expect(resolveSelectableDirectory(dir)).toBe(fs.realpathSync(dir))

      const browse = browseDirectory(dir)
      expect(browse.canSelect).toBe(true)
      expect(browse.path).toBe(fs.realpathSync(dir))
      expect(browse.roots.length).toBeGreaterThan(0)
      expect(browse.home).toBe(os.homedir())
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("不存在 / 不是目录会抛 PathPolicyError", () => {
    expect(() => resolveSelectableDirectory(path.join(os.tmpdir(), "octo-definitely-missing-xyz"))).toThrow(PathPolicyError)

    const file = path.join(os.tmpdir(), `octo-file-${Date.now()}.txt`)
    fs.writeFileSync(file, "x")
    try {
      expect(() => resolveSelectableDirectory(file)).toThrow(/不是目录/)
    } finally {
      fs.unlinkSync(file)
    }
  })

  it("browse 只列子目录，过滤文件", () => {
    const root = tempDir("octo-browse-")
    fs.mkdirSync(path.join(root, "a"))
    fs.mkdirSync(path.join(root, "b"))
    fs.writeFileSync(path.join(root, "notes.md"), "x")
    try {
      const res = browseDirectory(root)
      expect(res.dirs.map((d) => d.name)).toEqual(["a", "b"])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("browse 拒绝系统敏感目录", () => {
    const blocked = process.platform === "win32"
      ? (process.env.SystemRoot ?? "C:\\Windows")
      : "/etc"
    expect(() => browseDirectory(blocked)).toThrow(PathPolicyError)
  })
})

describe("createDirectory（目录浏览器新建文件夹）", () => {
  it("在可浏览目录下建一条，并直接返回新目录的 browse DTO", () => {
    const root = tempDir("octo-mkdir-")
    try {
      const res = createDirectory(root, "feature-x")
      expect(res.path).toBe(fs.realpathSync(path.join(root, "feature-x")))
      expect(fs.statSync(res.path).isDirectory()).toBe(true)
      // 前端要能直接落到新目录，不用再请求一次。
      expect(res.browse.path).toBe(res.path)
      expect(res.browse.canSelect).toBe(true)
      expect(browseDirectory(root).dirs.map((d) => d.name)).toEqual(["feature-x"])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("重名 → PATH_EXISTS；名字不合法 → PATH_INVALID_NAME", () => {
    const root = tempDir("octo-mkdir-dup-")
    try {
      createDirectory(root, "same")
      expect(() => createDirectory(root, "same")).toThrow(/已存在/)
      try { createDirectory(root, "same") } catch (err) {
        expect((err as PathPolicyError).code).toBe("PATH_EXISTS")
      }
      for (const bad of ["", ".", "..", "a/b", "a\\b", "  "]) {
        try {
          createDirectory(root, bad)
          throw new Error(`应当拒绝: ${JSON.stringify(bad)}`)
        } catch (err) {
          expect((err as PathPolicyError).code).toBe("PATH_INVALID_NAME")
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("敏感父目录 / 敏感名字被拒（home 下的凭据目录）", () => {
    try {
      createDirectory(os.homedir(), ".ssh")
      throw new Error("应当拒绝 ~/.ssh")
    } catch (err) {
      expect(err).toBeInstanceOf(PathPolicyError)
      expect((err as PathPolicyError).code).toBe("PATH_BLOCKED")
    }
    const blocked = process.platform === "win32"
      ? (process.env.SystemRoot ?? "C:\\Windows")
      : "/etc"
    expect(() => createDirectory(blocked, "x")).toThrow(PathPolicyError)
  })
})
