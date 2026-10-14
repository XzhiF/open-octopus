// packages/server/src/services/knowledge/__tests__/skill-draft-service.test.ts
//
// P3 票04 — skill 草案服务（S1 主缝；票面第 2/3/4 行，spec 故事 15-17/24）。
//
// 被测面（三路检测 + 对话改写 + 退役 + 卡通知）：
//  * a 路：detectForTask 读素材包 exec-jsonl-excerpt，与既有包语料比 LCS 保序相似 → 模板草案；
//  * c 路：同入口策展提议 LLM seam（prompt 契约进断言，内容质量不进——spec Testing Decisions）；
//  * b 路：detectProceduralCases 只读票03 蒸馏面（status=distilled ∧ rule_ref）判「流程型」→ 草案；
//  * revise/retire：改的是 drafts 文件本体（status 恒 draft / → revoked），wiki/cases/queue 零触碰；
//  * 归档 hook（第⑤步之后）链序与失败吞。
//
// 真 fs+tmpdir 知识根（无 git 仓——本票零 wiki 写，天然不起 git）；LLM 恒 seam mock。
// expected 真相源：票面清单 + spec §skill 草案管线逐字，非实现反推。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import type { KcCardEvent } from "@octopus/shared"
import { freezePackItem, writePackManifest } from "../material-pack"
import { writeDraft, readDraft, type SkillDraftInput } from "../skill-draft-store"
import {
  SkillDraftError,
  SkillDraftService,
  buildSkillProposePrompt,
  buildSkillRevisePrompt,
  parseSkillProposals,
  SKILL_DRAFT_MAX,
  type SkillDraftServiceDeps,
} from "../skill-draft-service"

let tmpRoot: string
let knowledgeRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aa04-svc-"))
  knowledgeRoot = path.join(tmpRoot, "knowledge")
  fs.mkdirSync(knowledgeRoot, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

// ── fixtures ──────────────────────────────────────────────────────────

const EXCERPT_A = [
  "# 执行 JSONL 关键事件摘录",
  "",
  "## exec exec-a1（phase 1 · round 1）",
  "",
  "- [2026-10-14T01:00:05Z] do-a · tool_call :: {\"toolName\":\"Read\",\"isError\":true,\"input\":\"package.json\"}",
  "- [2026-10-14T01:00:31Z] do-a · bash_stderr :: {\"stderr\":\"pnpm build failed: ws missing\"}",
  "- [2026-10-14T01:01:02Z] do-a · agent_event :: {\"event_data\":{\"subtype\":\"tool_result\",\"is_error\":true,\"name\":\"Edit\"}}",
  "- [2026-10-14T01:01:30Z] do-a · tool_call :: {\"toolName\":\"Bash\",\"isError\":true,\"input\":\"pnpm install ws\"}",
].join("\n")

const EXCERPT_B = [
  "## exec exec-b7（phase 2 · round 1）",
  "",
  "- [2026-10-14T05:00:01Z] do-b · tool_call :: {\"toolName\":\"Read\",\"isError\":true,\"input\":\"index.ts\"}",
  "- [2026-10-14T05:00:40Z] do-b · bash_stderr :: {\"stderr\":\"tsc error: ws not found\"}",
  "- [2026-10-14T05:01:11Z] do-b · agent_event :: {\"event_data\":{\"subtype\":\"tool_result\",\"is_error\":true,\"name\":\"Edit\"}}",
  "- [2026-10-14T05:01:55Z] do-b · tool_call :: {\"toolName\":\"Bash\",\"isError\":true,\"input\":\"pnpm add -D @types/ws\"}",
].join("\n")

const EXCERPT_CLEAN = "## exec e（phase 1 · round 1）\n\n- 摘录：（本次执行无关键事件——干净跑完）\n"

/** 种一个最小素材包（a 路只需 excerpt 件；c 路 loadPackForCompile 读活跃件全清单）。 */
function seedPack(taskId: string, items: Array<{ fileName: string; kind: string; payload: string }>): void {
  const manifest = { v: 1 as const, taskId, createdAt: new Date().toISOString(), items: [], recompiles: [] }
  for (const it of items) {
    manifest.items.push(freezePackItem(knowledgeRoot, taskId, {
      fileName: it.fileName,
      kind: it.kind,
      name: it.kind,
      origin: `${it.kind}:${taskId}`,
      title: `${it.kind} task-${taskId}`,
      payload: it.payload,
    }))
  }
  writePackManifest(knowledgeRoot, taskId, manifest)
}

const PROPOSE_OK = JSON.stringify({
  skills: [
    {
      name: "fresh-dist-reinstall",
      description: "dist 残留导致构建陈旧时的清重装流程",
      trigger: "pnpm 重建后产物仍是旧行为",
      steps: ["停服", "删 dist", "pnpm install", "重启并验证"],
      discipline: ["不得热替换运行中的 dist"],
      source: "exec:exec-t1",
    },
  ],
})

function makeService(overrides: Partial<SkillDraftServiceDeps> = {}): { service: SkillDraftService; prompts: string[]; cards: KcCardEvent[] } {
  const prompts: string[] = []
  const cards: KcCardEvent[] = []
  const service = new SkillDraftService({
    root: knowledgeRoot,
    propose: async (p) => { prompts.push(p); return "" },
    revise: async (p) => { prompts.push(p); return "" },
    announceDraft: (ev) => { cards.push(ev) },
    ...overrides,
  })
  return { service, prompts, cards }
}

function draftsDir(): string {
  return path.join(knowledgeRoot, "drafts", "skills")
}

function draftNames(): string[] {
  return fs.existsSync(draftsDir()) ? fs.readdirSync(draftsDir()).sort() : []
}

const CASE_DISTILLED_PROCEDURAL = [
  "---", "id: case-fresh-cache", "domain: cases", "symptom: dist 残留导致构建行为陈旧",
  "tags: [build]", "severity: major", "occurrences: 3", "source: exec:exec-c1",
  "rule_ref: oct-002", "status: distilled", "---", "",
  "## 现场", "", "构建产物仍是旧逻辑。", "",
  "## 诊断", "", "旧 dist 未清。", "",
  "## 根因", "", "构建脚本不清残留。", "",
  "## 修复", "", "处理步骤：先停服删 dist，再重装依赖；按顺序执行不得颠倒。", "",
  "## 教训", "", "清缓存必须走固定流程：停服删装验证四步缺一不可。", "",
].join("\n")

const CASE_DISTILLED_DECLARATIVE = [
  "---", "id: case-keep-colon", "domain: cases", "symptom: Windows 盘符冒号是保留字符",
  "tags: [windows]", "severity: minor", "occurrences: 2", "source: task:aa04-x",
  "rule_ref: oct-003", "status: distilled", "---", "",
  "## 现场", "", "路径拼接报错。", "", "## 诊断", "", "冒号被当分隔符。", "",
  "## 根因", "", "保留字符规则。", "", "## 修复", "", "改用正斜杠路径。", "",
  "## 教训", "", "Windows 下冒号是保留字符。", "",
].join("\n")

const CASE_OPEN_PROCEDURAL = CASE_DISTILLED_PROCEDURAL
  .replace("id: case-fresh-cache", "id: case-not-distilled-yet")
  .replace(/rule_ref: oct-002\n/, "")
  .replace("status: distilled", "status: open")

function seedCaseFile(name: string, content: string): void {
  const abs = path.join(knowledgeRoot, "wiki", "cases", name)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, "utf-8")
}

// ── a 路：跨 task 工具序列相似 ────────────────────────────────────────

describe("检测 a 路：跨 task 工具序列相似（S1·票04 第2行a，spec 故事15）", () => {
  it("两个素材包含同形失败工具序列 ⇒ detectForTask 产出 sequence-similar 草案（drafts/skills/{name}/SKILL.md，front-matter 双来源指针 + similarity + 三段正文）+ 草案卡 created", async () => {
    seedPack("aa04-a", [{ fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: EXCERPT_A }])
    seedPack("aa04-b", [{ fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: EXCERPT_B }])
    const { service, cards } = makeService()

    const outcome = await service.detectForTask("aa04-a")
    expect(outcome.created).toHaveLength(1)
    expect(outcome.created[0]!.origin).toBe("sequence-similar")

    const name = outcome.created[0]!.name
    expect(name).toMatch(/^flow-[0-9a-f]{10}$/)
    expect(readDraft(knowledgeRoot, name)).toBeDefined()
    const text = fs.readFileSync(path.join(draftsDir(), name, "SKILL.md"), "utf-8")
    expect(text).toContain("status: draft")
    expect(text).toContain("origin: sequence-similar")
    expect(text).toContain("source: pack:task-aa04-a; pack:task-aa04-b")
    expect(text).toContain("similarity: 1")
    expect(text).toContain("## 触发条件")
    expect(text).toContain("## 步骤")
    expect(text).toContain("1. read")
    expect(text).toContain("未经授予不生效")

    expect(cards).toHaveLength(1)
    const d = cards[0]!.data as Record<string, unknown>
    expect(cards[0]!.kind).toBe("skill-draft")
    expect(cards[0]!.id).toBe(`skl-${name}`)
    expect(d.action).toBe("created")
    expect(d.origin).toBe("sequence-similar")
    expect(d.status).toBe("draft")
    expect(d.skillPath).toBe(`drafts/skills/${name}/SKILL.md`)
    // 来源指针可点面：两件的 raw 路径在场
    const refs = d.sourceRefs as Array<{ kind: string; pointer: string }>
    expect(refs.map(r => r.pointer).sort()).toEqual([
      "raw/archives/task-aa04-a/03-exec-jsonl-excerpt.md",
      "raw/archives/task-aa04-b/03-exec-jsonl-excerpt.md",
    ])

    // 零 wiki 触碰：知识根下除 drafts/raw 外没有第三个目录（wiki 根本不存在）
    expect(fs.readdirSync(knowledgeRoot).sort()).toEqual(["drafts", "raw"])
  })

  it("b 任务再检同对 ⇒ DUPLICATE_SOURCE 幂等（同来源活跃草案在场不再刷第二份，宁少勿滥）", async () => {
    seedPack("aa04-a", [{ fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: EXCERPT_A }])
    seedPack("aa04-b", [{ fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: EXCERPT_B }])
    const { service } = makeService()
    expect((await service.detectForTask("aa04-a")).created).toHaveLength(1)

    const again = await service.detectForTask("aa04-b")
    expect(again.created).toHaveLength(0)
    expect(again.reasons).toContain("DUPLICATE_SOURCE")
    expect(draftNames()).toHaveLength(1)
  })

  it("序列低于阈值 / 语料不足 ⇒ 零草案零卡（相似 0.25 < 0.6 不出草案）", async () => {
    seedPack("aa04-a", [{ fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: EXCERPT_A }])
    seedPack("aa04-c", [{ fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: [
      "## exec c（phase 1 · round 1）",
      "- [t] do-c · python_stderr :: {\"stderr\":\"KeyError\"}",
      "- [t] do-c · tool_call :: {\"toolName\":\"Read\",\"isError\":true}",
      "- [t] do-c · python_stderr :: {\"stderr\":\"exit\"}",
    ].join("\n") }])
    const { service, cards } = makeService()
    const outcome = await service.detectForTask("aa04-c")
    expect(outcome.created).toHaveLength(0)
    expect(cards).toHaveLength(0)
    expect(draftNames()).toHaveLength(0)
  })

  it("摘录干净跑完 ⇒ 零 LLM 提议仍照跑 c 路闸外？——干净序列不产 a 草案；素材包缺席 ⇒ PACK_NOT_FOUND 零动 LLM", async () => {
    const { service, prompts } = makeService()
    const missing = await service.detectForTask("ghost")
    expect(missing.created).toHaveLength(0)
    expect(missing.reasons).toContain("PACK_NOT_FOUND")
    expect(prompts, "无包不调 LLM").toHaveLength(0)
  })
})

// ── c 路：策展人编译素材包主动提议 ────────────────────────────────────

describe("检测 c 路：策展人编译素材包提议（S1·票04 第2行c，spec 故事15）", () => {
  const seedFullPack = (taskId: string): void => {
    seedPack(taskId, [
      { fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", payload: EXCERPT_CLEAN },
      { fileName: "07-archive-summary.md", kind: "archive-summary", payload: "# 归档总结\n\n做了依赖清理。" },
    ])
  }

  it("提议 seam 产合法草案 JSON ⇒ curator-proposal 草案落盘（name 取提议 slug）+ 卡；prompt 契约=buildSkillProposePrompt 单源（manifest 件路径 + 输出形状词 + task 指针进 prompt，内容质量不钉）", async () => {
    seedFullPack("aa04-t")
    const { service, prompts, cards } = makeService({ propose: async (p) => { prompts.push(p); return PROPOSE_OK } })

    const outcome = await service.detectForTask("aa04-t")
    expect(outcome.created).toHaveLength(1)
    expect(outcome.created[0]!.name).toBe("fresh-dist-reinstall")

    const text = fs.readFileSync(path.join(draftsDir(), "fresh-dist-reinstall", "SKILL.md"), "utf-8")
    expect(text).toContain("status: draft")
    expect(text).toContain("origin: curator-proposal")
    expect(text).toContain("source: exec:exec-t1")
    expect(text).toContain("1. 停服")
    expect(text).toContain("不得热替换运行中的 dist")
    expect(text).toContain("未经授予不生效")

    expect(prompts).toHaveLength(1)
    const pure = buildSkillProposePrompt({
      taskId: "aa04-t",
      packSection: "# 素材包清单（manifest · 先行 · task-aa04-t）",
    })
    expect(prompts[0]).toContain("aa04-t")
    expect(prompts[0]).toContain("skills") // 输出契约 JSON 形状声明
    expect(prompts[0]).toContain("steps")
    expect(prompts[0]).toContain("discipline")
    expect(prompts[0]).toContain(String(SKILL_DRAFT_MAX))
    expect(pure).toContain("skills")
    // 纯函数与服务内调用同入口（promptSection 素材面在场）
    expect(prompts[0]).toContain("03-exec-jsonl-excerpt.md")

    const d = cards[0]!.data as Record<string, unknown>
    expect(d.origin).toBe("curator-proposal")
    expect((d.sourceRefs as Array<Record<string, unknown>>).some(r => String(r.pointer).startsWith("raw/archives/task-aa04-t/"))).toBe(true)
  })

  it("source 不可定位 ⇒ 兜 task:{id} 基底（可定位准入不豁免，同判例面纪律；后缀 #desc 保同批多条不互吞）", async () => {
    seedFullPack("aa04-u")
    const sloppy = JSON.stringify({ skills: [{ description: "d", trigger: "t", steps: ["s"], source: "听来的" }] })
    const { service } = makeService({ propose: async () => sloppy })
    const outcome = await service.detectForTask("aa04-u")
    expect(outcome.created).toHaveLength(1)
    const rec = readDraft(knowledgeRoot, outcome.created[0]!.name)!
    expect(rec.fm.source.startsWith("task:aa04-u")).toBe(true)
  })

  it("坏形/缺 steps 全弃 ⇒ NO_VALID_PROPOSAL 零落盘；空数组 = 诚实无提议零 reason 噪声", async () => {
    seedFullPack("aa04-v")
    const { service: s1 } = makeService({ propose: async () => "这不是 JSON {{{" })
    const r1 = await s1.detectForTask("aa04-v")
    expect(r1.created).toHaveLength(0)
    expect(r1.reasons).toContain("NO_VALID_PROPOSAL")

    const { service: s2 } = makeService({ propose: async () => JSON.stringify({ skills: [{ description: "d", steps: [] }] }) })
    const r2 = await s2.detectForTask("aa04-v")
    expect(r2.created).toHaveLength(0)
    expect(r2.reasons).toContain("NO_VALID_PROPOSAL")

    const { service: s3 } = makeService({ propose: async () => '{"skills":[]}' })
    const r3 = await s3.detectForTask("aa04-v")
    expect(r3.created).toHaveLength(0)
    expect(draftNames()).toHaveLength(0)

    // parseSkillProposals 纯函数同入口（坏条剔除，不整批弃——与判例五段闸不同粒度）
    expect(parseSkillProposals('{"skills":[{"description":"ok","steps":["a"]},{"description":"","steps":["x"]},{"description":"no-steps","steps":[]}]}', "t")).toHaveLength(1)
  })

  it("提议超上限 ⇒ 截到 SKILL_DRAFT_MAX=3（防洪运营参数）", async () => {
    seedFullPack("aa04-w")
    const many = JSON.stringify({ skills: Array.from({ length: 5 }, (_, i) => ({ description: `流程${i}`, steps: [`步${i}`] })) })
    const { service } = makeService({ propose: async () => many })
    const outcome = await service.detectForTask("aa04-w")
    expect(outcome.created).toHaveLength(SKILL_DRAFT_MAX)
  })

  it("提议 seam 抛 ⇒ PROPOSE_FAILED；空串（离线闸形态）⇒ PROPOSE_EMPTY——两路皆零落盘零卡", async () => {
    seedFullPack("aa04-x")
    const { service: s1, cards: c1 } = makeService({ propose: async () => { throw new Error("provider down") } })
    const r1 = await s1.detectForTask("aa04-x")
    expect(r1.reasons).toContain("PROPOSE_FAILED")
    expect(c1).toHaveLength(0)

    const { service: s2 } = makeService({ propose: async () => "" })
    const r2 = await s2.detectForTask("aa04-x")
    expect(r2.reasons).toContain("PROPOSE_EMPTY")
    expect(draftNames()).toHaveLength(0)
  })
})

// ── b 路：判例蒸馏「流程型」转草案（读票03 rule_ref 边）─────────────────

describe("检测 b 路：判例蒸馏流程型 → 草案（S1·票04 第2行b，spec 故事15）", () => {
  it("distilled∧rule_ref∧流程型 ⇒ 草案（source case:{id}/ruleRef 继承/步骤取自修复段）；陈述型与未蒸馏 open 不动；判例文件逐字不改（只读面）", () => {
    seedCaseFile("2026-10-12-case-fresh-cache.md", CASE_DISTILLED_PROCEDURAL)
    seedCaseFile("2026-10-13-case-keep-colon.md", CASE_DISTILLED_DECLARATIVE)
    seedCaseFile("2026-10-14-case-yet.md", CASE_OPEN_PROCEDURAL)
    const before = fs.readFileSync(path.join(knowledgeRoot, "wiki", "cases", "2026-10-12-case-fresh-cache.md"), "utf-8")

    const { service, cards } = makeService()
    const outcome = service.detectProceduralCases()
    expect(outcome.created.map(c => c.name)).toEqual(["flow-case-fresh-cache"])
    expect(outcome.created[0]!.origin).toBe("case-procedural")

    const rec = readDraft(knowledgeRoot, "flow-case-fresh-cache")!
    expect(rec.fm.source).toBe("case:case-fresh-cache")
    expect(rec.fm.caseId).toBe("case-fresh-cache")
    expect(rec.fm.ruleRef).toBe("oct-002")
    expect(rec.body).toContain("dist 残留导致构建行为陈旧")
    expect(rec.body).toContain("停服删 dist")

    const d = cards[0]!.data as Record<string, unknown>
    expect((d.sourceRefs as Array<Record<string, unknown>>)[0]).toMatchObject({ kind: "case", pointer: "cases/2026-10-12-case-fresh-cache.md" })

    // 只读面：判例文件逐字不动；wiki 目录零新增（INDEX 都没有——零 wiki 写零入队）
    expect(fs.readFileSync(path.join(knowledgeRoot, "wiki", "cases", "2026-10-12-case-fresh-cache.md"), "utf-8")).toBe(before)
    expect(fs.existsSync(path.join(knowledgeRoot, "wiki", "INDEX.md"))).toBe(false)

    // 再巡零重复（DUPLICATE_SOURCE 幂等）
    const again = service.detectProceduralCases()
    expect(again.created).toHaveLength(0)
    expect(again.reasons).toContain("DUPLICATE_SOURCE")
  })
})

// ── 对话改写（票面第 4 行）+ 退役 ─────────────────────────────────────

describe("对话修改草案与退役（S1·票04 第4/CRUD 行）", () => {
  const SEED: SkillDraftInput = {
    name: "flow-abc1234567",
    description: "跨 task 重复的依赖修复序列",
    origin: "sequence-similar",
    source: "pack:task-aa04-a; pack:task-aa04-b",
    body: "# 重复操作流\n\n## 触发条件\n\n- 同形失败序列。\n\n## 步骤\n\n1. read\n2. bash\n\n## 纪律\n\n- 草案未经授予不生效。\n",
    createdAt: "2026-10-14T01:00:00.000Z",
    updatedAt: "2026-10-14T01:00:00.000Z",
    similarity: 1,
  }

  it("reviseDraft：prompt 携现行正文+owner 指令；seam 回新正文 ⇒ 文件改写、status 恒 draft、updatedAt 前移、卡刷新 action=revised（再预览）", async () => {
    writeDraft(knowledgeRoot, SEED)
    const { service, prompts, cards } = makeService({
      revise: async (p) => { prompts.push(p); return "# 重复操作流\n\n## 触发条件\n\n- 同形失败序列。\n\n## 步骤\n\n1. read\n2. bash（指数退避重试：1s/2s/4s）\n\n## 纪律\n\n- 草案未经授予不生效。\n" },
    })

    const res = await service.reviseDraft("flow-abc1234567", "步骤 2 加上指数退避的说明")
    expect(res.status).toBe("draft")

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("指数退避")
    expect(prompts[0]).toContain("1. read") // 现行正文进 prompt（改哪里=对话，全稿供改写）
    expect(buildSkillRevisePrompt({ name: "flow-abc1234567", description: SEED.description, currentBody: SEED.body, instruction: "步骤 2 加上指数退避的说明" })).toBe(prompts[0])

    const rec = readDraft(knowledgeRoot, "flow-abc1234567")!
    expect(rec.body).toContain("指数退避重试：1s/2s/4s")
    expect(rec.fm.status).toBe("draft")
    expect(rec.fm.source).toBe("pack:task-aa04-a; pack:task-aa04-b")
    expect(rec.fm.updatedAt > rec.fm.createdAt).toBe(true)

    const d = cards[0]!.data as Record<string, unknown>
    expect(d.action).toBe("revised")
    expect(d.content).toContain("指数退避")
    expect(cards[0]!.id).toBe("skl-flow-abc1234567")
  })

  it("改写失败面全零痕迹：seam 空 REVISE_EMPTY / 抛 REVISE_FAILED / 缺 ## 步骤 REVISE_BAD_SHAPE；未知草案 DRAFT_NOT_FOUND；granted 拒改 DRAFT_GRANTED（红线4 边界）", async () => {
    writeDraft(knowledgeRoot, SEED)
    const before = fs.readFileSync(path.join(draftsDir(), "flow-abc1234567", "SKILL.md"), "utf-8")

    await expect(makeService().service.reviseDraft("flow-abc1234567", "改改")).rejects.toBeInstanceOf(SkillDraftError)
    const { service: sEmpty } = makeService()
    await expect(sEmpty.reviseDraft("flow-abc1234567", "改改")).rejects.toMatchObject({ code: "REVISE_EMPTY", status: 502 })
    const { service: sBoom } = makeService({ revise: async () => { throw new Error("down") } })
    await expect(sBoom.reviseDraft("flow-abc1234567", "改改")).rejects.toMatchObject({ code: "REVISE_FAILED", status: 500 })
    const { service: sBad } = makeService({ revise: async () => "一段散文没有结构" })
    await expect(sBad.reviseDraft("flow-abc1234567", "改改")).rejects.toMatchObject({ code: "REVISE_BAD_SHAPE", status: 502 })
    await expect(makeService().service.reviseDraft("ghost", "x")).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND", status: 404 })

    // granted（票05 领地）拒改
    const abs = path.join(draftsDir(), "flow-abc1234567", "SKILL.md")
    fs.writeFileSync(abs, before.replace("status: draft", "status: granted"), "utf-8")
    const { service: sG } = makeService({ revise: async () => SEED.body })
    await expect(sG.reviseDraft("flow-abc1234567", "改改")).rejects.toMatchObject({ code: "DRAFT_GRANTED", status: 409 })

    expect(fs.readFileSync(abs, "utf-8")).toBe(before.replace("status: draft", "status: granted"))
  })

  it("retireDraft：draft→revoked（留档可溯源）+ 终态卡 action=retired；已退役 409；granted 拒撤 409（撤销授予=票05）；未知 404", () => {
    writeDraft(knowledgeRoot, SEED)
    const { service, cards } = makeService()
    const res = service.retireDraft("flow-abc1234567")
    expect(res.status).toBe("revoked")
    expect(readDraft(knowledgeRoot, "flow-abc1234567")!.fm.status).toBe("revoked")
    expect(cards[0]!.data).toMatchObject({ action: "retired", status: "revoked" })

    expect(() => service.retireDraft("flow-abc1234567")).toThrowError(/^DRAFT_ALREADY_REVOKED/)
    expect(() => service.retireDraft("ghost")).toThrowError(/^DRAFT_NOT_FOUND/)

    const abs = path.join(draftsDir(), "flow-abc1234567", "SKILL.md")
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf-8").replace("status: revoked", "status: granted"), "utf-8")
    expect(() => service.retireDraft("flow-abc1234567")).toThrowError(/^DRAFT_GRANTED/)
  })
})

// ── 归档 hook 链（第⑤步之后；失败吞不阻塞）────────────────────────────

describe("ArchiveIngestService detectSkillDrafts 接位（S1·票04 链序/失败语义）", () => {
  const calls: string[] = []

  async function runHook(extractCases: (() => Promise<unknown>), detectSkillDrafts: (() => Promise<unknown>)) {
    const { ArchiveIngestService } = await import("../../tasks/archive-ingest-service")
    const { TaskHomeService } = await import("../../tasks/task-home-service")
    const { RawIngestService } = await import("../raw")
    const { CompileQueue } = await import("../wiki/compile-queue")
    const Database = (await import("better-sqlite3")).default
    const { applySchema } = await import("../../../db/schema")
    const db = new Database(":memory:")
    applySchema(db)
    db.prepare(`
      INSERT INTO tasks (id, org, name, status, task_spec, authoring_resources, resources, skills, project_ids, version, created_at, updated_at)
      VALUES ('aa04-hook', 'aa04', 'hook 任务', 'archiving', '{"format":"v4","goal":"g","ac":[],"phases":[],"decisions":[]}', '[]', '[]', '[]', '[]', 1, datetime('now'), datetime('now'))
    `).run()
    const q = new CompileQueue()
    calls.length = 0
    const svc = new ArchiveIngestService({
      db,
      taskHomeService: new TaskHomeService(path.join(tmpRoot, "homes")),
      rawIngest: new RawIngestService({ root: knowledgeRoot }),
      queue: q,
      compilePack: async () => undefined,
      summarize: async () => "# 总结\n",
      extractCases: async () => { calls.push("extract"); await extractCases() },
      detectSkillDrafts: async () => { calls.push("detect"); await detectSkillDrafts() },
      announcePack: () => { calls.push("announce-pack") },
    })
    return { svc, q, close: () => db.close() }
  }

  it("链序：素材包→入队→⑤判例提取→草案检测→素材包卡；投喂回执 ingested 不受检测影响", async () => {
    const { svc, q, close } = await runHook(async () => {}, async () => {})
    try {
      const outcome = await svc.ingestTask("aa04-hook")
      expect(outcome.status).toBe("ingested")
      expect(calls).toEqual(["extract", "detect", "announce-pack"])
      expect(q.get("arc-aa04-hook")?.opKind).toBe("archive-compile")
    } finally { close() }
  })

  it("detectSkillDrafts 抛 ⇒ 吞 stderr，回执照 ingested、包卡照发（失败不阻塞 done——红线同律）", async () => {
    const { svc, close } = await runHook(async () => {}, async () => { throw new Error("boom") })
    try {
      await expect(svc.ingestTask("aa04-hook")).resolves.toMatchObject({ status: "ingested" })
      expect(calls).toEqual(["extract", "detect", "announce-pack"])
    } finally { close() }
  })

  it("重归档 deduped 早退 ⇒ 不重检测（零重复草案）", async () => {
    const { svc, close } = await runHook(async () => {}, async () => { throw new Error("must-not-be-called") })
    try {
      await svc.ingestTask("aa04-hook") // 首轮（detect 炸被吞）
      calls.length = 0
      const second = await svc.ingestTask("aa04-hook")
      expect(second.status).toBe("deduped")
      expect(calls).toEqual([])
    } finally { close() }
  })
})

// ── 服务读面直通 store（CRUD 路由的底座）──────────────────────────────

describe("list/read 直通面", () => {
  it("listDrafts 排序全量；readDraft 未知=undefined", () => {
    const { service } = makeService()
    writeDraft(knowledgeRoot, { name: "flow-b", description: "d", origin: "curator-proposal", source: "task:t", body: "## 步骤\n\n1. x", createdAt: "2026-10-14T00:00:00.000Z" })
    writeDraft(knowledgeRoot, { name: "flow-a", description: "d", origin: "curator-proposal", source: "task:t2", body: "## 步骤\n\n1. x", createdAt: "2026-10-14T00:00:00.000Z" })
    expect(service.listDrafts().map(r => r.fm.name)).toEqual(["flow-a", "flow-b"])
    expect(service.readDraft("nope")).toBeUndefined()
    expect(service.readDraft("flow-a")!.relPath).toBe("drafts/skills/flow-a/SKILL.md")
  })
})
