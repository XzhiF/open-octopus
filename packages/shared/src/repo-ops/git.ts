import { spawnSync } from "child_process"
import { existsSync, mkdirSync } from "fs"
import { join, basename } from "path"

export interface GitResult {
  success: boolean
  message: string
}

function gitSpawn(args: string[], opts: { cwd?: string; timeout?: number }): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? 60_000,
    encoding: "utf-8",
    stdio: "pipe",
  })
  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  }
}

export function cloneProject(
  gitUrl: string,
  group: string,
  name: string,
  branch: string,
  cloneBase: string
): GitResult {
  const dest = join(cloneBase, group, name)

  if (existsSync(dest)) {
    return { success: false, message: `目标目录已存在: ${dest}` }
  }

  mkdirSync(join(cloneBase, group), { recursive: true })

  const r = gitSpawn(["clone", "--branch", branch, gitUrl, dest], { timeout: 120_000 })

  if (r.status === 0) {
    console.log(`✔ ${name} 克隆成功`)
    return { success: true, message: `克隆到 ${dest}` }
  }

  const error = r.stderr
  if (error.includes("Remote branch") && error.includes("not found")) {
    console.error(`✗ 分支 '${branch}' 不存在`)
    return { success: false, message: `分支 '${branch}' 不存在: ${error.slice(0, 200)}` }
  }
  if (error.includes("Authentication failed") || error.includes("could not read Username")) {
    console.error("✗ Git 认证失败 — 请配置 git credential manager 或 SSH")
    return { success: false, message: "Git 认证失败，请配置 credential manager" }
  }
  if (r.status === null) {
    console.error("✗ git 命令未找到")
    return { success: false, message: "git 命令未找到" }
  }
  console.error(`✗ 克隆失败: ${error.slice(0, 200)}`)
  return { success: false, message: `克隆失败: ${error.slice(0, 200)}` }
}

export function pullProject(
  localPath: string,
  targetBranch: string
): GitResult {
  if (!existsSync(localPath)) {
    return { success: false, message: `目录不存在: ${localPath}` }
  }

  if (isDirtyWorkingTree(localPath)) {
    return { success: false, message: "工作目录有未提交的更改，请先 commit 或 stash" }
  }

  const currentBranch = getCurrentBranch(localPath)
  if (currentBranch === null) {
    return { success: false, message: "无法获取当前分支" }
  }

  const name = basename(localPath)

  if (currentBranch === targetBranch) {
    console.log(`拉取: ${name} (${currentBranch})`)
    const r = gitSpawn(["pull", "origin", targetBranch], { cwd: localPath, timeout: 60_000 })
    if (r.status === 0) {
      console.log(`✔ ${name} 已更新`)
      return { success: true, message: `已拉取 ${targetBranch} 的更新` }
    }
    const error = r.status === null ? "git 命令未找到" : r.stderr
    console.warn(`⚠ ${name}: ${error.slice(0, 150)}`)
    return { success: false, message: `拉取失败: ${error.slice(0, 150)}` }
  } else {
    console.log(`切换: ${name} (${currentBranch} → ${targetBranch})`)
    const fetch = gitSpawn(["fetch", "origin", targetBranch], { cwd: localPath, timeout: 30_000 })
    if (fetch.status !== 0) {
      const error = fetch.status === null ? "git 命令未找到" : fetch.stderr
      console.error(`✗ fetch 失败: ${error.slice(0, 150)}`)
      return { success: false, message: `fetch 失败: ${error.slice(0, 150)}` }
    }

    const checkout = gitSpawn(["checkout", targetBranch], { cwd: localPath, timeout: 15_000 })
    if (checkout.status !== 0) {
      const error = checkout.status === null ? "git 命令未找到" : checkout.stderr
      console.error(`✗ checkout 失败: ${error.slice(0, 150)}`)
      return { success: false, message: `checkout 失败: ${error.slice(0, 150)}` }
    }

    const pull = gitSpawn(["pull", "origin", targetBranch], { cwd: localPath, timeout: 60_000 })
    if (pull.status === 0) {
      console.log(`✔ ${name} 切换到 ${targetBranch} 并已更新`)
      return { success: true, message: `切换到 ${targetBranch} 并拉取更新` }
    }
    const error = pull.status === null ? "git 命令未找到" : pull.stderr
    console.warn(`⚠ ${name} checkout 成功但 pull 失败: ${error.slice(0, 150)}`)
    return { success: true, message: `checkout 成功，pull 失败: ${error.slice(0, 150)}` }
  }
}

export function isDirtyWorkingTree(localPath: string): boolean {
  const r = gitSpawn(["status", "--porcelain"], { cwd: localPath, timeout: 10_000 })
  if (r.status !== 0) return true
  return r.stdout !== ""
}

export function getCurrentBranch(localPath: string): string | null {
  const r = gitSpawn(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: localPath, timeout: 10_000 })
  if (r.status !== 0) return null
  return r.stdout
}

function extractGitError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") {
    return "git 命令未找到"
  }
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: string }).stderr
    if (stderr) return stderr
  }
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: string }).message)
  }
  return String(err)
}