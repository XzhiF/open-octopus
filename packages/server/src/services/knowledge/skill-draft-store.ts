// packages/server/src/services/knowledge/skill-draft-store.ts
//
// skill 草案落盘契约 — P3 票04（spec §skill 草案管线，故事 24；票面第 1 行）。
//
// 草案 = 「怎么干」资产的**待授予过程形态**：知识根 `drafts/skills/{name}/SKILL.md`。
//  * **不在 wiki git 仓、不是知识页、不进 INDEX**——纯 fs 写（红线2 的 wiki 串行
//    队列**不适用**此区；授予链改的是分身能力面不是知识面）。
//  * front-matter 治理面记来源指针（pack:/task:/exec:/case: 族）+ status: draft。
//  * 人工文件写保护语义不绕（assertNotManualFile 同律的目录逃逸闸）：名字钉
//    SKILL_DRAFT_NAME_RE（kebab + 点，无下划线/斜杠/`..`），解析目标恒收敛在
//    drafts 根内；SCHEMA.md 形态从字面上不可能落此区。
//  * 幂等（票面「草案可溯源但不污染 wiki」的自决口径）：
//      - 同来源指针活跃草案（draft|granted）在场 ⇒ DUPLICATE_SOURCE 拒绝重复产出
//        （三路检测都会被重复触发，宁少勿滥——产出过人裁）；
//      - 同名目录被占（异来源）⇒ 新草案落 `{name}-2…-9` 后缀位，**绝不静默覆盖**；
//      - revoked 草案留档不挡同来源再提议（撤销是人裁生命周期）。
//    改写通道（patchDraftBody/对话修订）是**显式人裁动作**，覆盖文件本体合法；
//    退役 = status→revoked 原地翻行（其余字节逐字不动，可溯源留档）。
//
// 红线4：本模块**没有**任何指向分身技能目录/agent_versions/upgrade 原语的读写路径；
// granted/revoked 两态的写入者只能是票05。红线5：agent 记忆域零触碰。

import fs from "fs"
import path from "path"
import {
  SKILL_DRAFT_NAME_RE,
  SKILL_DRAFT_ORIGINS,
  SKILL_DRAFT_STATUSES,
  type SkillDraftOrigin,
  type SkillDraftStatus,
} from "@octopus/shared"
import { getSkillDraftsRoot } from "./global-paths"

/** 草案文件名钉位（目录名=草案名，文件恒 SKILL.md——SDK 技能目录形态，票05 可整目录搬运）。 */
export const SKILL_DRAFT_FILE_NAME = "SKILL.md"

/** 草案区的知识根相对前缀（draftRelPath 单源公式的常量位）。 */
const SKILL_DRAFT_FILE_DIR_PREFIX = "drafts/skills/"

/** 同名冲突后缀上限（撞位 9 个仍占 = 让位不硬写）。 */
const NAME_SUFFIX_MAX = 9

// ── 类型 ──────────────────────────────────────────────────────────────

export interface SkillDraftFrontmatter {
  name: string
  description: string
  status: SkillDraftStatus
  origin: SkillDraftOrigin
  /** 来源指针串（`; ` 连接：pack:task-{id} / task:{id} / exec:{id} / case:{caseId}） */
  source: string
  createdAt: string
  updatedAt: string
  /** 检测关联面（卡渲染/追溯用，可缺省） */
  taskId?: string
  caseId?: string
  /** 序列相似检测的相似度（仅 sequence-similar 携带） */
  similarity?: number
  /** 判例蒸馏规则锚（仅 case-procedural 携带，票03 rule_ref 边） */
  ruleRef?: string
  /** 来源原件路径（可点面：raw/archives/… 件 或 cases/… 页——revise/retire 重发卡通道保「来源指针可点」） */
  sourcePath?: string
  /**
   * P3 票05 授予面：已授予目标清单（分身名 ∪ `*`=共享技能层）。
   * **仅 granted 态非空**（setDraftGrantState 写）；revoked/draft 恒缺省——
   * 行缺 = 旧文件向后兼容（票04 草案读出 grantedTo undefined）。
   */
  grantedTo?: string[]
}

export interface SkillDraftInput {
  name: string
  description: string
  origin: SkillDraftOrigin
  source: string
  /** SKILL.md 正文（## 触发条件 / ## 步骤 / ## 纪律），不含 front-matter */
  body: string
  createdAt: string
  updatedAt?: string
  taskId?: string
  caseId?: string
  similarity?: number
  ruleRef?: string
  sourcePath?: string
}

export interface SkillDraftRecord {
  fm: SkillDraftFrontmatter
  /** 知识根相对 POSIX 路径 */
  relPath: string
  body: string
  content: string
}

/** 落盘结果（宽松联合——调用方按 created/reason 分支，无异常控制流）。 */
export interface DraftWriteResult {
  created: boolean
  /** created=true 时的最终目录名（可能带 -N 后缀） */
  name?: string
  /** created=true 时的知识根相对路径 */
  path?: string
  /** created=false 时的稳定原因码：INVALID_NAME | DUPLICATE_SOURCE | NAME_EXHAUSTED */
  reason?: string
  detail?: string
}

export interface DraftOpResult {
  ok: boolean
  path?: string
  /** DRAFT_NOT_FOUND | INVALID_NAME | DRAFT_GRANTED | DRAFT_REVOKED | DRAFT_ALREADY_REVOKED */
  reason?: string
  detail?: string
}

// ── 路径与名闸 ────────────────────────────────────────────────────────

/** 草案的知识根相对路径（单源公式；卡面/路由/票05 消费同一值）。 */
export function draftRelPath(name: string): string {
  return `${SKILL_DRAFT_FILE_DIR_PREFIX}${name}/${SKILL_DRAFT_FILE_NAME}`
}

function isValidName(name: string): boolean {
  return SKILL_DRAFT_NAME_RE.test(name)
}

/** 目录绝对位（名闸后拼接；名不合法返回 null——调用方零触碰 fs）。 */
function draftDirAbs(root: string, name: string): string | null {
  if (!isValidName(name)) return null
  const dirRoot = getSkillDraftsRoot(root)
  const abs = path.resolve(dirRoot, name)
  // 收敛闸（assertNotManualFile 同律的路径级防逃逸）：resolve 后必须仍在 drafts 根内
  const normRoot = path.resolve(dirRoot)
  if (abs !== normRoot && !abs.startsWith(normRoot + path.sep)) return null
  return abs
}

// ── front-matter 序列化/解析（扁平 key: value，可测往返）────────────────

function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim()
}

export function renderSkillDraftFile(fm: SkillDraftFrontmatter, body: string): string {
  const lines: string[] = [
    `name: ${fm.name}`,
    `description: ${oneLine(fm.description)}`,
    `status: ${fm.status}`,
  ]
  // 票05 授予面：grantedTo 恒紧跟 status 行（制式；空/缺省不落行=向后兼容）
  if (fm.grantedTo !== undefined && fm.grantedTo.length > 0) {
    lines.push(`grantedTo: ${fm.grantedTo.join(",")}`)
  }
  lines.push(`origin: ${fm.origin}`, `source: ${fm.source}`)
  if (fm.taskId !== undefined) lines.push(`taskId: ${fm.taskId}`)
  if (fm.caseId !== undefined) lines.push(`caseId: ${fm.caseId}`)
  if (fm.similarity !== undefined) lines.push(`similarity: ${String(fm.similarity)}`)
  if (fm.ruleRef !== undefined) lines.push(`ruleRef: ${fm.ruleRef}`)
  if (fm.sourcePath !== undefined) lines.push(`sourcePath: ${fm.sourcePath}`)
  lines.push(`createdAt: ${fm.createdAt}`, `updatedAt: ${fm.updatedAt}`)
  return `---\n${lines.join("\n")}\n---\n\n${body.replace(/\s+$/, "")}\n`
}

export function parseSkillDraftFile(text: string): { fm: SkillDraftFrontmatter; body: string } | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return undefined
  const fields = new Map<string, string>()
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const idx = line.indexOf(":")
    if (idx <= 0) continue
    fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim())
  }
  const name = fields.get("name") ?? ""
  const description = fields.get("description") ?? ""
  const status = fields.get("status") ?? ""
  const origin = fields.get("origin") ?? ""
  const source = fields.get("source") ?? ""
  const createdAt = fields.get("createdAt") ?? ""
  const updatedAt = fields.get("updatedAt") ?? ""
  if (!isValidName(name) || description === "" || source === "" || createdAt === "") return undefined
  if (!(SKILL_DRAFT_STATUSES as readonly string[]).includes(status)) return undefined
  if (!(SKILL_DRAFT_ORIGINS as readonly string[]).includes(origin)) return undefined
  const fm: SkillDraftFrontmatter = {
    name,
    description,
    status: status as SkillDraftStatus,
    origin: origin as SkillDraftOrigin,
    source,
    createdAt,
    updatedAt,
  }
  const taskId = fields.get("taskId")
  const caseId = fields.get("caseId")
  const ruleRef = fields.get("ruleRef")
  const sourcePath = fields.get("sourcePath")
  const grantedRaw = fields.get("grantedTo")
  const simRaw = fields.get("similarity")
  if (taskId) fm.taskId = taskId
  if (caseId) fm.caseId = caseId
  if (ruleRef) fm.ruleRef = ruleRef
  if (sourcePath) fm.sourcePath = sourcePath
  if (grantedRaw !== undefined) {
    const targets = grantedRaw.split(",").map(s => s.trim()).filter(s => s !== "")
    if (targets.length > 0) fm.grantedTo = targets
  }
  if (simRaw !== undefined) {
    const sim = Number(simRaw)
    if (Number.isFinite(sim)) fm.similarity = sim
  }
  const body = text.slice((m[0] ?? "").length).replace(/^\r?\n+/, "")
  return { fm, body }
}

// ── 读写面 ────────────────────────────────────────────────────────────

function readDraftAt(root: string, dirName: string): SkillDraftRecord | undefined {
  const abs = draftDirAbs(root, dirName)
  if (!abs) return undefined
  const fileAbs = path.join(abs, SKILL_DRAFT_FILE_NAME)
  let text: string
  try {
    text = fs.readFileSync(fileAbs, "utf-8")
  } catch {
    return undefined
  }
  const parsed = parseSkillDraftFile(text)
  if (!parsed) return undefined
  return { fm: parsed.fm, relPath: draftRelPath(dirName), body: parsed.body, content: text }
}

/**
 * 列出全部草案（按名排序；坏文件跳过 + stderr 显形，不炸列表）。
 * drafts 根不存在 = 尚无任何草案，空列表（不建目录——读面零副作用）。
 */
export function listDrafts(root: string): SkillDraftRecord[] {
  const dirRoot = getSkillDraftsRoot(root)
  let entries: string[]
  try {
    entries = fs.readdirSync(dirRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
  } catch {
    return []
  }
  const out: SkillDraftRecord[] = []
  for (const name of entries) {
    const rec = readDraftAt(root, name)
    if (rec) out.push(rec)
    else process.stderr.write(`[skill-draft] 草案坏形跳过：${draftRelPath(name)}\n`)
  }
  return out
}

/** 读单草案（名不合法/不在盘/坏形 ⇒ undefined——路由层翻 404）。 */
export function readDraft(root: string, name: string): SkillDraftRecord | undefined {
  return readDraftAt(root, name)
}

/**
 * 写新草案（三路检测共用落盘口）。**永不覆盖既有 SKILL.md**。
 * ① 名闸 → ② 同来源活跃草案拒绝 → ③ 同名占位加后缀 → ④ 落盘。
 */
export function writeDraft(root: string, input: SkillDraftInput): DraftWriteResult {
  if (!isValidName(input.name)) {
    return { created: false, reason: "INVALID_NAME", detail: `草案名不合规：'${input.name}'（要求 kebab 小写，可含 . 与 -）` }
  }
  if (input.source.trim() === "" || input.description.trim() === "" || input.body.trim() === "") {
    return { created: false, reason: "INVALID_NAME", detail: "草案缺 source/description/body 治理字段" }
  }

  // 同来源活跃草案在场 ⇒ 拒绝（revoked 不挡——撤销是人裁生命周期）
  const dup = listDrafts(root).find(d => d.fm.source === input.source && d.fm.status !== "revoked")
  if (dup) {
    return { created: false, reason: "DUPLICATE_SOURCE", detail: `来源指针已有活跃草案：${dup.relPath}` }
  }

  // 同名占位 ⇒ 后缀让位（不静默覆盖第一份）
  let finalName = input.name
  let abs = draftDirAbs(root, finalName)
  for (let i = 2; i <= NAME_SUFFIX_MAX && abs && fs.existsSync(path.join(abs, SKILL_DRAFT_FILE_NAME)); i++) {
    finalName = `${input.name}-${i}`
    abs = draftDirAbs(root, finalName)
  }
  if (!abs) return { created: false, reason: "INVALID_NAME", detail: `草案名解析逃逸：${finalName}` }
  if (fs.existsSync(path.join(abs, SKILL_DRAFT_FILE_NAME))) {
    return { created: false, reason: "NAME_EXHAUSTED", detail: `同名草案撞位超 ${NAME_SUFFIX_MAX} 个，让位不硬写` }
  }

  const fm: SkillDraftFrontmatter = {
    name: finalName,
    description: input.description,
    status: "draft",
    origin: input.origin,
    source: input.source,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.caseId !== undefined ? { caseId: input.caseId } : {}),
    ...(input.similarity !== undefined ? { similarity: input.similarity } : {}),
    ...(input.ruleRef !== undefined ? { ruleRef: input.ruleRef } : {}),
    ...(input.sourcePath !== undefined ? { sourcePath: input.sourcePath } : {}),
  }
  fs.mkdirSync(abs, { recursive: true })
  fs.writeFileSync(path.join(abs, SKILL_DRAFT_FILE_NAME), renderSkillDraftFile(fm, input.body), "utf-8")
  return { created: true, name: finalName, path: draftRelPath(finalName) }
}

/**
 * 对话改写执行面（票面第 4 行「改的是 drafts 区文件本体」）：正文替换 + 可选描述更新。
 * status 恒留 draft；source/createdAt 逐字保留；updatedAt 前移。
 * 显式人裁通道 ⇒ 覆盖合法（区别于 writeDraft 的首建防覆盖）。
 */
export function patchDraftBody(
  root: string,
  name: string,
  input: { body: string; description?: string; now: string },
): DraftOpResult {
  const rec = readDraft(root, name)
  if (!rec) return { ok: false, reason: "DRAFT_NOT_FOUND", detail: `草案不在盘或坏形：${name}` }
  if (rec.fm.status === "granted") return { ok: false, reason: "DRAFT_GRANTED", detail: "已授予草案的改写属票05 撤销/再授予流程" }
  if (rec.fm.status === "revoked") return { ok: false, reason: "DRAFT_REVOKED", detail: "已退役草案留档不可改写（重提议走检测）" }

  const abs = draftDirAbs(root, name)!
  const fm: SkillDraftFrontmatter = {
    ...rec.fm,
    description: input.description !== undefined && input.description.trim() !== "" ? oneLine(input.description) : rec.fm.description,
    updatedAt: input.now,
  }
  fs.writeFileSync(path.join(abs, SKILL_DRAFT_FILE_NAME), renderSkillDraftFile(fm, input.body), "utf-8")
  return { ok: true, path: rec.relPath }
}

/**
 * 退役草案（status→revoked，留档可溯源——票面「退役草案 status→revoked 或删」自决：留不留身）。
 * **拒绝对 granted 动手**（红线4：撤销授予是票05 机械链，本票不得越界）。
 * 原地翻 status 行，其余字节逐字不动（append-only 纪律同判例面）。
 */
export function retireDraft(root: string, name: string): DraftOpResult {
  const rec = readDraft(root, name)
  if (!rec) return { ok: false, reason: "DRAFT_NOT_FOUND", detail: `草案不在盘或坏形：${name}` }
  if (rec.fm.status === "granted") return { ok: false, reason: "DRAFT_GRANTED", detail: "已授予草案的撤销属票05 机械链（版本回退+目录移除），本区拒动" }
  if (rec.fm.status === "revoked") return { ok: false, reason: "DRAFT_ALREADY_REVOKED", detail: `草案已退役：${name}` }

  const abs = draftDirAbs(root, name)!
  const next = rec.content.replace(/^status: draft$/m, "status: revoked")
  fs.writeFileSync(path.join(abs, SKILL_DRAFT_FILE_NAME), next, "utf-8")
  return { ok: true, path: rec.relPath }
}

// ── 票05 授予面（granted/revoked 的唯一写入者 = SkillGrantService 机械链）────

export interface GrantStateInput {
  /** 目标态：granted（含多分身并授的 grantedTo 更新）或 revoked（撤到空） */
  status: SkillDraftStatus
  /** 授予目标全量清单（分身名 ∪ `*`）；granted 恒非空、revoked 恒空（不变量闸） */
  grantedTo: string[]
  now: string
}

/**
 * 授予/撤销的状态翻面（票04 交接制式：**原地翻 status 行 + grantedTo 邻位行，
 * 其余字节逐字不动**）。合法转移：draft→granted、granted→granted（并授/缩授）、
 * granted→revoked；revoked 是终态（再授予须重出草案——票04「留档不挡再提议」
 * 指的是检测产**新**草案，不复活旧件）。
 * 红线4：本函数只动 drafts 区文件的治理行——分身目录/预置源/版本的写权全在
 * 调用方（SkillGrantService）的机械链里，store 不越界。
 */
export function setDraftGrantState(root: string, name: string, input: GrantStateInput): DraftOpResult {
  const rec = readDraft(root, name)
  if (!rec) return { ok: false, reason: "DRAFT_NOT_FOUND", detail: `草案不在盘或坏形：${name}` }

  const from = rec.fm.status
  const to = input.status
  if (to === "granted" && input.grantedTo.length === 0) {
    return { ok: false, reason: "GRANT_STATE_CONFLICT", detail: "granted 态必须至少一个授予目标（不变量）" }
  }
  if (to === "revoked" && input.grantedTo.length > 0) {
    return { ok: false, reason: "GRANT_STATE_CONFLICT", detail: "revoked 态 grantedTo 必须为空（撤干净才算撤）" }
  }
  const legal =
    (from === "draft" && to === "granted") ||
    (from === "granted" && (to === "granted" || to === "revoked"))
  if (!legal) {
    return { ok: false, reason: "GRANT_STATE_TRANSITION", detail: `非法授予状态转移：${from}→${to}` }
  }

  const abs = draftDirAbs(root, name)!
  const lines = rec.content.split("\n")
  const si = lines.findIndex(l => /^status: (draft|granted|revoked)$/.test(l))
  if (si < 0) return { ok: false, reason: "GRANT_STATE_CONFLICT", detail: `盘上缺 status 治理行：${name}` }

  // 原地翻 status 行
  lines[si] = `status: ${to}`
  // grantedTo 邻位行：先摘既有，再按需插入（revoked/空 ⇒ 摘除不补）
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^grantedTo: /.test(lines[i]!)) lines.splice(i, 1)
  }
  if (input.grantedTo.length > 0) {
    lines.splice(si + 1, 0, `grantedTo: ${input.grantedTo.join(",")}`)
  }
  // updatedAt 前移（治理时间线；找不到行=坏形，保守不写）
  const ui = lines.findIndex(l => /^updatedAt: .+/.test(l))
  if (ui < 0) return { ok: false, reason: "GRANT_STATE_CONFLICT", detail: `盘上缺 updatedAt 治理行：${name}` }
  lines[ui] = `updatedAt: ${input.now}`

  fs.writeFileSync(path.join(abs, SKILL_DRAFT_FILE_NAME), lines.join("\n"), "utf-8")
  return { ok: true, path: rec.relPath }
}
