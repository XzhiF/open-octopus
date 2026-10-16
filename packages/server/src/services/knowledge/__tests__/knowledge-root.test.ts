import { describe, it, expect, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import {
  deriveKnowledgeRootAt,
  deriveOrgKnowledgeDirAt,
  deriveOrgWikiRootAt,
  deriveWikiRootAt,
  legacyWikiDirEnv,
  resolveGlobalWikiRoot,
  resolveKnowledgeDir,
  resolveKnowledgeRoot,
} from "../global-paths"
import { getKnowledgeDir } from "../file-ops"
import { resolveWikiRoot, resolveWikiRootCompat, hasWikiContent } from "../wiki/paths"

/**
 * 知识根解析单源（code-review S3 / CODING_STANDARDS #1）——四套解析收口
 * global-paths.ts 一处的行为契约钉版：
 *   - 同一 org 口径：file-ops.getKnowledgeDir ≡ resolveKnowledgeDir（含 env 拍平形态）；
 *   - 同一 $OCTOPUS_HOME 窗：wiki 根 org 轨与 compat 默认 home 不再硬编码 ~（原四套里
 *     两套各写各的，本测试先红后绿即收口证据）；
 *   - env 钩子统一：正源 = OCTOPUS_KNOWLEDGE_DIR（知识根），wiki 根 = 知识根/wiki；
 *     OCTOPUS_WIKI_DIR 保留为弃用别名（直写 wiki 根，legacyWikiDirEnv 单源定义），
 *     优先级序（注入 root > 别名 > 布局解析）三处同律。
 */

const saved = {
  KNOWLEDGE_DIR: process.env.OCTOPUS_KNOWLEDGE_DIR,
  WIKI_DIR: process.env.OCTOPUS_WIKI_DIR,
  HOME: process.env.OCTOPUS_HOME,
}

function restoreEnv(): void {
  for (const [k, v] of [["OCTOPUS_KNOWLEDGE_DIR", saved.KNOWLEDGE_DIR], ["OCTOPUS_WIKI_DIR", saved.WIKI_DIR], ["OCTOPUS_HOME", saved.HOME]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

afterEach(restoreEnv)

describe("单源：org 轨与 env 拍平", () => {
  it("OCTOPUS_KNOWLEDGE_DIR 拍平形态：getKnowledgeDir(org) ≡ resolveKnowledgeDir(org) ≡ env 值（旧语义兼容）", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kc-root-flat-"))
    try {
      process.env.OCTOPUS_KNOWLEDGE_DIR = tmp
      expect(getKnowledgeDir("test-org")).toBe(tmp)
      expect(resolveKnowledgeDir("test-org")).toBe(tmp)
      expect(resolveKnowledgeRoot()).toBe(tmp)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("$OCTOPUS_HOME 贯通四套解析：file-ops org 轨 / resolveWikiRoot org 轨 / compat 默认 home 同指一基", () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "kc-root-home-"))
    try {
      process.env.OCTOPUS_HOME = fakeHome
      delete process.env.OCTOPUS_KNOWLEDGE_DIR
      delete process.env.OCTOPUS_WIKI_DIR
      const home = fakeHome
      expect(getKnowledgeDir("xzf-dev")).toBe(deriveOrgKnowledgeDirAt(home, "xzf-dev"))
      expect(resolveKnowledgeDir("xzf-dev")).toBe(path.join(home, "orgs", "xzf-dev", "knowledge"))
      expect(resolveWikiRoot("xzf-dev")).toBe(deriveOrgWikiRootAt(home, "xzf-dev"))
      // compat：全局根无内容 ⇒ 窗口落旧 org wiki；有内容 ⇒ 切全局根。默认 home 都走 $OCTOPUS_HOME
      expect(resolveWikiRootCompat("xzf-dev")).toBe(deriveOrgWikiRootAt(home, "xzf-dev"))
      const g = deriveWikiRootAt(home)
      fs.mkdirSync(g, { recursive: true })
      fs.writeFileSync(path.join(g, "INDEX.md"), "# x", "utf-8")
      expect(hasWikiContent(g)).toBe(true)
      expect(resolveWikiRootCompat("xzf-dev")).toBe(g)
      expect(resolveGlobalWikiRoot()).toBe(g)
      // 无 org 时 wiki 根 = 知识根/wiki（与 file-ops 非 org 轨同基）
      expect(resolveWikiRoot()).toBe(path.join(getKnowledgeDir(), "wiki"))
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true })
    }
  })
})

describe("单源：env 钩子统一（正源 KNOWLEDGE_DIR，WIKI_DIR=弃用别名）", () => {
  it("OCTOPUS_WIKI_DIR 别名对 resolveWikiRoot 与 compat 同效；别名缺席时两函数同指布局解析值", () => {
    const wiki = fs.mkdtempSync(path.join(os.tmpdir(), "kc-root-alias-"))
    try {
      process.env.OCTOPUS_WIKI_DIR = wiki
      expect(legacyWikiDirEnv()).toBe(wiki)
      expect(resolveWikiRoot("any-org")).toBe(wiki)
      expect(resolveWikiRootCompat("any-org")).toBe(wiki)
      delete process.env.OCTOPUS_WIKI_DIR
      // 正源联动：KNOWLEDGE_DIR 定根 ⇒ wiki 根 = 根/wiki，两函数一致
      const knowledge = fs.mkdtempSync(path.join(os.tmpdir(), "kc-root-main-"))
      try {
        process.env.OCTOPUS_KNOWLEDGE_DIR = knowledge
        expect(resolveWikiRoot()).toBe(path.join(knowledge, "wiki"))
        expect(resolveWikiRootCompat(undefined)).toBe(path.join(knowledge, "wiki"))
      } finally {
        fs.rmSync(knowledge, { recursive: true, force: true })
      }
    } finally {
      fs.rmSync(wiki, { recursive: true, force: true })
    }
  })

  it("注入 rootDir 优先于一切 env（三处同律：root > 别名 > 解析）", () => {
    process.env.OCTOPUS_WIKI_DIR = "/should-not-win"
    process.env.OCTOPUS_KNOWLEDGE_DIR = "/should-not-win-either"
    expect(resolveWikiRoot("org", "/injected")).toBe("/injected")
    expect(resolveWikiRootCompat("org", "/injected")).toBe("/injected")
  })
})

describe("derive 族：布局公式单源", () => {
  it("五布局式逐字对拍（home 基 = 注入窗，绝不回落到真 ~）", () => {
    const h = path.join("X:", "fake", ".octopus")
    expect(deriveKnowledgeRootAt(h)).toBe(path.join(h, "knowledge"))
    expect(deriveWikiRootAt(h)).toBe(path.join(h, "knowledge", "wiki"))
    expect(deriveOrgKnowledgeDirAt(h, "o")).toBe(path.join(h, "orgs", "o", "knowledge"))
    expect(deriveOrgWikiRootAt(h, "o")).toBe(path.join(h, "orgs", "o", "knowledge", "wiki"))
  })
})
