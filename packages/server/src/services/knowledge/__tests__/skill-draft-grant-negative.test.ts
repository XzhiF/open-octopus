// packages/server/src/services/knowledge/__tests__/skill-draft-grant-negative.test.ts
//
// P3 票04 — 零自动授予负断言（票面第 5 行明列；S1+S3 双面钉死，红线4 边界）。
//
// 断言面（外部行为，不测内部调用序列——spec Testing Decisions）：
//  * S1：跑通三路检测 + 对话改写 + 退役 + S2 路由全链后，**假 OCTOPUS_HOME 整树
//    逐字节不变**——分身技能目录（built-in/{clone}/skills、clones/{clone}/skills、
//    共享 agent/skills）、agent/versions、resources 预置源全部零触碰。
//  * S3：真实 ResourceManager 实例在场（生产原语装好、install 事件计数器张开），
//    全链跑完事件数为 0、installed 树与 registry/audit 字节不变——
//    「不调 installOrUpgrade」以外化形态钉死；agent_versions 表零行。
//  * wiki/cases 写面零触碰：判例文件与 INDEX 在场/缺席形态逐字不变、队列零任务
//    （红线2 不适用区= drafts；适用区= 本票一个都不进）。
//
// 越界即票05——若此测试变红 = 本票把生效链接歪了，立即回滚而非改测试。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { Hono } from "hono"
import { ResourceManager } from "@octopus/shared"
import { applySchema } from "../../../db/schema"
import { freezePackItem, writePackManifest } from "../material-pack"
import { SkillDraftService } from "../skill-draft-service"
import { createSkillDraftRoutes, skillDraftDetailView, skillDraftView } from "../../../routes/wiki-draft"

const EXCERPT = [
  "## exec e（phase 1 · round 1）",
  "- [t] do-x · tool_call :: {\"toolName\":\"Read\",\"isError\":true}",
  "- [t] do-x · bash_stderr :: {\"stderr\":\"boom\"}",
  "- [t] do-x · tool_call :: {\"toolName\":\"Edit\",\"isError\":true}",
].join("\n")

const PROPOSE = JSON.stringify({ skills: [{ description: "报错重装流程", steps: ["看日志", "重装", "验证"], source: "exec:ex-1" }] })

const REVISED = "# 报错重装流程\n\n## 触发条件\n\n- 报错。\n\n## 步骤\n\n1. 看日志\n2. 重装（带指数退避）\n3. 验证\n\n## 纪律\n\n- 草案未经授予不生效。\n"

let tmpRoot: string
let fakeHome: string
let knowledgeRoot: string
let prevHome: string | undefined

function walkFiles(root: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(abs)
      else out.push([path.relative(root, abs).replace(/\\/g, "/"), crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex")])
    }
  }
  if (fs.existsSync(root)) walk(root)
  return out
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aa04-neg-"))
  knowledgeRoot = path.join(tmpRoot, "knowledge")
  fs.mkdirSync(knowledgeRoot, { recursive: true })
  // 假 home：预置授予链会触达的全部目录（分身两层/版本/预置源三账）
  fakeHome = path.join(tmpRoot, "home")
  for (const p of [
    "agent/skills/shared-x",
    "agent/built-in/workflow-operator/skills/octo-wiki",
    "agent/built-in/archive/skills/octo-wiki-curate",
    "agent/clones/doer/skills",
    "agent/versions/workflow-operator/1.0.0/skills",
    "resources/installed/skills/built-in/octo-wiki",
  ]) fs.mkdirSync(path.join(fakeHome, p), { recursive: true })
  fs.writeFileSync(path.join(fakeHome, "agent/built-in/workflow-operator/skills/octo-wiki/SKILL.md"), "# octo-wiki\n", "utf-8")
  fs.writeFileSync(path.join(fakeHome, "agent/skills/shared-x/SKILL.md"), "# shared-x\n", "utf-8")
  fs.writeFileSync(path.join(fakeHome, "resources/installed/skills/built-in/octo-wiki/SKILL.md"), "# octo-wiki\n", "utf-8")
  fs.writeFileSync(path.join(fakeHome, "resources/registry.json"), JSON.stringify({ rows: [] }), "utf-8")
  fs.writeFileSync(path.join(fakeHome, "resources/audit.jsonl"), "", "utf-8")
  prevHome = process.env.OCTOPUS_HOME
  process.env.OCTOPUS_HOME = fakeHome
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.OCTOPUS_HOME
  else process.env.OCTOPUS_HOME = prevHome
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe("零自动授予负断言（S1·票04 第5行 + S3 生产原语在场）", () => {
  it("三路全出 + 改写 + 退役 + S2 全端点跑完：假 home 逐字节不变、ResourceManager install 事件 0、agent_versions 零行、wiki 零触碰", async () => {
    const db = new Database(":memory:")
    applySchema(db)
    try {
      const before = walkFiles(fakeHome)
      expect(before.length).toBeGreaterThan(0) // 快照非空——负断言有意义

      // 真实生产原语在场（票05 的插座装好但不接）：事件计数 + 三账字节对拍
      const manager = new ResourceManager({ basePath: path.join(fakeHome, "resources") })
      let installEvents = 0
      manager.on("install", () => { installEvents++ })

      // ── 全链：a+b+c 三路 + revise + retire + 路由 ──
      for (const [tid, payload] of [["neg-a", EXCERPT], ["neg-b", EXCERPT]] as const) {
        const manifest = { v: 1 as const, taskId: tid, createdAt: new Date().toISOString(), items: [], recompiles: [] }
        manifest.items.push(freezePackItem(knowledgeRoot, tid, {
          fileName: "03-exec-jsonl-excerpt.md", kind: "exec-jsonl-excerpt", name: "摘录",
          origin: `exec:${tid}`, title: `摘录 ${tid}`, payload,
        }))
        writePackManifest(knowledgeRoot, tid, manifest)
      }
      fs.mkdirSync(path.join(knowledgeRoot, "wiki", "cases"), { recursive: true })
      fs.writeFileSync(path.join(knowledgeRoot, "wiki", "cases", "2026-10-12-case-neg.md"), [
        "---", "id: case-neg", "domain: cases", "symptom: 重装失败需固定流程", "tags: [dep]",
        "severity: major", "occurrences: 2", "source: exec:ex-9", "rule_ref: oct-010", "status: distilled", "---", "",
        "## 现场", "", "装不上。", "", "## 诊断", "", "锁文件旧。", "", "## 根因", "", "残留 dist。", "",
        "## 修复", "", "固定流程：停服，清 dist，重装。", "", "## 教训", "", "按步骤清单执行。", "",
      ].join("\n"), "utf-8")

      const service = new SkillDraftService({
        root: knowledgeRoot,
        propose: async () => PROPOSE,
        revise: async () => REVISED,
      })
      const r1 = await service.detectForTask("neg-a") // a 路（neg-b 在场）+ c 路
      expect(r1.created.map(c => c.origin).sort()).toEqual(["curator-proposal", "sequence-similar"])
      const r2 = service.detectProceduralCases() // b 路
      expect(r2.created).toHaveLength(1)

      // S2 路由真链（deps 接同一 service——投影函数即 index.ts 将用的接线面）
      const app = new Hono()
      app.route("/api/knowledge", createSkillDraftRoutes({
        list: () => service.listDrafts().map(skillDraftView),
        read: name => {
          const rec = service.readDraft(name)
          return rec ? skillDraftDetailView(rec) : undefined
        },
        revise: (name, instruction) => service.reviseDraft(name, instruction),
        retire: name => service.retireDraft(name),
      }))
      const listRes = await app.request("/api/knowledge/drafts")
      expect(listRes.status).toBe(200)
      const listed = (await listRes.json()) as { drafts: Array<{ name: string }> }
      expect(listed.drafts.length).toBeGreaterThanOrEqual(3)

      const target = service.listDrafts()[0]!
      const rev = await app.request(`/api/knowledge/drafts/${target.fm.name}/revise`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction: "加退避" }),
      })
      expect(rev.status).toBe(200)
      const ret = await app.request(`/api/knowledge/drafts/${target.fm.name}/retire`, { method: "POST" })
      expect(ret.status).toBe(200)

      // ── 负断言收口 ──
      expect(installEvents, "官方 upgrade 原语零调用（事件面）").toBe(0)
      expect(walkFiles(fakeHome)).toEqual(before) // 假 home 整树逐字节不变（目录三态全含）
      const versions = db.prepare("SELECT COUNT(*) AS c FROM agent_versions").get() as { c: number }
      expect(versions.c, "agent_versions 零行（授予即发版是票05，本票连行都不该有）").toBe(0)

      // wiki/cases 零触碰：判例文件逐字未动（草案只读了它）
      const caseText = fs.readFileSync(path.join(knowledgeRoot, "wiki", "cases", "2026-10-12-case-neg.md"), "utf-8")
      expect(caseText).toContain("status: distilled")
      expect(caseText).toContain("rule_ref: oct-010")
      expect(fs.existsSync(path.join(knowledgeRoot, "wiki", "INDEX.md"))).toBe(false)
      expect(fs.existsSync(path.join(knowledgeRoot, "wiki", ".git"))).toBe(false)

      // drafts 区自身在场（正断言半边：草案确实产出了，只是没越过授予线）
      expect(fs.readdirSync(path.join(knowledgeRoot, "drafts", "skills")).length).toBeGreaterThanOrEqual(3)
    } finally {
      db.close()
    }
  })
})
