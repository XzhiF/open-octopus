/**
 * 知识中心票10 · AC4 真 provider 端到端一次性驱动（反假跑：全程真网络 provider，零降级）。
 *
 * 仿 kc-curator-e2e.ts 先例「经服务直驱、无需 HTTP server」：不走路由层，直接
 * ArchiveIngestService（summarize seam = createProductionArchiveSummarizer 生产适配器，
 * Claude SDK 真 token）→ 真 wikiWriteQueue（CompileQueue + 真 WikiLock，tmp wiki 根）
 * → 真 CuratorCompileService.compileRaw。零真 ~/.octopus 写入——知识根 / task home /
 * DB 全在 tmp（构造注入，同 S1 测试纪律）。
 *
 * 「归档一个真实 task 的部分」口径：任务行 + 验收账本 + home ADR/notes 为一等
 * 真实形态素材（fixture 构造诚实件），总结与编译全链真 LLM 真 git——
 * 不真连生产库真任务（工作区纪律：不碰真 ~/.octopus）。
 *
 * 断言（票面 AC1-AC4 的脚本面投影）：
 *   ① 总结落 raw/archives/task-{id}-summary.md：冻结头五件套、正文四段齐、hash 实算互验
 *   ② 编译入队 archive-compile（id=arc-{taskId}、label=raw 路径）→ committed，真锁走过且释放
 *   ③ 编译产物：sources 回执页回指 raw 路径 + sha256 互验；wiki 单 commit 落 HEAD；LOG 行存在
 *   ④ 重归档幂等：第二次 ingestTask = deduped 零 LLM 调用、零重入队、零新文件
 *   ⑤ done 判定零触碰声明：归档编排（archiving-service）不在本链，任务 completed_at 不动
 *
 * 运行（worktree/仓库 packages/server 下；schema.sql 按 __dirname 读取，须拷进输出目录）：
 *   npx tsup scripts/kc-archive-ingest-e2e.ts --format cjs --out-dir dist-scripts --external better-sqlite3
 *   cp src/db/schema.sql dist-scripts/
 *   node dist-scripts/kc-archive-ingest-e2e.js
 * 退出码：0 = 全部断言通过；1 = 任一断言失败或 LLM 无响应（如实失败，不降级）。
 */
import Database from "better-sqlite3"
import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { registerProvider, ClaudeSDKProvider } from "@octopus/providers"
import { applySchema } from "../src/db/schema"
import { RawIngestService } from "../src/services/knowledge/raw"
import { CompileQueue } from "../src/services/knowledge/wiki/compile-queue"
import { WikiLock } from "../src/services/knowledge/wiki/wiki-lock"
import { CuratorCompileService } from "../src/services/knowledge/wiki/curator"
import { createProductionCuratorLLM } from "../src/services/knowledge/wiki/curator-llm"
import { TaskHomeService } from "../src/services/tasks/task-home-service"
import {
  ArchiveIngestService,
  archiveCompileTaskId,
  archiveSummaryFileName,
} from "../src/services/tasks/archive-ingest-service"
import { createProductionArchiveSummarizer } from "../src/services/tasks/archive-ingest-llm"
import { spawnSync } from "child_process"

const failures: string[] = []
const notes: string[] = []
function assert(cond: boolean, what: string, detail = ""): void {
  if (cond) { notes.push(`PASS ${what}${detail ? ` — ${detail}` : ""}`) }
  else { failures.push(`FAIL ${what}${detail ? ` — ${detail}` : ""}`) }
}

/** 诚实任务素材（真实形态：两 phase、一轮打回一轮通过、ADR 一件、术语 notes）。 */
function seedHonestTask(db: Database.Database, taskHome: TaskHomeService): string {
  const taskId = "kc10-e2e-task-001"
  const now = new Date().toISOString()
  const home = taskHome.homePath(taskId)
  fs.mkdirSync(path.join(home, "docs", "adr"), { recursive: true })
  fs.writeFileSync(path.join(home, "docs", "adr", "0001-use-server-session.md"), [
    "# 0001 采用服务端 session 替代 JWT",
    "",
    "决定：登录态由服务端 session 表托管，支持后台强制下线。",
    "理由：JWT 无状态与踢下线需求互斥；Redis 引入成本大于 SQLite session 表。",
    "后果：登录中间件需处理 session 过期清 cookie 的路径。",
    "",
  ].join("\n"), "utf-8")
  fs.writeFileSync(path.join(home, "context-notes.md"), [
    "## authsvc",
    "",
    "| 术语 | 定义 |",
    "|------|------|",
    "| session | 服务端会话记录，主键 sid，含 user_id 与过期时间 |",
    "| 强制下线 | 删除 session 行并拒绝后续请求 |",
    "",
  ].join("\n"), "utf-8")
  const spec = {
    format: "v4",
    goal: "把 authsvc 登录流程改为服务端 session 制，支持后台强制下线",
    ac: ["登录成功写 session 并下发 cookie", "后台按用户强制下线即时生效", "session 过期自动清理"],
    decisions: ["D1: 服务端 session 而非 JWT（见 ADR 0001）"],
    branch: "feat-kc10-e2e-20261022",
    phases: [
      { index: 1, name: "session 化改造", slug: "sess", specPath: "./.scratch/kc10-e2e/sess/spec.md", workflowRef: "built-in/task-dev", inputValues: {} },
      { index: 2, name: "强制下线与回归", slug: "kick", specPath: "./.scratch/kc10-e2e/kick/spec.md", workflowRef: "built-in/task-dev", inputValues: {} },
    ],
  }
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, task_spec, authoring_resources, resources, skills,
      project_ids, workflow_ref, version, deleted_at, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, 'archiving', ?, '[]', '[]', '[]', '["authsvc"]', NULL, 1, NULL, ?, ?, NULL)
  `).run(taskId, "kc10-e2e", "authsvc 登录 session 化 + 强制下线", JSON.stringify(spec), now, now)
  const acc = (p: number, r: number, d: string, f?: string) => db.prepare(
    "INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
  ).run(`acc-${p}-${r}`, taskId, p, r, d, f ?? null)
  acc(1, 1, "accepted")
  acc(2, 1, "rejected", "强制下线后旧 session cookie 未清理，同浏览器仍视为在线；补过期清理与即时失效回归")
  acc(2, 2, "accepted")
  return taskId
}

async function main(): Promise<void> {
  registerProvider("claude", () => new ClaudeSDKProvider())
  const t0 = Date.now()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kc10-e2e-"))
  const root = path.join(tmp, "knowledge")
  const wikiRoot = path.join(root, "wiki")
  console.log(`[e2e] tmp knowledge root: ${root}`)
  let db: Database.Database | undefined

  try {
    if (process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED === "1") {
      throw new Error("OCTOPUS_KNOWLEDGE_LLM_DISABLED=1 — 真跑不允许禁用 LLM（防假跑）")
    }
    db = new Database(":memory:")
    applySchema(db)
    const taskHome = new TaskHomeService(path.join(tmp, "homes"))
    const taskId = seedHonestTask(db, taskHome)

    // ① 投喂链装配：真 summarize（生产适配器）+ 真队列（真锁，tmp wiki 根）+ 真 curator 编译
    let llmCalls = 0
    const innerSummarizer = createProductionArchiveSummarizer()
    const summarizer = async (prompt: string) => { llmCalls++; return innerSummarizer(prompt) }
    const queue = new CompileQueue({ lock: new WikiLock({ wikiRoot: () => wikiRoot }) })
    const service = new ArchiveIngestService({
      db,
      taskHomeService: taskHome,
      rawIngest: new RawIngestService({ root }),
      queue,
      compile: async (raw) => {
        const curator = new CuratorCompileService({ db: db!, root, llm: createProductionCuratorLLM() })
        return curator.compileRaw(raw)
      },
      summarize: summarizer,
    })

    const outcome = await service.ingestTask(taskId)
    console.log(`[e2e] ingestTask → ${JSON.stringify(outcome)}`)
    assert(outcome.status === "ingested", "① 总结投喂成功", `raw=${outcome.rawPath}`)
    assert(llmCalls === 1, "① 恰一次 LLM 总结调用", `calls=${llmCalls}`)

    // ① 冻结件断言
    const rawRel = `raw/archives/${archiveSummaryFileName(taskId)}`
    const rawAbs = path.join(root, rawRel)
    assert(fs.existsSync(rawAbs), "① raw/archives/task-{id}-summary.md 在盘")
    let payload = ""
    if (fs.existsSync(rawAbs)) {
      const file = fs.readFileSync(rawAbs, "utf-8")
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(file)
      assert(!!m && m[1].includes(`origin: "task-archive:${taskId}"`) && m[1].includes(`hash: "${outcome.rawHash}"`), "① 冻结头 origin/hash 就位")
      payload = m ? file.slice(m[0].length) : file
      const recomputed = crypto.createHash("sha256").update(payload, "utf-8").digest("hex")
      assert(recomputed === outcome.rawHash, "① hash 与正文实算互验", recomputed.slice(0, 16) + "…")
      for (const sec of ["验收台账", "关键决策", "踩坑", "产出指针"]) {
        assert(new RegExp(`^##+ .*${sec}`, "m").test(payload), `① 总结含小节「${sec}」`)
      }
      assert(payload.includes("强制下线"), "① 总结取材真实素材（打回反馈关键词在场）", "")
    }

    // ② 队列/锁断言
    const qId = archiveCompileTaskId(taskId)
    const settleStart = Date.now()
    let view = queue.get(qId)
    while (view && (view.state === "queued" || view.state === "running") && Date.now() - settleStart < 600_000) {
      await new Promise((r) => setTimeout(r, 1000))
      view = queue.get(qId)
    }
    console.log(`[e2e] queue ${qId}: ${view?.state} op=${view?.opKind} label=${view?.label} err=${view?.error?.code ?? "-"}`)
    assert(view?.opKind === "archive-compile", "② kind=archive-compile（WRITE_OP_KINDS 单源）")
    assert(view?.label === rawRel, "② label=raw 路径")
    assert(view?.state === "committed", "② 编译入队并 committed（真锁串行）", `state=${view?.state}`)
    assert(!fs.existsSync(path.join(wikiRoot, ".compile.lock")), "② 锁已释放（.compile.lock 不在盘）")

    // ③ 编译产物对质
    const stem = archiveSummaryFileName(taskId).replace(/\.md$/, "")
    const srcAbs = path.join(wikiRoot, "sources", `${stem}.md`)
    assert(fs.existsSync(srcAbs), "③ sources 回执页在盘", `sources/${stem}.md`)
    if (fs.existsSync(srcAbs)) {
      const text = fs.readFileSync(srcAbs, "utf-8")
      const pM = /^- raw: (raw\/\S+\.md)$/m.exec(text)
      const hM = /^- sha256: ([0-9a-f]{64})$/m.exec(text)
      assert(pM?.[1] === rawRel, "③ 回指 raw 路径逐字可解析", pM?.[1] ?? "")
      assert(hM?.[1] === outcome.rawHash, "③ 回指 sha256 与 raw 实算互验", hM?.[1]?.slice(0, 16) ?? "")
    }
    const gitOut = spawnSync("git", ["log", "--oneline"], { cwd: wikiRoot, encoding: "utf-8" })
    const commits = (gitOut.stdout || "").trim().split(/\r?\n/).filter(Boolean)
    assert(commits.length >= 1, "③ wiki git 有编译 commit", commits[0] ?? "(无)")
    const logAbs = path.join(wikiRoot, "LOG.md")
    assert(fs.existsSync(logAbs) && fs.readFileSync(logAbs, "utf-8").includes("## ["), "③ LOG.md 时间线行存在")

    // ④ 重归档幂等
    const callsBefore = llmCalls
    const rerun = await service.ingestTask(taskId)
    assert(rerun.status === "deduped" && llmCalls === callsBefore, "④ 重归档 = deduped，零新 LLM 调用", `status=${rerun.status}`)
    assert(queue.list().filter(t => t.id === qId).length === 1, "④ 零重入队（同 arc- id 唯一）")
    assert(fs.readdirSync(path.join(root, "raw", "archives")).length === 1, "④ raw/archives 仍仅一件总结")

    // ⑤ done 判定零触碰声明（本链不经 archiving-service；任务行未被本服务改写）
    const row = db.prepare("SELECT status, completed_at FROM tasks WHERE id = ?").get(taskId) as { status: string; completed_at: string | null }
    assert(row.status === "archiving" && row.completed_at === null, "⑤ 任务状态/完成时间未被投喂链改写（K11 零触碰）")

    const tookMs = Date.now() - t0
    console.log(`\n===== E2E 证据 =====\ntask: ${taskId}\nraw: ${rawRel} sha256=${outcome.rawHash}\nqueue: ${qId} → ${view?.state}\nsources: sources/${stem}.md\ngit: ${commits.join(" / ")}\n用时: ${(tookMs / 1000).toFixed(1)}s\n总结正文预览:\n${payload.split("\n").slice(0, 24).map(l => `  ${l}`).join("\n")}`)
  } finally {
    db?.close()
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
