// packages/shared/src/__tests__/wiki-consumption-v3.test.ts
//
// 知识中心票 14 — 消费面 v3 切换（资源预置链回归 × 装配面钉死）。
//
// Seam（spec Testing Decisions S3 + 票14 前置事实 D1）：
//   ResourceManager.installOrUpgrade（官方升级原语 —— 运行时预置源唯一同步通道，
//   服务重启不同步预置源内容 = llm-wiki e2e-report addendum 教训）
//   → ResourceProvisioner.provision（工作流装配的公共物化面）
//   → workspace/.claude/skills/<name>/SKILL.md（SDK settingSources 原生发现的输入）。
//
// 期望值来源 = 票 14 AC1/AC2/AC4 + prototype Tab⑤「保留/改造清单」（独立真相），
// 不从实现反推：五类映射、全局根路径、D1 修复版 JSON 示例、禁旧四域词都是合同原文。
//
// 红线：只读真实 core-pack（输入面），写全部落 tmpdir 假 home / 假 workspace，
// 绝不碰真 ~/.octopus。

import { describe, it, expect, afterAll } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import { ResourceManager, ResourceProvisioner } from "../resource"

// __dirname = packages/shared/src/__tests__（ts src 与 dist 同深度，测试经 vitest 直读 src）
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
const corePackDir = path.join(repoRoot, "packages", "core-pack")

const tmpRoots: string[] = []
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

/** 走「官方 upgrade 原语 → 预置源 → Provisioner → workspace」全链，返回落盘 skill 文本。 */
async function provisionSkillToWorkspace(name: string): Promise<string> {
  const home = mkTmp("kc14-home-")
  const workspace = mkTmp("kc14-ws-")
  const manager = new ResourceManager({
    basePath: path.join(home, "resources"),
    corePackBase: corePackDir,
  })

  const res = await manager.installOrUpgrade({
    ref: `builtin:${name}`,
    type: "skill",
    caller: "cli",
  })
  expect(res.status).toBe("installed")
  expect(res.installPath, "预置源安装路径缺 octo-wiki 目录名").toContain(name)

  const provisioner = new ResourceProvisioner(manager)
  const out = await provisioner.provision([{ type: "skill", name }], workspace)
  expect(out.failed, `provision 失败: ${out.failed.join(", ")}`).toEqual([])

  const dest = path.join(workspace, ".claude", "skills", name, "SKILL.md")
  expect(fs.existsSync(dest), `workspace 未物化 ${name}`).toBe(true)
  return fs.readFileSync(dest, "utf-8")
}

describe("票14 S3 装配断言 — octo-wiki 新形态经预置链进 workspace", () => {
  it("workspace 物化的 SKILL.md = v3 阅读面：五类页 + 全局根 + INDEX 必读节指向", async () => {
    const text = await provisionSkillToWorkspace("octo-wiki")

    // AC1 五类页映射（票面原文：项目/服务/工具→entities · SOP/工作流→topics ·
    // 术语/概念→concepts · 溯源→sources · 卡壳按症状→cases）
    expect(text).toMatch(/entities/)
    expect(text).toMatch(/topics/)
    expect(text).toMatch(/concepts/)
    expect(text).toMatch(/sources/)
    expect(text).toMatch(/cases/)

    // AC3/D6① 全局根：第一跳路径不再是 org 根
    expect(text).toContain("~/.octopus/knowledge/wiki/INDEX.md")
    expect(text).not.toContain("orgs/")

    // 旧四域阅读面清零（Tab⑤「阅读面从 4 域词条变为五类页」）
    expect(text).not.toMatch(/projects\/\{name\}\.md/)
    expect(text).not.toMatch(/business\//)
    expect(text).not.toMatch(/research\//)
    expect(text).not.toMatch(/workflows\/\{name\}\.md/)

    // AC2 INDEX 必读节承接人工共演约定（SCHEMA.md——ADR-0033 起 user_preference 概念退役）
    // 「全文必读」语义—— skill 侧指向它
    expect(text).toContain("必读")
    expect(text).not.toContain("user_preference")

    // AC4 search 调用面钉全局：示例不得再带具体 org 值
    expect(text).not.toContain("org=xzf-dev")
  })

  it("D-kc15-2（票07）必读节路径语义经预置链同步：知识根可达、非 wiki 子树假路径（必读标的随 ADR-0033 换钉 SCHEMA.md，契约不变）", async () => {
    // 缺陷现场（KC e2e-report 链④）：agent 照 INDEX 旧行读 wiki 根下的人工文件 → File not found。
    // 修复合同 = INDEX 行 + skill 必读措辞都指到知识根可达形态；本例经 **官方 upgrade 原语**
    // （installOrUpgrade）同步链断言——改 core-pack ≠ 运行时生效，必须物化到预置源再进 workspace。
    const provisioned = await provisionSkillToWorkspace("octo-wiki")

    // skill 必读节：知识根绝对路径 + INDEX 可达相对形态（../SCHEMA.md）都在
    expect(provisioned).toContain("~/.octopus/knowledge/SCHEMA.md")
    expect(provisioned).toContain("../SCHEMA.md")
    // 人工文件住在知识根、不在 wiki 子树——措辞同步（语义面，非仅路径面）
    expect(provisioned).toMatch(/知识根/)
    // 防复活（ADR-0033）：退役概念不得再进必读面
    expect(provisioned).not.toContain("user_preference")

    // 预置源槽本身已同步（installOrUpgrade 物化件 = core-pack 逐字节）
    const home = mkTmp("kc14-preset-")
    const manager = new ResourceManager({ basePath: path.join(home, "resources"), corePackBase: corePackDir })
    const res = await manager.installOrUpgrade({ ref: "builtin:octo-wiki", type: "skill", caller: "cli" })
    const preset = fs.readFileSync(path.join(res.installPath, "SKILL.md"), "utf-8")
    expect(preset).toContain("../SCHEMA.md")
  })

  it("保留面一字不变：导航协议骨架 + D1 修复版 JSON 示例 + [ref:]/stale + 禁止事项", async () => {
    const text = await provisionSkillToWorkspace("octo-wiki")

    // 导航协议骨架（Tab⑤：INDEX→页整读→search 兜底，禁全库遍历）
    expect(text).toContain("按跳计费")
    expect(text).toContain("禁止全库遍历")
    expect(text).toContain("整篇消费不碎片")
    expect(text).toContain("禁止跳过 INDEX")

    // 引用纪律 —— wiki_refs JSON 形态示例 = D1 修复版，逐字节保留（勿回退）
    expect(text).toContain(
      '{"vars_update":{"wiki_refs":["prj-octopus#oct-007", "wf-prd-impl#sop-002"]}}',
    )
    expect(text).toContain("[ref: oct-007]")
    expect(text).toContain('stale: oct-009 与代码现状矛盾')

    // 禁止事项原文
    expect(text).toContain("禁止写入 wiki 目录")
    expect(text).toContain("禁止把词条全文粘贴进交付物")
  })

  it("task-author 经同一预置链物化：Step 2.5 全局根 + 五类页，repos 域 org 根不误伤", async () => {
    const text = await provisionSkillToWorkspace("task-author")

    // 知识面切全局根 + 五类页（AC1/AC3 同一合同）
    expect(text).toContain("~/.octopus/knowledge/wiki/INDEX.md")
    expect(text).not.toContain("orgs/{org}/knowledge")
    expect(text).toMatch(/entities/)
    expect(text).toMatch(/concepts/)
    expect(text).toMatch(/topics/)

    // 引用回写纪律保留（vars_update JSON 形态，票 14「一字不变」面）
    expect(text).toContain('{"vars_update":{"wiki_refs":["prj-octopus#oct-007"]}}')
    expect(text).toContain("stale:")

    // 边界钉死：repos 索引属多仓域（非知识域），org 根措辞必须原样保留 ——
    // 证明「grep orgs/ 清零」口径只圈知识面，不误伤无辜。
    expect(text).toContain("orgs/{org}/repos/index.md")
  })

  it("repo 镜像一致：.claude/skills 与 core-pack 逐字节相同（开发副本漂移闸）", () => {
    for (const name of ["octo-wiki", "task-author"]) {
      const src = fs.readFileSync(
        path.join(corePackDir, "skills", name, "SKILL.md"),
        "utf-8",
      )
      const mirror = fs.readFileSync(
        path.join(repoRoot, ".claude", "skills", name, "SKILL.md"),
        "utf-8",
      )
      expect(mirror, `.claude/skills/${name}/SKILL.md 与 core-pack 漂移`).toBe(src)
    }
  })
})
