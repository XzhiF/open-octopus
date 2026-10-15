import { describe, it, expect } from "vitest"
import fs from "fs"
import path from "path"

/**
 * 票10 · S1——orchestrator 意图面内容契约（spec §投喂泛化「orchestrator 意图面新增
 * 『知识策展』类」逐字；票面 AC1）。
 *
 * 意图面 = 纯提示词技能（无代码枚举——E3 探明），故测试打**内容契约**：
 * 决策树分支在场 + 命中特征措辞 + 误吞防护纪律 + 与路由层工具名单源一致。
 * expected 真相源 = 票面/spec 原文措辞（编进 wiki/入库/沉淀这篇 + URL/长文本伴随），
 * 非从实现反推。
 */

const SKILL_PATH = path.join(__dirname, "../../../core-pack/skills/octo-agent-orchestrator/SKILL.md")
const ROUTE_PATH = path.join(__dirname, "../routes/agent/main-agent-route.ts")

const skill = fs.readFileSync(SKILL_PATH, "utf-8")
const route = fs.readFileSync(ROUTE_PATH, "utf-8")

/** 取 knowledge_curation 分支正文（决策树第 5 支，止于下一节标题）。 */
function branchBody(): string {
  const start = skill.indexOf("knowledge_curation")
  if (start < 0) return ""
  const rest = skill.slice(start)
  const end = rest.indexOf("\n## ")
  return end < 0 ? rest : rest.slice(0, end)
}

describe("octo-agent-orchestrator 决策树「知识策展」分支（票面 AC1）", () => {
  it("分支在场：意图分类含第 5 类 knowledge_curation（知识策展），决策树为既有权重面追加（5 支，非新平行技能）", () => {
    expect(skill).toContain("knowledge_curation")
    expect(branchBody()).not.toBe("")
    const tree = skill.slice(skill.indexOf("### Decision Tree"))
    const topItems = [...tree.matchAll(/^\d+\. \*\*/gm)].length
    expect(topItems).toBe(5)
  })

  it("命中特征：投喂动词组（编进/入库/沉淀，票面逐字）+ URL/长文本伴随特征", () => {
    const body = branchBody()
    expect(body).toContain("编进")
    expect(body).toContain("入库")
    expect(body).toContain("沉淀")
    expect(body).toMatch(/URL/)
    expect(body).toContain("长文本")
  })

  it("误吞防护纪律在分支正文（classifyKcFeed 先例继承：无投喂动词不路由，动词在而无对象不吞）", () => {
    const body = branchBody()
    expect(body).toMatch(/无投喂动词/)
    expect(body).toMatch(/不路由|不触发/)
  })

  it("路由动作 = 调 ingest_to_wiki 工具（与 main-agent-route 工具名单源一致；票面 AC2 零平行机制在提示词面的表达）", () => {
    const body = branchBody()
    expect(body).toContain("ingest_to_wiki")
    // 单源对账：路由层提示词段与执行拦截同名
    expect(route).toContain("ingest_to_wiki")
    expect(route).toContain("CURATION_TOOLS_PROMPT")
  })

  it("卡片回流契约措辞：分支 Action 声明卡片自动回流本会话（模型不复述原始 JSON——Lane A 沉淀面归服务链）", () => {
    const body = branchBody()
    expect(body).toMatch(/回流/)
  })
})
