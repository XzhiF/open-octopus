// 工作目录路径策略：允许 home 之外的项目目录，只挡系统敏感目录。
// 规则按平台维护（Windows / macOS / Linux），这里只断言当前宿主平台可验证的部分。

import { describe, it, expect } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import {
  browseDirectory,
  isSensitivePath,
  PathPolicyError,
  resolveSelectableDirectory,
} from "../services/path-policy"

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

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
