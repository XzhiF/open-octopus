import { Hono } from "hono"
import { SKILL_DRAFT_NAME_RE } from "@octopus/shared"
import { SkillDraftError } from "../services/knowledge/skill-draft-service"
import type { SkillDraftRecord } from "../services/knowledge/skill-draft-store"

/**
 * skill 草案路由 — P3 票04（S2 契约面；票面 S2「草案 CRUD 端点」）。挂 `/api/knowledge`：
 *
 *   GET  /drafts            ⇒ 200 { drafts: [view…] }（列出，含 revoked 留档行）
 *   GET  /drafts/:name      ⇒ 200 单草案全量（SKILL.md content）· 404 DRAFT_NOT_FOUND · 400 INVALID_PARAM
 *   POST /drafts/:name/revise { instruction } ⇒ 200 { name, status:'draft', path, updatedAt }
 *        （对话改写触发面：owner 指令 → 策展人 LLM seam 改写 → drafts 文件本体替换；
 *         错误面 400/404/409 DRAFT_GRANTED · 502 REVISE_EMPTY/REVISE_BAD_SHAPE · 500 REVISE_FAILED）
 *   POST /drafts/:name/retire ⇒ 200 { name, status:'revoked', path }（留档不删，可溯源）
 *
 * 红线4（票面明列）：**本路由零授予端点**——grant/revoke-clone/install 等生效链
 * 动词属票05；这里出现的 `revise`/`retire` 都只动 drafts 区文件，不触分身目录/版本表。
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

  return routes
}
