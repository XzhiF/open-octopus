// packages/server/src/services/agent/__tests__/wiki-curate-clone-tier.test.ts
//
// llm-wiki-loop 票06 — octo-wiki-curate 分身层装机（写侧技能隔离）。
//
// Seam: findArchiveSeedDir / CloneInitService.initBuiltInClones / getBuiltinCloneDef
// （全公共），落盘用 temp home 观察 —— octo-wiki-skill-binding.test.ts 同款 harness。
//
// 钉三条事实（期望值来自 spec D4 + ADR-0005/0006 + sources.md 项3，不反向抄实现）：
//   1. 写侧技能只在 archive 分身层（core-pack/clones/archive/skills/），
//      共享层与任何其他分身层出现 = 写权泄漏（ADR-0006 getPlugins 忽略 skills
//      白名单，共享层被全分身继承 ⇒ curate 进共享层 = 全员可写 wiki）。
//   2. CloneInitService 把 fork（persona.md + skills 树）seed 进
//      built-in/archive/，且 archive 的 CloneDef/config.json 声明含 octo-wiki-curate。
//   3. 消费侧分身（task-author/task-doer 等）装机后看不到写侧技能。

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import fs from "fs"
import path from "path"

const MOCK_HOME = vi.hoisted(() => {
  const p = require("path") as typeof import("path")
  const o = require("os") as typeof import("os")
  return p.join(o.tmpdir(), `octopus-test-curate-tier-${process.pid}`)
})

vi.mock("../paths", async () => {
  const p = require("path") as typeof import("path")
  const actual = await vi.importActual<typeof import("../paths")>("../paths")
  const builtInRoot = p.join(MOCK_HOME, "agent", "built-in")
  return {
    ...actual,
    getOctopusHome: () => MOCK_HOME,
    getAgentDir: () => p.join(MOCK_HOME, "agent"),
    getBuiltInClonesDir: () => builtInRoot,
    getBuiltInCloneDir: (name: string) => p.join(builtInRoot, name),
    getBuiltInCloneMemoryDir: (name: string) => p.join(builtInRoot, name, "memory"),
  }
})

import {
  ARCHIVE_CURATE_SKILL_FAMILY,
  CloneInitService,
  findArchiveSeedDir,
} from "../clone-init-service"
import { BUILTIN_CLONES, getBuiltinCloneDef } from "../builtin-clones"

const corePackBase = path.resolve(__dirname, "../../../../../core-pack")
const realFork = path.join(corePackBase, "clones", "archive")

function fakeDAO() {
  const names = new Set<string>()
  return {
    findByName: (name: string) => (names.has(name) ? { name } : null),
    insert: (row: { name: string }) => {
      names.add(row.name)
      return {}
    },
  } as never
}

describe("octo-wiki-curate clone-tier（票06 写侧隔离）", () => {
  beforeAll(() => {
    fs.rmSync(MOCK_HOME, { recursive: true, force: true })
    delete process.env.OCTOPUS_ARCHIVE_SEED_DIR
    new CloneInitService().initBuiltInClones("curate-tier-org", fakeDAO())
  })

  afterAll(() => {
    fs.rmSync(MOCK_HOME, { recursive: true, force: true })
  })

  it("repo fork 可解析且只含声明的写侧技能族", () => {
    expect(findArchiveSeedDir()).toBe(realFork)
    const dirs = fs
      .readdirSync(path.join(realFork, "skills"), { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
    expect(dirs).toEqual([...ARCHIVE_CURATE_SKILL_FAMILY].sort())
  })

  // 知识中心票05 AC4：curate skill 瘦身重定向——纪律正文入册 SCHEMA.md，
  // 技能本体只承载「指向 SCHEMA + 编译 API 用法」+ 不变的 git/写权红线。
  it("SKILL.md 瘦身形态：指向 SCHEMA + 编译 API 用法 + git/写权红线", () => {
    const text = fs.readFileSync(path.join(realFork, "skills/octo-wiki-curate/SKILL.md"), "utf-8")
    for (const anchor of [
      "name: octo-wiki-curate",
      "SCHEMA.md",
      "编译 API 用法",
      "CuratorCompileService.compileRaw",
      "/api/knowledge/wiki/compile",
      "OCTOPUS_WIKI_COMMIT_SOURCE",
      "_retired",
      "永不自动改写",
    ]) {
      expect(text, `SKILL.md 缺「${anchor}」`).toContain(anchor)
    }
    // 反锚点：审批队列时代的编译流水线五步图已随纪律搬家删除（技能不再复述纪律正文）
    expect(text).not.toContain("② 候选入队 PendingItem")
  })

  it("ADR-0006 红线：octo-wiki-curate 绝不进共享层，也不进其他分身 fork", () => {
    expect(fs.existsSync(path.join(corePackBase, "skills", "octo-wiki-curate"))).toBe(false)
    const clonesDir = path.join(corePackBase, "clones")
    const offenders: string[] = []
    for (const clone of fs.readdirSync(clonesDir)) {
      if (clone === "archive") continue
      if (fs.existsSync(path.join(clonesDir, clone, "skills", "octo-wiki-curate"))) offenders.push(clone)
    }
    expect(offenders).toEqual([])
  })

  it("CloneInitService 把写侧技能 seed 进 built-in/archive/，消费侧分身看不到", () => {
    expect(
      fs.existsSync(path.join(MOCK_HOME, "agent", "built-in", "archive", "skills", "octo-wiki-curate", "SKILL.md")),
    ).toBe(true)

    for (const def of BUILTIN_CLONES) {
      if (def.name === "archive") continue
      expect(
        fs.existsSync(path.join(MOCK_HOME, "agent", "built-in", def.name, "skills", "octo-wiki-curate")),
        `${def.name} 不应拿到写侧技能`,
      ).toBe(false)
    }
  })

  it("archive CloneDef 与落盘 config.json 都声明 octo-wiki-curate（治理底账，票10/12 读取）", () => {
    expect(getBuiltinCloneDef("archive")!.skills).toContain("octo-wiki-curate")
    const config = JSON.parse(
      fs.readFileSync(path.join(MOCK_HOME, "agent", "built-in", "archive", "config.json"), "utf-8"),
    ) as { skills: string[] }
    expect(config.skills).toContain("octo-wiki-curate")
    // persona 由 fork 接管（策展纪律入身份），不再是内联 fallback 的旧四段
    const persona = fs.readFileSync(path.join(MOCK_HOME, "agent", "built-in", "archive", "persona.md"), "utf-8")
    expect(persona).toContain("写侧唯一闸门")
  })
})
