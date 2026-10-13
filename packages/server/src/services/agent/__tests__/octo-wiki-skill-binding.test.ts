// packages/server/src/services/agent/__tests__/octo-wiki-skill-binding.test.ts
//
// llm-wiki-loop 票11 — octo-wiki 分身声明绑定（治理语义）。
//
// Seam: BUILTIN_CLONES / getBuiltinCloneDef / CloneInitService.initBuiltInClones
// （全公共），落盘 config.json 用 temp home 观察 —— 与 task-doer-clone.test.ts
// 同一 harness（paths 全 mock 到 tmp，绝不碰真实 ~/.octopus）。
//
// 钉两条事实（期望值来自 spec §执行身份 + ADR-0005/0006，不反向抄实现）：
//   1. task-author / task-doer / archive 的 CloneDef.skills 均声明 octo-wiki
//      （读侧消费身份）。archive 由票06 绑写侧 curate，本票补读侧。
//   2. CloneInitService 把声明持久化进 built-in/{clone}/config.json 的 skills
//      —— 这是票10 IdentityResolver 快照与票12 knowledge.mode 读取的治理底账。
//
// ADR-0006 红线备忘：CloneDef.skills 是声明性意图（getPlugins 忽略它，全分身
// 继承共享层）；运行时发现走 core-pack/skills → 共享层，不走 prompt 注入。
// 本测试同时钉「octo-wiki 不在分身层」——见 resource-preflight.test.ts 的
// clone-tier 断言，此处不重复。

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"

const MOCK_HOME = vi.hoisted(() => {
  const p = require("path") as typeof import("path")
  const o = require("os") as typeof import("os")
  return p.join(o.tmpdir(), `octopus-test-octowiki-bind-${process.pid}`)
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

import { getBuiltinCloneDef } from "../builtin-clones"
import { CloneInitService } from "../clone-init-service"

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

describe("octo-wiki 分身声明绑定（票11）", () => {
  beforeAll(() => {
    fs.rmSync(MOCK_HOME, { recursive: true, force: true })
  })

  afterAll(() => {
    fs.rmSync(MOCK_HOME, { recursive: true, force: true })
  })

  it("task-author / task-doer / archive 的 CloneDef.skills 都声明 octo-wiki（治理语义）", () => {
    for (const clone of ["task-author", "task-doer", "archive"]) {
      const def = getBuiltinCloneDef(clone)
      expect(def, `clone ${clone} 未注册`).not.toBeNull()
      expect(def!.skills, `${clone} 应声明 octo-wiki`).toContain("octo-wiki")
    }
  })

  it("CloneInitService 把 octo-wiki 声明持久化进三个分身的 config.json（票10/12 读取的治理底账）", () => {
    new CloneInitService().initBuiltInClones("bind-test-org", fakeDAO())

    for (const clone of ["task-author", "task-doer", "archive"]) {
      const configPath = path.join(MOCK_HOME, "agent", "built-in", clone, "config.json")
      expect(fs.existsSync(configPath), `${clone}/config.json 未落盘`).toBe(true)
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { skills: string[] }
      expect(config.skills, `${clone} config.json 缺 octo-wiki`).toContain("octo-wiki")
    }
  })
})
