import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../../db/schema"
import { WikiCompileService, type GitRunner } from "../compile"
import { createLLMRuleFormJudge, createProductionRuleFormJudge } from "../rule-form-judge"
import type { LLMCall } from "../../llm"

/**
 * L6 生产 judge（spec §增长约束 L6「编译时 LLM 判定，warn + 给改写稿」）。
 * S1 缝：createLLMRuleFormJudge(llmCall) — 单测一律 fixture-mocked LLMCall
 * （spec Testing Decisions：不打真模型）；离线安全断言走 callHaiku 的
 * OCTOPUS_KNOWLEDGE_LLM_DISABLED 闸（真模型缺席 ⇒ "" ⇒ 零 issues）。
 * 端到端（compileEntry 带生产适配器）断言外部产物：warnings 含改写稿、
 * commit 照常落库——warn 级绝不阻塞编译（与 L1/L4 的 error 级相对）。
 */

const realGit = (cwd: string): GitRunner => ({
  run(args: string[]) {
    const r = spawnSync("git", args, { cwd, timeout: 30000, env: { ...process.env, OCTOPUS_WIKI_COMMIT_SOURCE: "curate" } })
    return { status: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  },
})

const FM = (id: string) => `---
id: ${id}
domain: projects
title: L6 生产 judge fixture
summary: 验证编译时 LLM 形态判定 warn 不阻塞
topics: [lint]
stability: stable
last_compiled: 2026-10-12
sources: [fixture:ticket-06-fix]
confidence: 0.9
---
`

describe("L6 production rule-form judge", () => {
  let db: Database.Database
  let tmpDir: string
  let root: string

  beforeEach(async () => {
    db = new Database(":memory:")
    applySchema(db)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-l6-judge-"))
    root = path.join(tmpDir, "wiki")
    await new WikiCompileService({ db, org: "testorg", rootDir: root, git: realGit(root) }).compileEntry({
      content: FM("prj-seed") + "\n## 种子\n- 提交前必须跑 pnpm test 全量通过 <!--#oct-901-->\n",
    })
  })

  afterEach(() => {
    db?.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── 适配器契约：模型 JSON 数组 → RuleFormIssue[] ──

  it("模型判定描述句违规 → 逐锚点返回 anchor+suggestion（原型例「implement 通常 30min」→「按 ≥30min 规划预算」）", async () => {
    const seenPrompts: string[] = []
    const fake: LLMCall = async (p) => {
      seenPrompts.push(p)
      return '```json\n[{"anchor":"oct-911","suggestion":"按 ≥30min 规划预算"}]\n```'
    }
    const judge = createLLMRuleFormJudge(fake)
    const issues = await judge([
      { anchor: "oct-911", text: "- implement 通常 30min" },
      { anchor: "oct-912", text: "- 提交前必须跑 pnpm test 全量通过" },
    ])
    expect(issues).toEqual([{ anchor: "oct-911", suggestion: "按 ≥30min 规划预算" }])
    // prompt 携带逐条原文 + 锚点（模型据此回锚点）
    expect(seenPrompts[0]).toContain("oct-911")
    expect(seenPrompts[0]).toContain("implement 通常 30min")
  })

  it("模型输出合法空数组 → 零 issues（全部祈使/事实陈述）", async () => {
    const judge = createLLMRuleFormJudge(async () => "[]")
    expect(await judge([{ anchor: "oct-1", text: "- 提交前跑测试" }])).toEqual([])
  })

  it("离线形态：LLMCall 返回空串/垃圾文本/非数组 JSON → 零 issues，绝不抛错", async () => {
    for (const raw of ["", "服务未配置", "not json at all", '{"anchor":"oct-1"}', "[1,2,3]"]) {
      const judge = createLLMRuleFormJudge(async () => raw)
      expect(await judge([{ anchor: "oct-1", text: "- implement 通常 30min" }])).toEqual([])
    }
  })

  it("LLMCall 抛错（provider 缺席等）→ 零 issues，绝不抛错（warn 级非阻塞纪律）", async () => {
    const judge = createLLMRuleFormJudge(async () => { throw new Error("provider down") })
    await expect(judge([{ anchor: "oct-1", text: "- x" }])).resolves.toEqual([])
  })

  it("越权过滤：未知锚点丢弃、空建议丢弃、非字符串字段丢弃", async () => {
    const judge = createLLMRuleFormJudge(async () =>
      JSON.stringify([
        { anchor: "oct-nope", suggestion: "别条目的建议" },
        { anchor: "oct-1", suggestion: "   " },
        { anchor: "oct-2", suggestion: 123 },
        { anchor: "oct-3", suggestion: "按 ≥30min 规划预算" },
        null,
        "raw string",
      ]),
    )
    const issues = await judge([
      { anchor: "oct-1", text: "- a" },
      { anchor: "oct-2", text: "- b" },
      { anchor: "oct-3", text: "- c" },
    ])
    expect(issues).toEqual([{ anchor: "oct-3", suggestion: "按 ≥30min 规划预算" }])
  })

  it("空规则输入 → 零调用、零 issues", async () => {
    let called = 0
    const judge = createLLMRuleFormJudge(async () => { called++; return "[{\"anchor\":\"oct-1\",\"suggestion\":\"x\"}]" })
    expect(await judge([])).toEqual([])
    expect(called).toBe(0)
  })

  // ── 端到端：生产适配器进 compileEntry ⇒ L6 warn+改写稿，编译照常 commit ──

  it("compileEntry 注入生产适配器：违规行浮出 L6 warn（含改写稿），commit 照常（warn 不阻塞）", async () => {
    const fake: LLMCall = async () => '[{"anchor":"oct-911","suggestion":"按 ≥30min 规划预算"}]'
    const svc = new WikiCompileService({ db, org: "testorg", rootDir: root, git: realGit(root), ruleFormJudge: createLLMRuleFormJudge(fake) })
    const res = await svc.compileEntry({
      content: FM("prj-form-e2e") + "\n## 估算\n- implement 通常 30min <!--#oct-911-->\n",
    })
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)
    const l6 = res.warnings.filter(w => w.includes("L6"))
    expect(l6.length).toBe(1)
    expect(l6[0]).toContain("oct-911")
    expect(l6[0]).toContain("按 ≥30min 规划预算")
  })

  it("judge 中途抛错 → 编译不中断（judgeRuleForms 兜底）", async () => {
    const svc = new WikiCompileService({
      db, org: "testorg", rootDir: root, git: realGit(root),
      ruleFormJudge: async () => { throw new Error("boom") },
    })
    const res = await svc.compileEntry({
      content: FM("prj-form-throw") + "\n## 估算\n- implement 通常 30min <!--#oct-913-->\n",
    })
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(res.warnings.filter(w => w.includes("L6"))).toEqual([])
  })

  // ── 生产对象离线安全：真 callHaiku 在 LLM 禁用闸下 ⇒ 空串 ⇒ 零 issues（不打真模型）──

  it("createProductionRuleFormJudge：OCTOPUS_KNOWLEDGE_LLM_DISABLED=1 时零 issues、不抛错", async () => {
    process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED = "1"
    try {
      const judge = createProductionRuleFormJudge()
      await expect(judge([{ anchor: "oct-1", text: "- implement 通常 30min" }])).resolves.toEqual([])
    } finally {
      delete process.env.OCTOPUS_KNOWLEDGE_LLM_DISABLED
    }
  })
})
