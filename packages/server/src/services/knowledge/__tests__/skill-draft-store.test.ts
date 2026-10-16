// packages/server/src/services/knowledge/__tests__/skill-draft-store.test.ts
//
// P3 票04 — skill 草案落盘契约（S1 服务层；票面第 1 行，spec 故事 24）。
//
// 契约（spec §skill 草案管线逐字）：知识根 `drafts/skills/{name}/SKILL.md`——
// 不在 wiki git 仓、不是知识页、不进 INDEX；front-matter 记来源指针
// （素材包 raw/archives/… / exec: / 判例 cases/…）+ `status: draft|granted|revoked`。
// 纯 fs 写（drafts 是待授予过程资产，红线2 wiki 串行队列不适用于此区——
// 但绝不越出 drafts 根、绝不触碰 wiki/cases/raw/人工文件）。
// 幂等：同名草案不静默覆盖（存在则加后缀）；同来源指针活跃草案在场 ⇒ 拒绝重复产出。
//
// expected 真相源：票面 + spec 故事 24 文字，非实现反推。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import os from "os"
import path from "path"
import {
  draftRelPath,
  listDrafts,
  patchDraftBody,
  readDraft,
  retireDraft,
  setDraftGrantState,
  writeDraft,
  type SkillDraftInput,
} from "../skill-draft-store"

let tmpRoot: string
let knowledgeRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aa04-store-"))
  knowledgeRoot = path.join(tmpRoot, "knowledge")
  fs.mkdirSync(knowledgeRoot, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

const BASE: SkillDraftInput = {
  name: "flow-abc1234567",
  description: "跨 task 重复的 cookie 清理修复序列（task-a / task-b，相似 0.75）",
  origin: "sequence-similar",
  source: "pack:task-a; pack:task-b",
  body: [
    "# cookie 清理修复序列",
    "",
    "## 触发条件",
    "",
    "- 登录态接口报 500 且日志含 cookie 字样。",
    "",
    "## 步骤",
    "",
    "1. Read 报错上下文",
    "2. Bash 复现",
    "3. Edit 补清理路径",
    "",
    "## 纪律",
    "",
    "- 草案未经授予不生效；先回源对质再复用。",
  ].join("\n"),
  taskId: "task-a",
  similarity: 0.75,
  createdAt: "2026-10-14T01:00:00.000Z",
  updatedAt: "2026-10-14T01:00:00.000Z",
}

function draftsDir(): string {
  return path.join(knowledgeRoot, "drafts", "skills")
}

describe("drafts 区落盘契约（S1·票04 第1行 / spec 故事24）", () => {
  it("writeDraft ⇒ 知识根 drafts/skills/{name}/SKILL.md；front-matter 含 status: draft + origin + 来源指针；正文逐字；零触碰 wiki", () => {
    const res = writeDraft(knowledgeRoot, BASE)
    expect(res).toEqual({ created: true, name: "flow-abc1234567", path: "drafts/skills/flow-abc1234567/SKILL.md" })

    const abs = path.join(knowledgeRoot, "drafts", "skills", "flow-abc1234567", "SKILL.md")
    const text = fs.readFileSync(abs, "utf-8")
    // front-matter 治理面（票面逐字：来源指针 + status: draft）
    expect(text.startsWith("---\n")).toBe(true)
    expect(text).toContain("name: flow-abc1234567")
    expect(text).toContain("status: draft")
    expect(text).toContain("origin: sequence-similar")
    expect(text).toContain("source: pack:task-a; pack:task-b")
    expect(text).toContain("similarity: 0.75")
    // SKILL.md 正文逐字（name/description/触发条件/步骤/纪律 的载体）
    expect(text).toContain("## 触发条件")
    expect(text).toContain("1. Read 报错上下文")
    expect(text).toContain("草案未经授予不生效")

    // 不在 wiki git 仓 / 不进 INDEX：wiki 根本不存在也永不被建
    expect(fs.existsSync(path.join(knowledgeRoot, "wiki"))).toBe(false)
    // drafts 不在 raw 三目录里（非不可变源件）
    expect(fs.existsSync(path.join(knowledgeRoot, "raw"))).toBe(false)
  })

  it("同名位被占（异来源）⇒ 新草案落 {name}-2 后缀位，第一份逐字节不动（不静默覆盖）", () => {
    writeDraft(knowledgeRoot, BASE)
    const first = fs.readFileSync(path.join(draftsDir(), "flow-abc1234567", "SKILL.md"), "utf-8")

    const other: SkillDraftInput = { ...BASE, source: "pack:task-c; pack:task-d" }
    const res = writeDraft(knowledgeRoot, other)
    expect(res).toEqual({ created: true, name: "flow-abc1234567-2", path: "drafts/skills/flow-abc1234567-2/SKILL.md" })
    expect(fs.readFileSync(path.join(draftsDir(), "flow-abc1234567", "SKILL.md"), "utf-8")).toBe(first)
    expect(fs.existsSync(path.join(draftsDir(), "flow-abc1234567-2", "SKILL.md"))).toBe(true)
  })

  it("同来源指针活跃草案在场 ⇒ DUPLICATE_SOURCE 零新文件（重复检测不刷屏——宁少勿滥）", () => {
    writeDraft(knowledgeRoot, BASE)
    const res = writeDraft(knowledgeRoot, BASE)
    expect(res.created).toBe(false)
    expect(res.reason).toBe("DUPLICATE_SOURCE")
    expect(fs.readdirSync(draftsDir())).toEqual(["flow-abc1234567"])
  })

  it("退役（revoked）草案不挡同来源再提议（撤销是人裁生命周期，不是永久静音）", () => {
    writeDraft(knowledgeRoot, BASE)
    retireDraft(knowledgeRoot, "flow-abc1234567")
    const res = writeDraft(knowledgeRoot, { ...BASE, name: "flow-abc1234567" })
    // 同名目录仍在（revoked 件留档）⇒ 落后缀位，但绝不被 DUPLICATE_SOURCE 拒绝
    expect(res.created).toBe(true)
    expect(res.name).toBe("flow-abc1234567-2")
  })

  it("坏名（大写/斜杠/.. /下划线/空）⇒ INVALID_NAME 零落盘（穿越零容忍）", () => {
    for (const bad of ["Flow-Upper", "a/b", "../../escape", "with_underscore", "", "-lead", "x".repeat(65)] as const) {
      const res = writeDraft(knowledgeRoot, { ...BASE, name: bad })
      expect(res.created, `name='${bad}' 应拒`).toBe(false)
      expect(res.reason).toBe("INVALID_NAME")
    }
    expect(fs.existsSync(draftsDir())).toBe(false)
  })

  it("readDraft/listDrafts 往返：front-matter 全字段可解析、列表按名排序、坏文件跳过不炸", () => {
    writeDraft(knowledgeRoot, BASE)
    writeDraft(knowledgeRoot, { ...BASE, name: "case-flow-b", source: "case:case-msys", origin: "case-procedural", caseId: "case-msys" })

    const list = listDrafts(knowledgeRoot)
    expect(list.map(d => d.fm.name)).toEqual(["case-flow-b", "flow-abc1234567"])

    const one = readDraft(knowledgeRoot, "case-flow-b")!
    expect(one.fm.origin).toBe("case-procedural")
    expect(one.fm.status).toBe("draft")
    expect(one.fm.caseId).toBe("case-msys")
    expect(one.relPath).toBe("drafts/skills/case-flow-b/SKILL.md")
    expect(one.body).toContain("## 步骤")

    // 坏形件（无 front-matter）不进列表、readDraft 拒绝，其余不受影响
    fs.mkdirSync(path.join(draftsDir(), "corrupt"), { recursive: true })
    fs.writeFileSync(path.join(draftsDir(), "corrupt", "SKILL.md"), "没有 front-matter 的裸文本\n", "utf-8")
    expect(listDrafts(knowledgeRoot).map(d => d.fm.name)).toEqual(["case-flow-b", "flow-abc1234567"])
    expect(readDraft(knowledgeRoot, "corrupt")).toBeUndefined()
  })

  it("patchDraftBody（对话改写执行面）：正文替换、status 仍 draft、source/createdAt 保留、updatedAt 前移", () => {
    writeDraft(knowledgeRoot, BASE)
    const before = readDraft(knowledgeRoot, "flow-abc1234567")!

    const res = patchDraftBody(knowledgeRoot, "flow-abc1234567", {
      body: "# 改写后\n\n## 触发条件\n\n- 新触发。\n\n## 步骤\n\n1. 带指数退避重试\n\n## 纪律\n\n- 新纪律。\n",
      description: "改写后的单行描述",
      now: "2026-10-14T02:00:00.000Z",
    })
    expect(res.ok).toBe(true)

    const text = fs.readFileSync(path.join(draftsDir(), "flow-abc1234567", "SKILL.md"), "utf-8")
    expect(text).toContain("status: draft")
    expect(text).toContain("source: pack:task-a; pack:task-b")
    expect(text).toContain("createdAt: 2026-10-14T01:00:00.000Z")
    expect(text).toContain("updatedAt: 2026-10-14T02:00:00.000Z")
    expect(text).toContain("带指数退避重试")
    expect(text).not.toContain("1. Read 报错上下文")
    // 描述更新、name 不变（授予对象锚定名）
    expect(text).toContain("description: 改写后的单行描述")
    expect(text).toContain("name: flow-abc1234567")
    void before
  })

  it("retireDraft：status 行翻 revoked，其余逐字节不动（草案可溯源留档；非审批态——红线3 无 pending）", () => {
    writeDraft(knowledgeRoot, BASE)
    const before = fs.readFileSync(path.join(draftsDir(), "flow-abc1234567", "SKILL.md"), "utf-8")

    const res = retireDraft(knowledgeRoot, "flow-abc1234567")
    expect(res.ok).toBe(true)
    const after = fs.readFileSync(path.join(draftsDir(), "flow-abc1234567", "SKILL.md"), "utf-8")
    expect(after).toContain("status: revoked")
    expect(after.replace("status: revoked", "status: draft")).toBe(before)

    // 再退役 ⇒ DRAFT_ALREADY_REVOKED；不存在 ⇒ DRAFT_NOT_FOUND
    expect(retireDraft(knowledgeRoot, "flow-abc1234567").ok).toBe(false)
    expect(retireDraft(knowledgeRoot, "ghost").ok).toBe(false)
  })

  it("granted 草案（票05 领地）拒绝对话改写与退役（本票零授予 ⇒ 授予面原样留桩不碰）", () => {
    writeDraft(knowledgeRoot, BASE)
    // 手工把 status 翻成 granted（模拟票05 授予后的文件态）——本票服务不得有此写入路径，测试只做读侧断言
    const abs = path.join(draftsDir(), "flow-abc1234567", "SKILL.md")
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf-8").replace("status: draft", "status: granted"), "utf-8")

    const rv = retireDraft(knowledgeRoot, "flow-abc1234567")
    expect(rv.ok).toBe(false)
    expect(rv.reason).toBe("DRAFT_GRANTED")
    const pd = patchDraftBody(knowledgeRoot, "flow-abc1234567", { body: "x", now: "2026-10-14T03:00:00.000Z" })
    expect(pd.ok).toBe(false)
    expect(pd.reason).toBe("DRAFT_GRANTED")
  })

  it("draftRelPath 单源形制（卡面/路由/票05 消费同一公式）", () => {
    expect(draftRelPath("flow-1")).toBe("drafts/skills/flow-1/SKILL.md")
  })
})

// ── P3 票05: granted 态写入面（setDraftGrantState）──────────────────────
// 票04 交接逐字：「granted 写入位=票05 自补（制式：原地翻 status 行其余逐字不动）」；
// 状态机 draft→granted / granted→granted（多分身并授·grantedTo 增删）/ granted→revoked
// （撤至空）。expected 真相源=票05 票面 + 票04 §六插座账，非实现反推。

describe("granted 态写入面（P3 票05·setDraftGrantState）", () => {
  function grantFile(): string {
    return path.join(draftsDir(), "flow-abc1234567", "SKILL.md")
  }

  it("draft→granted：status 行翻位 + grantedTo 行新增 + updatedAt 前移，其余行逐字逐序不动", () => {
    writeDraft(knowledgeRoot, BASE)
    const before = fs.readFileSync(grantFile(), "utf-8").split("\n")

    const res = setDraftGrantState(knowledgeRoot, BASE.name, {
      status: "granted", grantedTo: ["workflow-operator"], now: "2026-10-15T00:00:00.000Z",
    })
    expect(res.ok).toBe(true)

    const after = fs.readFileSync(grantFile(), "utf-8").split("\n")
    const strip = (lines: string[]): string[] =>
      lines.filter(l => !l.startsWith("status:") && !l.startsWith("updatedAt:") && !l.startsWith("grantedTo:"))
    expect(strip(after)).toEqual(strip(before)) // 其余行逐字逐序
    expect(after).toContain("status: granted")
    expect(after).toContain("grantedTo: workflow-operator")
    expect(after).toContain("updatedAt: 2026-10-15T00:00:00.000Z")
    // grantedTo 紧跟 status 行（治理键邻位，制式可断）
    const si = after.findIndex(l => l.startsWith("status:"))
    expect(after[si + 1]).toBe("grantedTo: workflow-operator")
  })

  it("granted→granted：grantedTo 记多值（逗号串）往返 parse；撤到空 ⇒ status→revoked 且 grantedTo 行摘除", () => {
    writeDraft(knowledgeRoot, BASE)
    setDraftGrantState(knowledgeRoot, BASE.name, { status: "granted", grantedTo: ["workflow-operator", "task-doer"], now: "2026-10-15T00:00:00.000Z" })

    const two = readDraft(knowledgeRoot, BASE.name)!
    expect(two.fm.status).toBe("granted")
    expect(two.fm.grantedTo).toEqual(["workflow-operator", "task-doer"])

    const res = setDraftGrantState(knowledgeRoot, BASE.name, { status: "revoked", grantedTo: [], now: "2026-10-16T00:00:00.000Z" })
    expect(res.ok).toBe(true)
    const gone = readDraft(knowledgeRoot, BASE.name)!
    expect(gone.fm.status).toBe("revoked")
    expect(gone.fm.grantedTo).toBeUndefined()
    expect(fs.readFileSync(grantFile(), "utf-8")).not.toContain("grantedTo:")
  })

  it("非法转移矩阵全拒：draft→revoked / revoked→granted / 空 grantedTo 的 granted 拒", () => {
    writeDraft(knowledgeRoot, BASE)
    expect(setDraftGrantState(knowledgeRoot, BASE.name, { status: "revoked", grantedTo: [], now: "x" }).reason)
      .toBe("GRANT_STATE_TRANSITION") // draft 未授不可经授予面撤

    setDraftGrantState(knowledgeRoot, BASE.name, { status: "granted", grantedTo: ["a-clone"], now: "x" })
    setDraftGrantState(knowledgeRoot, BASE.name, { status: "revoked", grantedTo: [], now: "y" })
    expect(setDraftGrantState(knowledgeRoot, BASE.name, { status: "granted", grantedTo: ["a-clone"], now: "z" }).reason)
      .toBe("GRANT_STATE_TRANSITION") // revoked 终态——再授予须重出草案（票04 留档纪律）

    writeDraft(knowledgeRoot, { ...BASE, name: "flow-second", source: "pack:task-c; pack:task-d" })
    expect(setDraftGrantState(knowledgeRoot, "flow-second", { status: "granted", grantedTo: [], now: "z" }).reason)
      .toBe("GRANT_STATE_CONFLICT") // granted 恒带至少一个目标（不变量）

    expect(setDraftGrantState(knowledgeRoot, "ghost-draft", { status: "granted", grantedTo: ["x"], now: "z" }).reason)
      .toBe("DRAFT_NOT_FOUND")
  })

  it("存量票04 草案（无 grantedTo 行）读面零破坏 + granted 态拒对话改写（边界互斥复证）", () => {
    writeDraft(knowledgeRoot, BASE)
    const legacy = readDraft(knowledgeRoot, BASE.name)!
    expect(legacy.fm.grantedTo).toBeUndefined()

    setDraftGrantState(knowledgeRoot, BASE.name, { status: "granted", grantedTo: ["workflow-operator"], now: "2026-10-15T00:00:00.000Z" })
    expect(patchDraftBody(knowledgeRoot, BASE.name, { body: "x", now: "2026-10-15T01:00:00.000Z" }).reason).toBe("DRAFT_GRANTED")
    expect(retireDraft(knowledgeRoot, BASE.name).reason).toBe("DRAFT_GRANTED")
  })
})
