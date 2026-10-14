// packages/server/src/services/knowledge/wiki/__tests__/wiki-pack-compile.test.ts
//
// P3 票02 — 编译读包（S1 服务层；票面第 3 行：archive-compile 编译读 manifest 先行、
// 按需下钻单件，token 预算纪律）。CuratorCompileService.compilePack 环级测试。
//
// Seam：compilePack(taskId, {focus}) ——真 fs tmpdir 知识根（素材包经票02 契约模块冻结）
// + 内存 sqlite + 真 git（wiki commit）；LLM seam mock 捕获 prompt（spec Testing Decisions
// 「provider 请求捕获」，不连真模型）。S1 断言面：编译输入**含 manifest 而非全包正文**。
// 涉 git ⇒ 本机按纪律 PowerShell 跑。expected 真相源：spec「素材包」+ 票02 票面。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../../../db/schema"
import { CuratorCompileService, type LLMCall } from "../curator"
import type { GitRunner } from "../wiki-git"
import {
  freezePackItem,
  writePackManifest,
  packDigest,
  type MaterialPackManifest,
} from "../../material-pack"

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

const FROZEN_NOW = () => new Date("2026-10-14T08:00:00.000Z")
const TASK_ID = "aa02packtask1"

/** 总结件正文（编译主源；独立 fixture，知识点即计划页素材）。 */
const SUMMARY_TEXT = [
  "# task-aa02 归档总结",
  "",
  "## 验收台账",
  "- phase 1 accepted；phase 2 round1 打回（cookie 未清）round2 accepted",
  "",
  "## 关键决策",
  "- 服务端 session 替代 JWT",
  "",
].join("\n")

/** 大摘录件（超单件预算：尾部有唯一哨兵，断言其不进 prompt；焦点命中时应进）。 */
function bigJsonlText(): string {
  const head = "# 执行 JSONL 关键事件摘录\n\n- [t] do-task · error :: 登录接口 500\n"
  const filler = "噪声填充行：cookie/session/refresh 循环文本 ".repeat(40) // ~1.2KB/行
  let body = ""
  while (Buffer.byteLength(head + body, "utf-8") < 7000) body += filler + "\n"
  return `${head}${body}TAIL_SENTINEL_超预算哨兵ZZZ\n`
}

/** 策展计划 fixture（独立文本；单页 + 要点，够 parseCuratorPlan 过闸）。 */
const PLAN_FIXTURE = JSON.stringify({
  pages: [
    {
      op: "create",
      type: "concept",
      id: "con-session-arch",
      title: "Session 架构",
      summary: "服务端 session 替代 JWT 的决策",
      links: [],
      body: "## 定义\n登录改服务端 session，cookie 清理是打回主因。\n",
    },
  ],
  key_points: ["phase 2 打回原因：强制下线漏清 cookie"],
  contradictions: [],
})

describe("编译读包 compilePack（S1·票02 第3行）", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string
  let wikiRoot: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aa02-packc-"))
    root = path.join(tmpDir, "knowledge")
    wikiRoot = path.join(root, "wiki")
    fs.mkdirSync(root, { recursive: true })
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** 冻结三包件 + manifest（独立构造，不依赖 ingestTask——本测试面=编译读包）。 */
  function seedPack(): MaterialPackManifest {
    const items = [
      freezePackItem(root, TASK_ID, {
        fileName: "01-acceptance-ledger.md", kind: "acceptance-ledger", name: "验收台账",
        origin: `db:task_phase_acceptances:${TASK_ID}`, title: "验收台账", payload: "# 验收台账\n- phase 2 round 1: rejected — 反馈「cookie 未清」\n",
      }),
      freezePackItem(root, TASK_ID, {
        fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", name: "执行 JSONL 关键事件摘录",
        origin: `exec:${TASK_ID}`, title: "JSONL 摘录", payload: bigJsonlText(),
      }),
      freezePackItem(root, TASK_ID, {
        fileName: "07-archive-summary.md", kind: "archive-summary", name: "归档总结",
        origin: `task-archive:${TASK_ID}`, title: "归档总结", payload: SUMMARY_TEXT,
      }),
    ]
    const manifest: MaterialPackManifest = { v: 1, taskId: TASK_ID, createdAt: FROZEN_NOW().toISOString(), items, recompiles: [] }
    writePackManifest(root, TASK_ID, manifest)
    return manifest
  }

  function makeCurator(llm: LLMCall) {
    return new CuratorCompileService({ db, root, llm, now: FROZEN_NOW, git: realGit(wikiRoot) })
  }

  it("manifest 先行、按需下钻：编译 prompt 含素材包清单（逐件 path/kind）与总结件全文，**不含**超预算件正文（哨兵缺席），但显形「未载入…回源读」", async () => {
    const manifest = seedPack()
    const prompts: string[] = []
    const svc = makeCurator(async (p) => { prompts.push(p); return PLAN_FIXTURE })

    const res = await svc.compilePack(TASK_ID)

    expect(prompts).toHaveLength(1)
    const prompt = prompts[0]
    // 读包判据①：清单段恒在（票02 断言面「编译输入含 manifest」）
    expect(prompt).toContain("素材包清单")
    for (const item of manifest.items) {
      expect(prompt, `清单应列出 ${item.kind}`).toContain(item.path)
    }
    // 读包判据②：而非全包正文——超预算件正文哨兵不得出现（票02 S1 逐字）
    expect(prompt).not.toContain("TAIL_SENTINEL_超预算哨兵ZZZ")
    // 缺席显形不静默：件路径 + 未载入说明在 prompt 里
    expect(prompt).toContain("未载入")
    // 编译主源 = 总结件全文（降级为包内一件后仍是 compileRaw 语义的 raw 正文）
    expect(prompt).toContain("服务端 session 替代 JWT 的决策".slice(0, 8)) // 「服务端 session」
    expect(prompt).toContain("# task-aa02 归档总结")

    // 产物面：回执页以包为单元（sources/task-{id}.md），回指包内总结件路径
    expect(res.deduped).toBe(false)
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)
    const touched = res.touched.map(t => t.path)
    expect(touched).toContain("sources/task-aa02packtask1.md")
    expect(touched).toContain("concepts/con-session-arch.md")
    const src = fs.readFileSync(path.join(wikiRoot, "sources", "task-aa02packtask1.md"), "utf-8")
    expect(src).toContain(`raw/archives/task-${TASK_ID}/07-archive-summary.md`)
  })

  it("同包同焦点重编译 ⇒ 幂等快路径 no-op（不调 LLM）；manifest 变化（剔除件）⇒ 放行重编译且被剔件不再进编译输入", async () => {
    const manifest = seedPack()
    let llmCalls = 0
    const prompts: string[] = []
    const svc = makeCurator(async (p) => { llmCalls++; prompts.push(p); return PLAN_FIXTURE })

    const first = await svc.compilePack(TASK_ID)
    expect(first.deduped).toBe(false)
    const second = await svc.compilePack(TASK_ID)
    expect(second.deduped).toBe(true)
    expect(llmCalls).toBe(1)

    // 剔除执行摘录件（人裁素材源，红线3：是策展事实不是审批态）⇒ digest 变 ⇒ 重编译真跑
    const excluded: MaterialPackManifest = {
      ...manifest,
      items: manifest.items.map(i => (i.kind === "exec-jsonl-excerpt" ? { ...i, excluded: true } : i)),
      recompiles: [...manifest.recompiles, { at: FROZEN_NOW().toISOString(), excludePath: "raw/archives/task-aa02packtask1/03-exec-jsonl-excerpt.md", queueTaskId: "arc-x" }],
    }
    expect(packDigest(excluded)).not.toBe(packDigest(manifest))
    writePackManifest(root, TASK_ID, excluded)

    const third = await svc.compilePack(TASK_ID)
    expect(third.deduped).toBe(false)
    expect(llmCalls).toBe(2)
    expect(excluded.items.find(i => i.excluded)?.kind).toBe("exec-jsonl-excerpt")
    // 「同一素材包、manifest 减去被剔件」：重编译输入不再含该件（连清单行都不在）
    expect(prompts[1]).not.toContain("03-exec-jsonl-excerpt.md")
    expect(prompts[1]).toContain("01-acceptance-ledger.md")
  })

  it("焦点下钻：focus=「重点看执行报错那段」⇒ 超预算摘录件命中焦点放宽预算、正文进 prompt；焦点指令逐字进 prompt", async () => {
    seedPack()
    const prompts: string[] = []
    const svc = makeCurator(async (p) => { prompts.push(p); return PLAN_FIXTURE })

    await svc.compilePack(TASK_ID, { focus: "重点看执行报错那段" })

    expect(prompts).toHaveLength(1)
    const prompt = prompts[0]
    // 焦点件取到（票02 故事4：「真能从包里取到那段原始记录再编译」）
    expect(prompt).toContain("TAIL_SENTINEL_超预算哨兵ZZZ")
    // 焦点指令进编译 prompt（S1 seam 断言面）
    expect(prompt).toContain("重点看执行报错那段")
    expect(prompt).toContain("策展焦点指令")
  })

  it("包缺席 ⇒ PACK_NOT_FOUND（编译面历史兼容：旧单文件走 compileRaw 不受影响）", async () => {
    const svc = makeCurator(async () => PLAN_FIXTURE)
    await expect(svc.compilePack("no-such-task")).rejects.toThrow(/PACK_NOT_FOUND/)
  })
})
