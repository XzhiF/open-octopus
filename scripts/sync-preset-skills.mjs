#!/usr/bin/env node
/**
 * 知识中心票 14 · 资源预置链回归驱动 —— 把 core-pack 新 skill 文本经
 * **官方 upgrade 原语**（ResourceManager.installOrUpgrade）同步进运行时预置源
 * `~/.octopus/resources/installed/skills/built-in/`。
 *
 * 为什么必须走这个原语（llm-wiki-loop e2e-report addendum D1 教训）：
 *   - 服务重启只做 registerBuiltins() 幽灵自愈（补 registry 行），**不同步预置源
 *     文件内容**；工作区装配（ResourceProvisioner）恰好从预置源复制。
 *   - 直接 cp/rm 预置源目录会绕过 registry/lock/audit 三账，制造「文件新、
 *     台账旧」的静默错配。installOrUpgrade = 删旧→物化→upsert→lock→verify
 *     的既有唯一收口（setup-runner 同通道），本脚本只是它的一次性显式驱动。
 *
 * 默认 **dry-run**（只报漂移，零写入）。真同步 = 显式 `--apply`，且由主控在
 * 集成分支实例（或合入后的主仓实例）上执行 —— 本票测试全程 tmp 假 home，
 * 不碰真 ~/.octopus。
 *
 * 运行（worktree/仓库根；先 pnpm build 产出 shared dist）：
 *   node scripts/sync-preset-skills.mjs                    # dry-run 漂移报告
 *   node scripts/sync-preset-skills.mjs --apply            # 官方原语同步
 *   node scripts/sync-preset-skills.mjs --apply octo-wiki task-author
 *
 * 退出码：0 = dry-run 无漂移 / apply 全部成功；1 = 有漂移未 apply / apply 失败。
 * 注：task-author 分身 fork 资产与 archive persona（clone-tier）不在此面 ——
 * 它们由 server 启动的 CloneInitService 版本化 seed 刷新矩阵自动落盘
 * （sha 未手改 → overwrite from fork），无需本脚本。
 */
import path from "path"
import fs from "fs"
import os from "os"
import { fileURLToPath } from "url"
import { ResourceManager } from "../packages/shared/dist/index.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "..")

const DEFAULT_SKILLS = ["octo-wiki", "task-author"]

async function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes("--apply")
  const positional = argv.filter((a) => a !== "--apply")
  const names = positional.length > 0 ? positional : DEFAULT_SKILLS

  // basePath 默认 = 真 ~/.octopus/resources（ops 面）；测试/演练可用 env 重定向。
  const basePath =
    process.env.OCTOPUS_RESOURCES_BASE ||
    path.join(os.homedir(), ".octopus", "resources")

  const manager = new ResourceManager({
    basePath,
    corePackBase: path.join(repoRoot, "packages", "core-pack"),
  })

  let drift = 0
  for (const name of names) {
    const entry = manager.get("skill", name)
    const installedFile = entry?.installPath
      ? path.join(entry.installPath, "SKILL.md")
      : null
    const sourceFile = path.join(
      repoRoot,
      "packages",
      "core-pack",
      "skills",
      name,
      "SKILL.md"
    )
    if (!fs.existsSync(sourceFile)) {
      console.error(`[FAIL] core-pack 源缺失: ${sourceFile}`)
      drift++
      continue
    }
    const sourceText = fs.readFileSync(sourceFile, "utf-8")
    const installedText =
      installedFile && fs.existsSync(installedFile)
        ? fs.readFileSync(installedFile, "utf-8")
        : null

    const same = installedText !== null && installedText === sourceText
    console.log(
      `${same ? "OK  " : "DRIFT"} skill:${name} → ${entry?.installPath ?? "(未登记)"}`
    )
    if (same) continue
    drift++
    if (!apply) continue

    try {
      const res = await manager.installOrUpgrade({
        ref: `builtin:${name}`,
        type: "skill",
        caller: "cli",
      })
      console.log(`[APPLIED] skill:${name} status=${res.status} → ${res.installPath}`)
    } catch (err) {
      console.error(`[FAIL] skill:${name} — ${err.message}`)
      process.exitCode = 1
    }
  }

  if (!apply) {
    console.log(
      drift > 0
        ? `dry-run：${drift} 项漂移（预置源 ≠ core-pack）。真同步：--apply`
        : "dry-run：预置源与 core-pack 一致，无需同步。"
    )
    process.exitCode = drift > 0 ? 1 : 0
  }
}

main()
