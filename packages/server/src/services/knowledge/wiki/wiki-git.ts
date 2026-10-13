import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"
import { WIKI_LOCK_FILE } from "./wiki-lock"

/**
 * Wiki git helper — 仓库无 git 库依赖（data-plane notes §6），一律 shell-out。
 * spawnSync("git", args, { cwd, timeout }) 先例：workspace-git.ts L109-126；
 * 测试 fixture 建仓方式：workspace-git.test.ts L32-37（init + per-repo config）。
 *
 * 票06（写入单一闸门技术强制）：
 * - spawnGit 默认携带提交来源标记 env（OCTOPUS_WIKI_COMMIT_SOURCE=curate）——
 *   编译/拆分/策展等服务通道全部经它落 commit，hook 认可。
 * - ensureWikiGitRepo 同步安装 pre-commit hook：无标记 = 非策展通道的旁路提交，拒绝；
 *   非 manual 标记而改动触及 user_preference.md，同样拒绝（自动通道永不写 preference）。
 *   已知边界：`git commit --no-verify` 可绕 hook（git 设计使然），闸门防误写不防恶意。
 */

/** 提交来源标记 env 名（hook 校验对象；manual = 人工维护通道）。 */
export const WIKI_COMMIT_SOURCE_ENV = "OCTOPUS_WIKI_COMMIT_SOURCE"

export interface GitResult {
  status: number
  stdout: string
  stderr: string
}

export interface GitRunner {
  run(args: string[]): GitResult
}

/**
 * Default runner: spawnSync with array args (Windows 下 git.exe 按 PATH 解析，无引号问题).
 * `source` 注入提交来源标记（默认 "curate"——所有 wiki 服务写通道同属策展闸门）；
 * 传 "" 则不带标记，模拟终端旁路。
 */
export function spawnGit(cwd: string, timeoutMs = 30000, source: string = "curate"): GitRunner {
  return {
    run(args: string[]): GitResult {
      const r = spawnSync("git", args, {
        cwd,
        timeout: timeoutMs,
        env: source ? { ...process.env, [WIKI_COMMIT_SOURCE_ENV]: source } : process.env,
      })
      return {
        status: r.status ?? 1,
        stdout: r.stdout?.toString() ?? "",
        stderr: r.stderr?.toString() ?? "",
      }
    },
  }
}

/**
 * pre-commit hook（POSIX sh，Git for Windows 用自带 bash 执行，LF 换行）。
 * 期望值逐字承载票06 断言：①无标记=旁路，拒；②非 manual 触及 user_preference.md，拒。
 */
export const WIKI_PRE_COMMIT_HOOK = `#!/bin/sh
# octopus-wiki 票06 — 写入单一闸门（技术强制）：一切进 wiki 的提交须带策展/人工来源标记。
# 策展通道 = WikiCompileService/WikiSplitService/WikiCurateService（spawnGit 自动带标记）；
# 人工维护 = OCTOPUS_WIKI_COMMIT_SOURCE=manual git commit -m "..."
src="\${OCTOPUS_WIKI_COMMIT_SOURCE:-}"
if [ -z "$src" ]; then
  echo "octopus-wiki pre-commit: 拒绝提交 — 缺少提交来源标记 OCTOPUS_WIKI_COMMIT_SOURCE（curate|manual）。" >&2
  echo "  wiki 写入唯一闸门 = 审核队列 approve → 策展编译通道（octo-wiki-curate skill 有完整纪律）。" >&2
  exit 1
fi
if [ "$src" != "manual" ]; then
  if git diff --cached --name-only | grep -qE '(^|/)user_preference\\.md$'; then
    echo "octopus-wiki pre-commit: 拒绝提交 — user_preference.md 永不进入自动写路径（手动维护，需 OCTOPUS_WIKI_COMMIT_SOURCE=manual）。" >&2
    exit 1
  fi
fi
exit 0
`

/** 安装 pre-commit hook（幂等：内容不同才重写；.git 不存在——如纯 git double 场景——静默跳过）。 */
export function installWikiPreCommitHook(root: string): void {
  const gitDir = path.join(root, ".git")
  if (!fs.existsSync(gitDir)) return
  const hookPath = path.join(gitDir, "hooks", "pre-commit")
  try {
    fs.mkdirSync(path.dirname(hookPath), { recursive: true })
    const prev = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf-8") : null
    if (prev !== WIKI_PRE_COMMIT_HOOK) fs.writeFileSync(hookPath, WIKI_PRE_COMMIT_HOOK, "utf-8")
    try { fs.chmodSync(hookPath, 0o755) } catch { /* Windows: git-bash 按 shebang 执行，mode 无碍 */ }
  } catch (err) {
    // hook 装机失败不炸编译（best-effort）；下次 ensureWikiGitRepo 补装
    process.stderr.write(`[wiki-git] pre-commit hook 安装失败: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

/** Run git, throwing on non-zero status with stderr for a readable error. */
export function mustGit(git: GitRunner, args: string[]): GitResult {
  const r = git.run(args)
  if (r.status !== 0) {
    throw new Error(`GIT_FAILED: git ${args.join(" ")} — ${r.stderr.trim() || r.stdout.trim()}`)
  }
  return r
}

/**
 * 票06（wiki 根锁文件）：`.compile.lock` 就在 wiki 仓根、编译 commit 时**在盘**——
 * `git add -A` 若把它扫进提交，锁内容（PID/心跳）会污染仓史且每次 release 留脏删行。
 * 写进 `.git/info/exclude`（本仓工作区排除，不入树、不动 .gitignore），每次 ensure
 * 幂等补装（存量仓升级面同 hook）。锁名单源取 wiki-lock.WIKI_LOCK_FILE。
 */
export function excludeWikiLock(root: string): void {
  const gitDir = path.join(root, ".git")
  if (!fs.existsSync(gitDir)) return
  try {
    const excludePath = path.join(gitDir, "info", "exclude")
    fs.mkdirSync(path.dirname(excludePath), { recursive: true })
    const prev = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf-8") : ""
    if (prev.split(/\r?\n/).includes(WIKI_LOCK_FILE)) return
    const joined = prev === "" || prev.endsWith("\n") ? `${prev}${WIKI_LOCK_FILE}\n` : `${prev}\n${WIKI_LOCK_FILE}\n`
    fs.writeFileSync(excludePath, joined, "utf-8")
  } catch (err) {
    // 排除项装机失败不炸编译（best-effort）；下次 ensureWikiGitRepo 补装
    process.stderr.write(`[wiki-git] .compile.lock 排除项写入失败: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

/**
 * 首编译时把 wiki 根初始化为独立 git 仓库（.git 已存在则跳过 init — 幂等）。
 * 身份写 per-repo git config（fixture 先例同款），不动用户全局配置。
 * 票06：无论新仓老仓，每次都确保 pre-commit hook 就位（存量仓升级面）+ 锁文件排除项。
 */
export function ensureWikiGitRepo(root: string, git: GitRunner): void {
  if (!fs.existsSync(path.join(root, ".git"))) {
    mustGit(git, ["init"])
    mustGit(git, ["config", "user.name", "octopus-curator"])
    mustGit(git, ["config", "user.email", "wiki@octopus.local"])
  }
  installWikiPreCommitHook(root)
  excludeWikiLock(root)
}

/** HEAD hash after a commit; null on empty repo (no commits yet). */
export function wikiHead(git: GitRunner): string | null {
  const r = git.run(["rev-parse", "HEAD"])
  return r.status === 0 ? r.stdout.trim() : null
}
