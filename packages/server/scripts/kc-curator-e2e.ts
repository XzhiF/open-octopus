/**
 * 知识中心票05 · AC2 真 provider 端到端一次性驱动（反假跑：全程真网络 + 真 Claude SDK）。
 *
 * 仿 llm-wiki-loop e2e 先例「经服务直驱、无需 HTTP server」：不走路由层，直接
 * RawIngestService → CuratorCompileService（LLM seam = provider 生产适配器，
 * Claude SDK 经 ~/.claude/settings.json 真 token）。零真 ~/.octopus 写入——
 * 知识根与 DB 全在 tmp（构造注入，同 S1 测试纪律）。
 *
 * 断言（票面 AC2）：触 ≥3 页 · sources 回指可解析（路径+sha256 对质 raw 文件）·
 * INDEX/LOG/FTS/git 四同步 · 单一 commit。证据（commit hash/触及页清单/耗时）打印进报告。
 *
 * 运行（worktree/仓库 packages/server 下；schema.sql 按 __dirname 读取，须拷进输出目录）：
 *   npx tsup scripts/kc-curator-e2e.ts --format cjs --out-dir dist-scripts --external better-sqlite3
 *   cp src/db/schema.sql dist-scripts/
 *   node dist-scripts/kc-curator-e2e.js
 * 退出码：0 = 全部断言通过；1 = 任一断言失败或 LLM 无响应（如实失败，不降级）。
 */
import Database from "better-sqlite3"
import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { registerProvider, ClaudeSDKProvider } from "@octopus/providers"
import { applySchema } from "../src/db/schema"
import { WikiArticleDAO } from "../src/db/dao/wiki-article-dao"
import { RawIngestService } from "../src/services/knowledge/raw"
import { CuratorCompileService } from "../src/services/knowledge/wiki/curator"
import { createProductionCuratorLLM } from "../src/services/knowledge/wiki/curator-llm"
import { spawnSync } from "child_process"

const GIST_URL = "https://gist.githubusercontent.com/karpathy/442a6bf555914893e9891c11519de94f/raw"

const failures: string[] = []
const notes: string[] = []
function assert(cond: boolean, what: string, detail = ""): void {
  if (cond) { notes.push(`PASS ${what}${detail ? ` — ${detail}` : ""}`) }
  else { failures.push(`FAIL ${what}${detail ? ` — ${detail}` : ""}`) }
}

async function main(): Promise<void> {
  // provider 注册（与 server index.ts L250 同法——直驱脚本不经 server 启动，须自注册）
  registerProvider("claude", () => new ClaudeSDKProvider())
  const t0 = Date.now()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kc-e2e-"))
  const root = path.join(tmp, "knowledge")
  const wikiRoot = path.join(root, "wiki")
  console.log(`[e2e] tmp knowledge root: ${root}`)

  try {
    const db = new Database(":memory:")
    applySchema(db)

    // ① 真网络投喂（票02 通道）：抓 Karpathy llm-wiki gist 原文 → raw/inbox 冻结
    const raw = new RawIngestService({ root })
    const fed = await raw.ingestUrl({ url: GIST_URL })
    console.log(`[e2e] ingest: ${fed.raw.path} bytes=${fed.raw.bytes} hash=${fed.raw.hash.slice(0, 16)}… deduped=${fed.deduped}`)
    assert(!fed.deduped && fed.raw.bytes > 1000, "真文章落 raw（>1KB）", `${fed.raw.bytes}B`)

    // ② 真 provider 编译（sonnet 默认；settings.json 真 token；禁 OCTOPUS_KNOWLEDGE_LLM_DISABLED）
    if (process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED === "1") {
      throw new Error("OCTOPUS_KNOWLEDGE_LLM_DISABLED=1 — 真跑不允许禁用 LLM（防假跑）")
    }
    const curator = new CuratorCompileService({ db, root, llm: createProductionCuratorLLM() })
    const res = await curator.compileRaw(fed.raw)
    const tookMs = Date.now() - t0
    console.log(`[e2e] compile: commit=${res.commit} touched=${res.touched.length} created=${res.created} contradictions=${res.contradictions} 用时=${(tookMs / 1000).toFixed(1)}s`)
    for (const t of res.touched) console.log(`[e2e]   - ${t.path} (${t.type}${t.created ? "·新建" : "·更新"})`)

    assert(res.changed === true && !!res.commit, "编译落 commit", String(res.commit))
    assert(res.touched.length >= 3, "一篇真文章触 ≥3 页（Karpathy 判据下限）", `实触 ${res.touched.length}`)

    // ③ sources 回指可解析断言（机械取出 → 对质 raw 文件实算 hash）
    const srcPage = res.touched.find(t => t.type === "source")
    assert(!!srcPage, "生成 sources 回执页", srcPage?.path ?? "")
    if (srcPage) {
      const text = fs.readFileSync(path.join(wikiRoot, srcPage.path), "utf-8")
      const pM = /^- raw: (raw\/\S+\.md)$/m.exec(text)
      const hM = /^- sha256: ([0-9a-f]{64})$/m.exec(text)
      assert(!!pM && pM[1] === fed.raw.path, "回指 raw 路径逐字可解析", pM?.[1] ?? "")
      const rawText = fs.readFileSync(path.join(root, fed.raw.path), "utf-8")
      const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(rawText)
      const payload = fm ? rawText.slice(fm[0].length) : rawText
      const recomputed = crypto.createHash("sha256").update(payload, "utf-8").digest("hex")
      assert(!!hM && hM[1] === recomputed && hM[1] === fed.raw.hash, "回指 sha256 与 raw 实算互验", hM?.[1]?.slice(0, 16) ?? "")
    }

    // ④ 四同步：INDEX / LOG / FTS(DB) / git
    const index = fs.readFileSync(path.join(wikiRoot, "INDEX.md"), "utf-8")
    assert(index.includes("## ") && res.touched.every(t => index.includes(t.path)), "INDEX 程序化重建含全部触及页")
    const log = fs.readFileSync(path.join(wikiRoot, "LOG.md"), "utf-8")
    assert((log.match(/^## \[/gm) ?? []).length === 1 && log.includes("ingest"), "LOG 一行 ingest 动作（grep 前缀形）")
    const dao = new WikiArticleDAO(db)
    const rows = dao.listByOrg("global")
    assert(rows.length >= 3, "DB 行同步（wiki_articles org=global）", `${rows.length} 行`)
    assert(rows.some(r => r.path === srcPage?.path), "sources 页在 DB 行内", srcPage?.path ?? "")
    assert(dao.searchLike("global", "raw/inbox").some(r => r.domain === "source"), "FTS/LIKE 面可检索到 source 回执", "")
    const gitOut = spawnSync("git", ["log", "--oneline"], { cwd: wikiRoot, encoding: "utf-8" })
    const commits = (gitOut.stdout || "").trim().split(/\r?\n/).filter(Boolean)
    assert(commits.length === 1, "git 单一 commit", commits[0] ?? "(无)")
    const show = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: wikiRoot, encoding: "utf-8" })
    const files = (show.stdout || "").split(/\r?\n/).filter(Boolean)
    assert(files.includes("INDEX.md") && files.includes("LOG.md"), "commit 含 INDEX.md+LOG.md（四同步进同一 commit）")

    console.log(`\n===== E2E 证据 =====\ncommit: ${res.commit}\ntouched(${res.touched.length}):\n${res.touched.map(t => `  ${t.path}`).join("\n")}\nraw: ${fed.raw.path} sha256=${fed.raw.hash}\n用时: ${(tookMs / 1000).toFixed(1)}s\nwarnings: ${res.warnings.join(" | ") || "(无)"}`)
    db.close()
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  console.log(`\n${notes.join("\n")}`)
  if (failures.length > 0) {
    console.log(`\n${failures.join("\n")}\nE2E: FAIL`)
    process.exit(1)
  }
  console.log("\nE2E: ALL PASS")
}

main().catch((err) => {
  console.error(`E2E: ERROR — ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
  process.exit(1)
})
