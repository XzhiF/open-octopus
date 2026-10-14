// packages/server/src/services/knowledge/__tests__/skill-grant-service.test.ts
//
// P3 票05 — 授予/撤销机械链 S1 服务层缝（spec §skill 草案管线「授予机械链」逐字；
// 故事 18-23）。
//
// Seam: SkillGrantService.grant/revoke 的**外部产物**——
//  ① 目标层文件（分身技能目录 / 共享技能层，ADR-0005 两层）
//  ② 运行时预置源（官方 upgrade 原语 installOrUpgrade 的三账+文件：registry/lock/audit）
//  ③ agent_versions 发布（DB 行 + versions 目录快照保真 + 现行版指针）
//  ④ 草案状态翻面（drafts 区 granted/revoked + grantedTo 清单）
//  ⑤ 回执卡/回执形状（分身名/版本号/预置源同步结果）
//  ⑥ 边界负断言：零 wiki 写队列旁路（假 home 逐字节对拍法——票04 grant-negative 同构）
//
// expected 真相源=票面逐字 + spec 故事 18-23 + 全局坑单（快照保真坑、copyDirOverwrite
// 不清目录坑、previous_version null 桩坑——处理面见回滚用例），非实现反推。
// LLM 零参与（机械链确定性，票04 §六.7 交接）；真 ~ 零触碰（OCTOPUS_HOME 换轨）。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { ResourceManager } from "@octopus/shared"
import { applySchema } from "../../../db/schema"
import { AgentVersionDAO } from "../../../db/dao/agent-version-dao"
import { AgentVersionService } from "../../agent/agent-version-service"
import { writeDraft, readDraft, type SkillDraftInput } from "../skill-draft-store"
import { SkillGrantService } from "../skill-grant-service"

const DRAFT: SkillDraftInput = {
  name: "flow-reinstall",
  description: "报错重装流程（授予演示件）",
  origin: "curator-proposal",
  source: "exec:ex-grant",
  body: [
    "# 报错重装流程",
    "",
    "## 触发条件",
    "",
    "- 依赖重装反复报错。",
    "",
    "## 步骤",
    "",
    "1. 停服",
    "2. 删 dist",
    "3. 重装并验证",
    "",
    "## 纪律",
    "",
    "- 草案未经授予不生效。",
  ].join("\n"),
  createdAt: "2026-10-14T01:00:00.000Z",
  updatedAt: "2026-10-14T01:00:00.000Z",
}

let tmpRoot: string
let knowledgeRoot: string
let fakeHome: string
let prevHome: string | undefined
let db: Database.Database
let versionDao: AgentVersionDAO
let versionService: AgentVersionService
let manager: ResourceManager
let events: Array<{ id: string; action?: string }>

function j(...segs: string[]): string {
  return path.join(fakeHome, ...segs)
}

function mk(clonePath: string, files: Record<string, string>): void {
  const abs = j(...clonePath.split("/"))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(abs, { recursive: true })
    fs.writeFileSync(path.join(abs, f), c, "utf-8")
  }
}

function newService(): SkillGrantService {
  return new SkillGrantService({
    root: knowledgeRoot,
    manager: () => manager,
    versionService: () => versionService,
    announce: (event) => { events.push({ id: event.id, action: (event.data as { action?: string }).action }) },
    now: () => new Date("2026-10-15T08:00:00.000Z"),
  })
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aa05-grant-"))
  knowledgeRoot = path.join(tmpRoot, "knowledge")
  fs.mkdirSync(knowledgeRoot, { recursive: true })
  fakeHome = path.join(tmpRoot, "home")
  // 假 home 预置：两层技能目录位 + 三个目标分身（versioned built-in / 非 versioned
  // built-in / user clone）+ 预置源根。workflow-operator 的 1.0.0 首发模拟启动种子。
  // config.json 形状=真盘单源（clone-init-service 436-448 整包写 cloneDef：
  // versioned 在 **config 嵌套位**）——D-aa16-1（票09 E2E 实锤）：旧 fixture 顶层形
  // 与实现互相抄，真盘嵌套形永不命中 ⇒ 授予恒不发版。fixture 换成落盘真相形。
  mk("agent/built-in/workflow-operator", { "config.json": JSON.stringify({ name: "workflow-operator", display_name: "工作流工程师", type: "built-in", skills: ["octo-wiki"], memoryScope: "isolated", config: { versioned: true } }) })
  mk("agent/built-in/task-doer", { "config.json": JSON.stringify({ skills: [] }) })
  mk("agent/clones/worker-u", { "config.json": JSON.stringify({}) })
  fs.mkdirSync(j("agent/skills"), { recursive: true })
  fs.mkdirSync(j("resources"), { recursive: true })
  prevHome = process.env.OCTOPUS_HOME
  process.env.OCTOPUS_HOME = fakeHome

  db = new Database(":memory:")
  applySchema(db)
  // 坑（本票实锤，报 notes-aa-05）：applySchema 的 ensureColumnsForExistingTables 跑在
  // schema.sql 建表**之前**——首建库 clones.current_version_id 缺席（重启一次才自愈）。
  // rollback/publish 指针写会炸。测试面按生产稳态补列（PRAGMA 幂等防双加）。
  const cloneCols = db.prepare("PRAGMA table_info(clones)").all() as { name: string }[]
  if (!cloneCols.some(c => c.name === "current_version_id")) {
    db.exec("ALTER TABLE clones ADD COLUMN current_version_id TEXT")
  }
  versionDao = new AgentVersionDAO(db)
  versionService = new AgentVersionService(versionDao)
  versionService.publish("workflow-operator", { version: "1.0.0", stage: "stable", changelog: "seed" })

  manager = new ResourceManager({ basePath: j("resources") })
  events = []
  writeDraft(knowledgeRoot, DRAFT)
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.OCTOPUS_HOME
  else process.env.OCTOPUS_HOME = prevHome
  db.close()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe("授予单分身窄口机械链（票05 第1行；版本化分身=全链）", () => {
  it("grant(workflow-operator)：分身技能目录落件（front-matter 只留 name/description）+ installOrUpgrade 三账同步预置源 + agent_versions 发版（快照含授予件）+ 草案→granted + 回执与卡", async () => {
    const receipt = await newService().grant("flow-reinstall", "workflow-operator")

    // ── ① 分身技能目录（窄口=ADR-0005 分身层，绝不泄漏共享层）──
    const liveSkill = j("agent/built-in/workflow-operator/skills/flow-reinstall/SKILL.md")
    expect(fs.existsSync(liveSkill)).toBe(true)
    const live = fs.readFileSync(liveSkill, "utf-8")
    expect(live).toContain("name: flow-reinstall")
    expect(live).toContain("## 步骤")
    // 票04 §八.4 建议兑现：治理键（status/source/origin）不带进 SDK 件
    expect(live).not.toContain("status: granted")
    expect(live).not.toContain("origin:")
    expect(fs.existsSync(j("agent/skills/flow-reinstall"))).toBe(false) // 共享层零写=窄口钉

    // ── ② 运行时预置源=官方 upgrade 原语三账（P0/P1 教训面：禁裸写文件）──
    const slot = j("resources/installed/skills/built-in/flow-reinstall/SKILL.md")
    expect(fs.readFileSync(slot, "utf-8")).toBe(live) // 槽位字节=分身目录字节（镜像同步）
    const row = manager.get("skill", "flow-reinstall")
    expect(row).not.toBeNull()
    expect(row!.installed).toBe(true)
    expect(row!.source).toBe("local") // 授予件的源=草案目录（非 core-pack builtin——防 registerBuiltins 语义混淆）
    expect(manager.verify("skill", "flow-reinstall").passed).toBe(true) // registry+lock+file 三账齐
    expect(manager.auditQuery({ action: "install_or_upgrade", last: 10 }).some(r => r.resource_name === "flow-reinstall")).toBe(true)

    // ── ③ agent_versions 发布现行版（授予即发版，fork ③A）──
    const versions = versionDao.listByAgent("workflow-operator")
    expect(versions.map(v => v.version).sort()).toEqual(["1.0.0", "1.0.1"])
    const fresh = versionDao.findByAgentAndVersion("workflow-operator", "1.0.1")!
    expect(fresh.status).toBe("published")
    expect(JSON.parse(fresh.snapshot).skills).toContain("flow-reinstall")
    // 快照保真坑（snapshotToFiles 仅从共享层拷字节）的处理面：版本目录必须带授予件正文
    const vSkill = j("agent/versions/workflow-operator/1.0.1/skills/flow-reinstall/SKILL.md")
    expect(fs.existsSync(vSkill)).toBe(true)
    expect(fs.readFileSync(vSkill, "utf-8")).toBe(live)
    expect(versionDao.findById(fresh.id)!.agent_name).toBe("workflow-operator")

    // ── ④ 草案状态翻面 ──
    const fm = readDraft(knowledgeRoot, "flow-reinstall")!.fm
    expect(fm.status).toBe("granted")
    expect(fm.grantedTo).toEqual(["workflow-operator"])

    // ── ⑤ 回执（票面逐字：分身名/版本号/预置源同步结果/status→granted）──
    expect(receipt).toMatchObject({
      draftName: "flow-reinstall",
      skillName: "flow-reinstall",
      target: "workflow-operator",
      layer: "clone",
      status: "granted",
      grantedTo: ["workflow-operator"],
      version: "1.0.1",
      published: true,
      rolledBackTo: null,
      idempotent: false,
      presetSync: { ok: true },
    })
    expect(receipt.receiptAt).toBe("2026-10-15T08:00:00.000Z")

    // ── 卡回执（Lane A 重发同址 skl-{name}，action=granted）──
    expect(events).toEqual([{ id: "skl-flow-reinstall", action: "granted" }])
  })

  it("重复授予同版幂等（票面逐字）：零写零三账零发版零重发卡，回执 idempotent=true", async () => {
    const svc = newService()
    await svc.grant("flow-reinstall", "workflow-operator")
    const auditBefore = manager.auditQuery({ action: "install_or_upgrade", last: 20 }).length
    const rowsBefore = versionDao.listByAgent("workflow-operator").length

    const again = await svc.grant("flow-reinstall", "workflow-operator")

    expect(again.idempotent).toBe(true)
    expect(again.published).toBe(false)
    expect(again.version).toBe("1.0.1") // 现行版不变（不重复发布）
    expect(again.status).toBe("granted")
    expect(manager.auditQuery({ action: "install_or_upgrade", last: 20 }).length).toBe(auditBefore) // 三账零重放
    expect(versionDao.listByAgent("workflow-operator").length).toBe(rowsBefore) // 版本账零新增
    expect(events).toHaveLength(1) // 幂等不重发 Lane A 卡（噪声纪律）
  })

  it("字节漂移=再授予：live 件被外删后重授予 ⇒ 修复落件+重同步，但不重复发版", async () => {
    const svc = newService()
    await svc.grant("flow-reinstall", "workflow-operator")
    removeTree(j("agent/built-in/workflow-operator/skills/flow-reinstall"))

    const r = await svc.grant("flow-reinstall", "workflow-operator")
    expect(r.idempotent).toBe(false)
    expect(r.published).toBe(false) // grantedTo 已在清单——修复路径不再堆版本账
    expect(r.version).toBe("1.0.1")
    expect(fs.existsSync(j("agent/built-in/workflow-operator/skills/flow-reinstall/SKILL.md"))).toBe(true)
  })

  it("「授给所有分身」= 共享技能层（ADR-0005 同机械链目录不同）：agent/skills 落件、分身层零写、无版本账、回执 layer=shared", async () => {
    const receipt = await newService().grant("flow-reinstall", "*")

    const sharedSkill = j("agent/skills/flow-reinstall/SKILL.md")
    expect(fs.existsSync(sharedSkill)).toBe(true)
    expect(fs.readFileSync(j("resources/installed/skills/built-in/flow-reinstall/SKILL.md"), "utf-8"))
      .toBe(fs.readFileSync(sharedSkill, "utf-8")) // 预置源镜像共享层字节
    expect(fs.existsSync(j("agent/built-in/workflow-operator/skills/flow-reinstall"))).toBe(false) // 分身层零写

    expect(versionDao.listByAgent("*").length + versionDao.listByAgent("workflow-operator").length).toBe(1) // 仅种子行
    expect(receipt).toMatchObject({ target: "*", layer: "shared", status: "granted", version: null, published: false, presetSync: { ok: true } })
    expect(readDraft(knowledgeRoot, "flow-reinstall")!.fm.grantedTo).toEqual(["*"])
  })

  it("非 versioned 分身（task-doer/用户分身）：目录+预置源两段生效、版本账零新行（坑单#8 回执如实报 null）", async () => {
    const receipt = await newService().grant("flow-reinstall", "task-doer")

    expect(fs.existsSync(j("agent/built-in/task-doer/skills/flow-reinstall/SKILL.md"))).toBe(true)
    expect(fs.existsSync(j("resources/installed/skills/built-in/flow-reinstall/SKILL.md"))).toBe(true)
    expect(versionDao.listByAgent("task-doer")).toHaveLength(0) // 未版本化分身不造版本账（其身份解析路径不因授予而变）
    expect(receipt).toMatchObject({ target: "task-doer", version: null, published: false })
  })

  it("预置源同步失败=回执如实报（不静默不中断）：目录件已落、版本账已发、presetSync.ok=false 带错误详情", async () => {
    const boom = {
      basePath: path.join(fakeHome, "resources"),
      get: () => null,
      installOrUpgrade: async () => { throw new Error("disk full") },
      uninstall: async () => { throw new Error("never") },
      verify: () => ({ passed: false, steps: [] }),
      auditQuery: () => [],
    } as unknown as ResourceManager
    const svc = new SkillGrantService({ root: knowledgeRoot, manager: () => boom, versionService: () => versionService })

    const receipt = await svc.grant("flow-reinstall", "workflow-operator")
    expect(receipt.presetSync.ok).toBe(false)
    expect(receipt.presetSync.detail).toContain("disk full")
    expect(receipt.status).toBe("granted") // 治理事实已成立（人裁授予），同步异常进回执供事后纠
    expect(receipt.published).toBe(true)
    expect(fs.existsSync(j("agent/built-in/workflow-operator/skills/flow-reinstall/SKILL.md"))).toBe(true)
  })

  it("错误面全形：撤销终态拒授予 / 分身不在盘 / 名不合规 / 撞 builtin 槽拒劫持（全局坑单#2 泄漏面闭合）", async () => {
    const svc = newService()
    await expect(svc.grant("ghost-draft", "workflow-operator")).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND", status: 404 })
    await expect(svc.grant("flow-reinstall", "no-such-clone")).rejects.toMatchObject({ code: "CLONE_NOT_FOUND", status: 404 })
    await expect(svc.grant("flow-reinstall", "../escape")).rejects.toMatchObject({ code: "INVALID_TARGET", status: 400 })

    // 撞名闸：先让 core-pack 注册同名 builtin 行（模拟平台技能），授予必须拒绝且分身目录零写
    const fakeCP = fs.mkdtempSync(path.join(os.tmpdir(), "aa05-cp-"))
    try {
      fs.mkdirSync(path.join(fakeCP, "skills", "flow-reinstall"), { recursive: true })
      fs.writeFileSync(path.join(fakeCP, "skills", "flow-reinstall", "SKILL.md"), "# 平台件", "utf-8")
      const cpManager = new ResourceManager({ basePath: j("resources"), corePackBase: fakeCP })
      cpManager.registerBuiltins()
      await expect(newService().grant("flow-reinstall", "workflow-operator")).rejects.toMatchObject({ code: "GRANT_NAME_CLASH", status: 409 })
      expect(fs.existsSync(j("agent/built-in/workflow-operator/skills/flow-reinstall"))).toBe(false)
      expect(cpManager.get("skill", "flow-reinstall")!.source).toBe("builtin") // 槽行未被劫持
    } finally {
      fs.rmSync(fakeCP, { recursive: true, force: true })
    }
  })
})

function removeTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── 撤销逆链（票05 第3行；坑单 #2/#3 处理面钉死）────────────────────────

describe("撤销逆链（版本回退 + 目录显式删 + 预置源逆同步 + 回执）", () => {
  it("grant→revoke（versioned 分身）：目录件消失、预置源 uninstall 三账清、授予版 archive、rollback 到 1.0.0、草案→revoked；历史行保留可查", async () => {
    const svc = newService()
    await svc.grant("flow-reinstall", "workflow-operator")
    const grantRow = versionDao.findByAgentAndVersion("workflow-operator", "1.0.1")!

    const receipt = await svc.revoke("flow-reinstall", "workflow-operator")

    // ① 分身技能目录显式删除（copyDirOverwrite 不清目录坑——撤销自己删）
    expect(fs.existsSync(j("agent/built-in/workflow-operator/skills/flow-reinstall"))).toBe(false)
    // ② 预置源逆同步：官方 uninstall 逆原语（行/锁/槽文件三面清，audit 留痕可查）
    expect(manager.get("skill", "flow-reinstall")).toBeNull()
    expect(fs.existsSync(j("resources/installed/skills/built-in/flow-reinstall"))).toBe(false)
    expect(manager.auditQuery({ action: "uninstall", last: 10 }).some(r => r.resource_name === "flow-reinstall")).toBe(true)
    // ③ 版本逆位：含授予件的发布行 archive（引擎 'latest' 按版本号解析——不 archive 撤销不生效）；
    //    rollback 目标=最高既有发布版 1.0.0（previous_version null 桩不采信，回执用自算值）
    expect(versionDao.findByAgentAndVersion("workflow-operator", "1.0.1")!.status).toBe("archived")
    expect(versionDao.findByAgentAndVersion("workflow-operator", "1.0.0")!.status).toBe("published")
    expect(versionDao.listAllPublished().filter(r => r.agent_name === "workflow-operator").map(r => r.version)).toEqual(["1.0.0"])
    // 历史可查（票面逐字）：行没被删，只是出发布集
    expect(grantRow.agent_name).toBe("workflow-operator")
    expect(versionDao.listByAgent("workflow-operator")).toHaveLength(2)
    // ④ 草案终态
    const fm = readDraft(knowledgeRoot, "flow-reinstall")!.fm
    expect(fm.status).toBe("revoked")
    expect(fm.grantedTo).toBeUndefined()
    // ⑤ 回执 + 卡
    expect(receipt).toMatchObject({ status: "revoked", target: "workflow-operator", grantedTo: [], rolledBackTo: "1.0.0", published: false })
    expect(receipt.presetSync.ok).toBe(true)
    expect(events.map(e => e.action)).toEqual(["granted", "revoked"])
  })

  it("多目标并授：撤销一个 ⇒ grantedTo 缩清单+预置源镜像重装幸存件；撤干净才 revoked+清槽", async () => {
    const svc = newService()
    await svc.grant("flow-reinstall", "workflow-operator")
    await svc.grant("flow-reinstall", "worker-u") // 用户分身并授（无版本账）

    const r1 = await svc.revoke("flow-reinstall", "workflow-operator")
    expect(r1.status).toBe("granted") // 还有 worker-u
    expect(r1.grantedTo).toEqual(["worker-u"])
    expect(fs.existsSync(j("agent/clones/worker-u/skills/flow-reinstall/SKILL.md"))).toBe(true) // 幸存件不动
    const row = manager.get("skill", "flow-reinstall")
    expect(row).not.toBeNull() // 槽行保留（镜像=worker-u 字节）
    expect(fs.readFileSync(j("resources/installed/skills/built-in/flow-reinstall/SKILL.md"), "utf-8"))
      .toBe(fs.readFileSync(j("agent/clones/worker-u/skills/flow-reinstall/SKILL.md"), "utf-8"))
    expect(readDraft(knowledgeRoot, "flow-reinstall")!.fm.grantedTo).toEqual(["worker-u"])

    const r2 = await svc.revoke("flow-reinstall", "worker-u")
    expect(r2.status).toBe("revoked")
    expect(fs.existsSync(j("agent/clones/worker-u/skills/flow-reinstall"))).toBe(false)
    expect(manager.get("skill", "flow-reinstall")).toBeNull()
  })

  it("授给所有（'*'）的逆链：共享层目录显式删 + 槽清；错误面：未授予/错目标/终态复撤全 409", async () => {
    const svc = newService()
    await svc.grant("flow-reinstall", "*")
    const receipt = await svc.revoke("flow-reinstall", "*")
    expect(receipt.status).toBe("revoked")
    expect(fs.existsSync(j("agent/skills/flow-reinstall"))).toBe(false)
    expect(manager.get("skill", "flow-reinstall")).toBeNull()
    await expect(svc.revoke("flow-reinstall", "*")).rejects.toMatchObject({ code: "DRAFT_NOT_GRANTED", status: 409 })

    // 错目标撤销用另一草案（flow-reinstall 已 revoked 终态，先试它拿 NOT_GRANTED 上面已钉）
    writeDraft(knowledgeRoot, { ...DRAFT, name: "flow-second", source: "exec:ex-second" })
    await svc.grant("flow-second", "task-doer")
    await expect(svc.revoke("flow-second", "worker-u")).rejects.toMatchObject({ code: "GRANT_TARGET_NOT_FOUND", status: 409 })
    await expect(svc.revoke("ghost", "workflow-operator")).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND", status: 404 })
  })

  it("撤销后重授予（同一 granted 事实复活）：revoked 终态拒 grant——再行使需重出草案（票04 留档纪律）", async () => {
    const svc = newService()
    await svc.grant("flow-reinstall", "task-doer")
    await svc.revoke("flow-reinstall", "task-doer")
    await expect(svc.grant("flow-reinstall", "task-doer")).rejects.toMatchObject({ code: "DRAFT_REVOKED", status: 409 })
  })
})

// ── 边界与红线（票05 第4行：授予不经 wiki 写队列；红线4/5）──────────────

describe("边界断言（授予链零 queue.enqueue·零记忆域触碰·granted 态文件仅授予链可写）", () => {
  it("代码面：授予服务零 wiki 写队列 import / 零 .enqueue( 调用 / 零记忆域标识符（票04 §五「零 import」同律）", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../skill-grant-service.ts"), "utf-8")
    const importStmts = (src.match(/import\s+[\s\S]*?from\s+["'][^"']+["']/g) ?? []).join("\n")
    for (const forbidden of ["compile-queue", "wiki/queue", "WRITE_OP_KINDS", "wiki-write"]) {
      expect(importStmts, `授予链不得 import wiki 写队列模块：${forbidden}`).not.toContain(forbidden)
    }
    expect(src).not.toMatch(/\.enqueue\(/)
    for (const memSym of ["getAgentMemoryDir", "getLongTermMemoryPath", "getDailyMemoryDir", "session_memory"]) {
      expect(src, `红线5：agent 记忆域标识符零出现 ${memSym}`).not.toContain(memSym)
    }
  })

  it("运行面：全链跑完（grant versioned+shared+revoke 双向），知识根 wiki/ 无 .git 无 INDEX、agent/memory 目录不存在", async () => {
    const svc = newService()
    await svc.grant("flow-reinstall", "workflow-operator")
    await svc.grant("flow-reinstall", "task-doer")
    await svc.revoke("flow-reinstall", "workflow-operator")
    expect(fs.existsSync(path.join(knowledgeRoot, "wiki", ".git"))).toBe(false)
    expect(fs.existsSync(path.join(knowledgeRoot, "wiki", "INDEX.md"))).toBe(false)
    expect(fs.existsSync(j("agent/memory"))).toBe(false) // 红线5：agent 记忆域零触碰
    expect(fs.existsSync(j("agent/built-in/workflow-operator/memory"))).toBe(false)
  })
})
