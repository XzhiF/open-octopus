import { Hono, type Context } from "hono"
import { SKILL_DRAFT_NAME_RE, type SkillGrantReceipt } from "@octopus/shared"
import { SkillDraftError } from "../services/knowledge/skill-draft-service"
import type { SkillDraftRecord } from "../services/knowledge/skill-draft-store"

/**
 * skill 草案路由 — P3 票04（S2 契约面）+ 票05（授予/撤销端点）。挂 `/api/knowledge`：
 *
 *   GET  /drafts            ⇒ 200 { drafts: [view…] }（列出，含 revoked 留档行）
 *   GET  /drafts/:name      ⇒ 200 单草案全量（SKILL.md content）· 404 DRAFT_NOT_FOUND · 400 INVALID_PARAM
 *   POST /drafts/:name/revise { instruction } ⇒ 200 { name, status:'draft', path, updatedAt }
 *        （对话改写触发面：owner 指令 → 策展人 LLM seam 改写 → drafts 文件本体替换；
 *         错误面 400/404/409 DRAFT_GRANTED · 502 REVISE_EMPTY/REVISE_BAD_SHAPE · 500 REVISE_FAILED）
 *   POST /drafts/:name/retire ⇒ 200 { name, status:'revoked', path }（留档不删，可溯源）
 *   POST /drafts/:name/grant  { cloneName }  ⇒ 200 SkillGrantReceipt（票05 授予机械链；
 *        cloneName='*' =「授给所有分身」落共享层；错误面 404 DRAFT_NOT_FOUND/CLONE_NOT_FOUND ·
 *        409 DRAFT_REVOKED/GRANT_NAME_CLASH/GRANT_TARGET_NOT_FOUND · 500 GRANT_PUBLISH_FAILED）
 *   POST /drafts/:name/revoke { cloneName }  ⇒ 200 SkillGrantReceipt（逆链：目录删+预置源+版本回退）
 *
 * 票05 的 grant/revoke deps 为**可选**：不接线（票04 形态）时路由面零注册=404，
 * 票04 的红线4 负断言（无授予动词）保持成立；接线后本路由才出现生效链动词。
 * 红线4 的语义从来不是「路由文件里不许有 grant」，而是「草案产出链零自动授予」——
 * 授予动词只可能由人点卡触发（红线3 人裁=授予治理，无审批队列）。
 * 错误形状 {error:{code,message}}，SkillDraftError.code 逐字透传（PackOps/Case 路由同族制式）。
 */

export interface SkillDraftView {
  name: string
  /** 知识根相对路径 drafts/skills/{name}/SKILL.md */
  path: string
  status: string
  origin: string
  source: string
  description: string
  updatedAt: string
  taskId?: string
  caseId?: string
  ruleRef?: string
  similarity?: number
  /** 票05：授予目标清单（分身名 ∪ `*`；draft/revoked 缺省） */
  grantedTo?: string[]
}

export interface SkillDraftDetailView extends SkillDraftView {
  /** SKILL.md 全文（front-matter + 正文——预览/对质面） */
  content: string
}

export interface WikiDraftRouteDeps {
  list: () => SkillDraftView[]
  read: (name: string) => SkillDraftDetailView | undefined
  revise: (name: string, instruction: string) => Promise<{ name: string; status: "draft"; path: string; updatedAt: string }>
  retire: (name: string) => { name: string; status: "revoked"; path: string }
  /** 票05 机械链接线位（可选=票04 形态零注册，红线4 负断言面） */
  grant?: (name: string, cloneName: string) => Promise<SkillGrantReceipt>
  revoke?: (name: string, cloneName: string) => Promise<SkillGrantReceipt>
}

/** store 记录 → 列表视图（index.ts 接线单源投影；治理字段全透出）。 */
export function skillDraftView(rec: SkillDraftRecord): SkillDraftView {
  const fm = rec.fm
  return {
    name: fm.name,
    path: rec.relPath,
    status: fm.status,
    origin: fm.origin,
    source: fm.source,
    description: fm.description,
    updatedAt: fm.updatedAt,
    ...(fm.taskId !== undefined ? { taskId: fm.taskId } : {}),
    ...(fm.caseId !== undefined ? { caseId: fm.caseId } : {}),
    ...(fm.ruleRef !== undefined ? { ruleRef: fm.ruleRef } : {}),
    ...(fm.similarity !== undefined ? { similarity: fm.similarity } : {}),
    ...(fm.grantedTo !== undefined ? { grantedTo: fm.grantedTo } : {}),
  }
}

/** store 记录 → 详情视图（加 SKILL.md 全文）。 */
export function skillDraftDetailView(rec: SkillDraftRecord): SkillDraftDetailView {
  return { ...skillDraftView(rec), content: rec.content }
}

function badName(c: { json: (v: unknown, s: number) => Response }, name: string): Response {
  return c.json({ error: { code: "INVALID_PARAM", message: `草案名不合规：'${name}'（要求 kebab 小写）` } }, 400)
}

export function createSkillDraftRoutes(deps: WikiDraftRouteDeps): Hono {
  const routes = new Hono()

  const toResponse = (c: { json: (v: unknown, s: number) => Response }, err: unknown): Response => {
    if (err instanceof SkillDraftError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400)
    throw err
  }

  routes.get("/drafts", (c) => c.json({ drafts: deps.list() }))

  routes.get("/drafts/:name", (c) => {
    const name = c.req.param("name") ?? ""
    if (!SKILL_DRAFT_NAME_RE.test(name)) return badName(c, name)
    const rec = deps.read(name)
    if (!rec) return c.json({ error: { code: "DRAFT_NOT_FOUND", message: `草案不在盘或坏形：${name}` } }, 404)
    return c.json(rec)
  })

  routes.post("/drafts/:name/revise", async (c) => {
    const name = c.req.param("name") ?? ""
    if (!SKILL_DRAFT_NAME_RE.test(name)) return badName(c, name)
    const payload = await c.req.json().catch(() => null)
    const instruction = payload && typeof payload === "object" && typeof (payload as { instruction?: unknown }).instruction === "string"
      ? (payload as { instruction: string }).instruction.trim()
      : ""
    if (instruction === "") {
      return c.json({ error: { code: "INVALID_PARAM", message: "instruction 必须是非空字符串（owner 说改哪里）" } }, 400)
    }
    try {
      const res = await deps.revise(name, instruction)
      return c.json(res, 200)
    } catch (err) {
      return toResponse(c, err)
    }
  })

  routes.post("/drafts/:name/retire", (c) => {
    const name = c.req.param("name") ?? ""
    if (!SKILL_DRAFT_NAME_RE.test(name)) return badName(c, name)
    try {
      const res = deps.retire(name)
      return c.json(res, 200)
    } catch (err) {
      return toResponse(c, err)
    }
  })

  /** 票05：POST /drafts/:name/grant | /revoke {cloneName} ⇒ 200 SkillGrantReceipt。
   *  **条件注册**——deps 未接线（票04 形态）时路由面零动词=真 404（红线4 负断言纯形）；
   *  接线后才有生效链动词（人点卡才触发，红线3）。 */
  const grantHandler = (fn: (name: string, cloneName: string) => Promise<SkillGrantReceipt>) =>
    async (c: Context): Promise<Response> => {
      const name = c.req.param("name") ?? ""
      if (!SKILL_DRAFT_NAME_RE.test(name)) return badName(c, name)
      const payload = await c.req.json().catch(() => null)
      const raw = payload && typeof payload === "object" ? (payload as { cloneName?: unknown }).cloneName : undefined
      const cloneName = typeof raw === "string" ? raw.trim() : ""
      if (cloneName === "") {
        return c.json({ error: { code: "INVALID_PARAM", message: "cloneName 必须是非空字符串（分身名；'*'=授给所有分身落共享层）" } }, 400)
      }
      try {
        const receipt = await fn(name, cloneName)
        return c.json(receipt, 200)
      } catch (err) {
        return toResponse(c, err)
      }
    }
  if (deps.grant) routes.post("/drafts/:name/grant", grantHandler(deps.grant))
  if (deps.revoke) routes.post("/drafts/:name/revoke", grantHandler(deps.revoke))

  return routes
}
