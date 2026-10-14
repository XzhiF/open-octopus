// packages/server/src/services/knowledge/skill-draft-service.ts
//
// skill 草案检测+改写服务 — P3 票04 主服务（spec §skill 草案管线，故事 15-17/24）。
//
// 三路检测（阈值宽进严出——产出都过人裁）：
//  * **a 路** 跨 task 工具序列相似（skill-seq.ts 纯判据）：归档 hook 第⑤步后触发，
//    读本次素材包 exec-jsonl-excerpt 的失败工具序列，与既有包语料比 LCS 保序相似，
//    命中 ⇒ 模板草案（确定性，零 LLM）。
//  * **b 路** 判例蒸馏「流程型」转草案：巡检产出后触发，只读票03 的 rule_ref/蒸馏产物
//    面（status=distilled ∧ rule_ref 在场），流程型判据（skill-detect.ts）命中 ⇒ 模板草案。
//  * **c 路** 策展人编译素材包主动提议：归档 hook 同点触发，LLM seam（propose）读包
//    提议 reusable 流程——prompt 契约进 S1 断言，内容质量不进（spec Testing Decisions）。
//
// 落盘全部经 skill-draft-store（drafts 区单点）：**纯 fs 写，零入队**——红线2 的 wiki
// 串行队列不适用此区（草案是待授予过程资产，不是知识面）；同时本服务
// **不接任何 wiki/cases 写面**（b 路只读 scanWikiEntries）。
//
// 红线4（本票只到草案）：全文没有分身技能目录/agent_versions/installOrUpgrade 的
// 任何引用——granted 态草案对本服务只读拒写（改写/退役皆拒），生效链是票05 的边界。
// 红线3：status 三值 draft|granted|revoked，无 pending——卡上人裁是授予治理。
// 红线5：agent 记忆域零触碰；K11 零触碰（失败永不抛穿 hook 链，与投喂/判例同律）。
//
// 幂等（store 单点执行）：同来源活跃草案在场 ⇒ DUPLICATE_SOURCE——a/b 两路会被
// 重复触发（重归档不可达 deduped 早退、巡检常跑），宁少勿滥；c 路缺省 source 带
// 描述哈希后缀，同批多条互不吞、重跑同批互吞。

import fs from "fs"
import path from "path"
import type { KcCardEvent, KcSkillDraftCardData, KcSkillDraftSourceRef } from "@octopus/shared"
import { LOCATABLE_SOURCE_RE, SKILL_DRAFT_NAME_RE } from "@octopus/shared"
import { resolveKnowledgeRoot, getRawDir } from "./global-paths"
import {
  loadPackForCompile,
  packActiveItems,
  readPackManifest,
  type MaterialPackItem,
  type MaterialPackManifest,
} from "./material-pack"
import { stripRawFrontMatter, sha256Text, sha10 } from "./raw"
import { scanWikiEntries } from "./wiki/compile"
import { parseCaseMarkdown } from "./wiki/format"
import { parseCaseSections } from "./case-extract-service"
import { isProceduralCase, skillBodyFromCase, skillBodyFromSequence, DISCIPLINE_LINES } from "./skill-detect"
import { extractToolSequence, findSimilarSequenceTask } from "./skill-seq"
import {
  listDrafts,
  patchDraftBody,
  readDraft,
  retireDraft,
  writeDraft,
  type SkillDraftRecord,
} from "./skill-draft-store"
import type { LLMCall } from "./llm"

// ── 运营参数（单源常量，测试钉值）─────────────────────────────────────

/** 单次 c 路提议最多产草案数（防洪——判例 CASE_DRAFT_MAX 同族纪律）。 */
export const SKILL_DRAFT_MAX = 3

/** a 路语料扫描的既有包上限（taskId 字典序取先；素材包面自归档起只增，够用即止）。 */
export const SKILL_PACK_SCAN_MAX = 12

/** 单件素材进提议 prompt 的读面预算走 loadPackForCompile（material-pack 单源，不另造）。 */

const ARCHIVE_PACK_DIR_RE = /^task-([A-Za-z0-9][A-Za-z0-9._-]*)$/

// ── 错误制式（PackOpsError/CaseArchiveError 同族：code 稳定词 + HTTP status）──

export class SkillDraftError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(`${code}: ${message}`)
    this.name = "SkillDraftError"
  }
}

// ── c 路：提议 prompt 与解析（纯函数单源，S1 断言入口）─────────────────

export interface SkillProposeFacts {
  taskId: string
  packSection: string
}

export function buildSkillProposePrompt(f: SkillProposeFacts): string {
  return `# skill 草案提议（策展编译素材包 · task ${f.taskId}）

你是任务归档策展人。除编译知识页外，你还要从这份素材包里**主动提议**值得沉淀为
可复用技能（SKILL.md）的操作流程——判据：这套「怎么干」在素材里真实发生过、
且大概率会在别的任务里重演（修复序列/排障步骤/固定操作流）。

## 输出契约

只输出一个 JSON 对象（可 \`\`\`json 围栏），形状：

{"skills":[{"name":"<kebab 短名，可省——省则服务端派生>","description":"<一句话说清这条流程>",
"trigger":"<什么现场该用它>","steps":["<有序步骤，≥1>"],"discipline":["<执行纪律，可省>"],
"source":"<素材里可见的 exec:/task: 指针，可省>"}]}

硬性纪律：
1. steps 必须来自素材包真实记录的操作序列，不得虚构；description/steps 缺一走一弃。
2. 最多 ${SKILL_DRAFT_MAX} 条；没有值得沉淀的流程就输出 {"skills":[]}——宁缺毋滥。
3. 产出只是**草案**（status: draft）：授予与否由 owner 人裁，你不做授予。

## 素材包（manifest 先行按需下钻 · task ${f.taskId}）

${f.packSection}
`
}

export interface SkillProposal {
  name?: string
  description: string
  trigger: string
  steps: string[]
  discipline: string[]
  source: string
}

export function parseSkillProposals(resp: string, taskId: string): SkillProposal[] {
  let text = resp.trim()
  if (text === "") return []
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return []
  let plan: unknown
  try {
    plan = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  const skills = (plan as { skills?: unknown }).skills
  if (!Array.isArray(skills)) return []
  const out: SkillProposal[] = []
  for (const raw of skills) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const rec = raw as Record<string, unknown>
    const description = typeof rec.description === "string" ? rec.description.trim() : ""
    const steps = Array.isArray(rec.steps)
      ? rec.steps.filter((s): s is string => typeof s === "string" && s.trim() !== "").map(s => s.trim())
      : []
    if (description === "" || steps.length === 0) continue // 缺一就走一弃（坏条剔除不整批弃）
    const name = typeof rec.name === "string" && SKILL_DRAFT_NAME_RE.test(rec.name) ? rec.name : undefined
    const trigger = typeof rec.trigger === "string" ? rec.trigger.trim() : ""
    const discipline = Array.isArray(rec.discipline)
      ? rec.discipline.filter((d): d is string => typeof d === "string" && d.trim() !== "").map(d => d.trim())
      : []
    const rawSource = typeof rec.source === "string" ? rec.source.trim() : ""
    const source = LOCATABLE_SOURCE_RE.test(rawSource)
      ? rawSource
      : `task:${taskId}#${sha10(description).slice(0, 6)}` // 缺省带描述位后缀：同批互不吞、重跑互吞（幂等）
    out.push({ description: description.slice(0, 200), trigger, steps: steps.slice(0, 30), discipline: discipline.slice(0, 10), source, ...(name ? { name } : {}) })
    if (out.length >= SKILL_DRAFT_MAX) break
  }
  return out
}

function proposalBody(p: SkillProposal): string {
  return [
    `# ${p.description}`,
    "",
    "## 触发条件",
    "",
    `- ${p.trigger === "" ? "（提议未给触发条件——对话可补，或按步骤首项的现场特征判断）" : p.trigger}`,
    "",
    "## 步骤",
    "",
    p.steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    "",
    "## 纪律",
    "",
    ...p.discipline.map(d => `- ${d}`),
    ...DISCIPLINE_LINES,
    "",
  ].join("\n")
}

// ── 改写 prompt（对话修改草案的执行面：owner 指令 + 现行全稿进 seam）────

export interface SkillReviseFacts {
  name: string
  description: string
  currentBody: string
  instruction: string
}

export function buildSkillRevisePrompt(f: SkillReviseFacts): string {
  return `# skill 草案对话改写（${f.name}）

owner 指令：「${f.instruction}」

请按指令改写下面这份 SKILL.md 草案，**只输出改写后的 markdown 正文**
（不要 front-matter、不要代码围栏外的解释）。硬性纪律：
1. 保持 \`## 触发条件\` / \`## 步骤\` / \`## 纪律\` 三段结构（\`## 步骤\` 恒在——服务端结构闸）。
2. 只动 owner 指到的部分，其余逐字保留；不得虚构素材外的操作。
3. status/source 等治理字段由服务端管理，与你的输出无关——草案仍是 draft。

## 现行草案（description: ${f.description}）

${f.currentBody}
`
}

// ── Outcome ──────────────────────────────────────────────────────────

export interface SkillDraftCreatedItem {
  name: string
  path: string
  origin: SkillDraftRecord["fm"]["origin"]
}

export interface SkillDetectOutcome {
  created: SkillDraftCreatedItem[]
  /** 各步稳定原因码（NO_SEQUENCE 类不算错——检测的诚实缺席形；仅进日志/测试） */
  reasons: string[]
}

// ── Deps ─────────────────────────────────────────────────────────────

export interface SkillDraftServiceDeps {
  /** 知识根（测试注入 tmpdir；缺省 resolveKnowledgeRoot()，patrol/case-extract 同律） */
  root?: string
  /** c 路提议 LLM seam（生产 = createProductionSkillProposer；测试恒 fixture mock） */
  propose: LLMCall
  /** 对话改写 LLM seam（生产 = createProductionSkillReviser） */
  revise: LLMCall
  /** 草案卡 Lane A 生产者（index.ts 接 appendKnowledgeSessionCards；缺省不产卡，抛错吞 stderr） */
  announceDraft?: (event: KcCardEvent) => void
  now?: () => Date
}

// ── Service ──────────────────────────────────────────────────────────

export class SkillDraftService {
  readonly root: string
  private readonly wikiRoot: string
  private readonly propose: LLMCall
  private readonly revise: LLMCall
  private readonly announceDraft?: (event: KcCardEvent) => void
  private readonly now: () => Date

  constructor(deps: SkillDraftServiceDeps) {
    this.root = resolveKnowledgeRoot(deps.root)
    this.wikiRoot = path.join(this.root, "wiki")
    this.propose = deps.propose
    this.revise = deps.revise
    this.announceDraft = deps.announceDraft
    this.now = deps.now ?? (() => new Date())
  }

  // ── 检测入口（a+c：归档 hook 第⑤步后）──────────────────────────────

  /**
   * 单任务归档检测：a 路（序列相似，确定性零 LLM）→ c 路（策展提议 LLM）。
   * **永不抛错**——一切失败收敛进 reasons（与投喂/判例链同律：不阻塞 done）。
   */
  async detectForTask(taskId: string): Promise<SkillDetectOutcome> {
    const created: SkillDraftCreatedItem[] = []
    const reasons: string[] = []
    const manifest = readPackManifest(this.root, taskId)
    if (!manifest) return { created, reasons: ["PACK_NOT_FOUND"] }

    this.detectSequence(taskId, manifest, created, reasons)
    await this.detectProposal(taskId, created, reasons)
    return { created, reasons }
  }

  // ── 检测入口（b：巡检产出后）────────────────────────────────────────

  /**
   * 蒸馏判例面扫描（只读）：status=distilled ∧ rule_ref 在场 ∧「流程型」判据 ⇒ 草案。
   * 判例正文/文件零改写（红线2 wiki/cases 写面不碰；drafts 区写不在射程，见文件头）。
   */
  detectProceduralCases(): SkillDetectOutcome {
    const created: SkillDraftCreatedItem[] = []
    const reasons: string[] = []
    let cases
    try {
      cases = scanWikiEntries(this.wikiRoot)
        .filter(e => e.case !== undefined && e.relPath.startsWith("cases/"))
        .sort((a, b) => a.relPath.localeCompare(b.relPath))
    } catch (err) {
      process.stderr.write(`[skill-draft] case scan failed: ${err instanceof Error ? err.message : String(err)}\n`)
      return { created, reasons: ["CASE_SCAN_FAILED"] }
    }
    for (const entry of cases) {
      const fm = entry.case!
      if (fm.status !== "distilled" || fm.rule_ref === undefined) continue
      const abs = path.join(this.wikiRoot, entry.relPath)
      let body: string
      try {
        body = parseCaseMarkdown(fs.readFileSync(abs, "utf-8")).body
      } catch {
        continue // 读败=诚实缺席
      }
      const sections = parseCaseSections(body)
      if (!isProceduralCase(fm.symptom, sections)) continue

      const res = writeDraft(this.root, {
        name: `flow-${fm.id}`,
        description: `判例「${fm.symptom}」蒸馏出的操作流程（规则锚 ${fm.rule_ref}）`,
        origin: "case-procedural",
        source: `case:${fm.id}`,
        sourcePath: entry.relPath,
        body: skillBodyFromCase({
          caseId: fm.id,
          casePath: entry.relPath,
          symptom: fm.symptom,
          fix: sections.修复,
          lesson: sections.教训,
          ruleRef: fm.rule_ref,
        }),
        createdAt: this.now().toISOString(),
        caseId: fm.id,
        ruleRef: fm.rule_ref,
      })
      if (res.created && res.name) {
        created.push({ name: res.name, path: res.path!, origin: "case-procedural" })
        this.announce(res.name, "created", [{ kind: "case", pointer: entry.relPath, label: fm.symptom }])
      } else if (res.reason) {
        reasons.push(res.reason)
      }
    }
    return { created, reasons }
  }

  // ── a 路内部 ────────────────────────────────────────────────────────

  private detectSequence(taskId: string, manifest: MaterialPackManifest, created: SkillDraftCreatedItem[], reasons: string[]): void {
    const selfExcerpt = this.readExcerpt(manifest, reasons)
    if (!selfExcerpt) return
    const selfSeq = extractToolSequence(selfExcerpt.payload)
    if (selfSeq.length === 0) {
      reasons.push("NO_TOOL_SEQUENCE")
      return
    }

    const corpus: Array<{ taskId: string; seq: string[]; itemPath: string }> = []
    for (const otherId of this.otherPackIds(taskId)) {
      const otherManifest = readPackManifest(this.root, otherId)
      if (!otherManifest) continue
      const excerpt = this.readExcerpt(otherManifest, reasons)
      if (!excerpt) continue
      const seq = extractToolSequence(excerpt.payload)
      if (seq.length > 0) corpus.push({ taskId: otherId, seq, itemPath: excerpt.item.path })
    }

    const hit = findSimilarSequenceTask(taskId, selfSeq, corpus)
    if (!hit) {
      reasons.push("SEQ_BELOW_THRESHOLD")
      return
    }
    const [first, second] = [taskId, hit.taskId].sort()
    const firstItem = first === taskId ? selfExcerpt.item.path : corpus.find(c => c.taskId === first)!.itemPath
    const secondItem = second === taskId ? selfExcerpt.item.path : corpus.find(c => c.taskId === second)!.itemPath
    const sourceRefs: KcSkillDraftSourceRef[] = [
      { kind: "pack", pointer: firstItem, label: `exec 摘录 · task-${first}` },
      { kind: "pack", pointer: secondItem, label: `exec 摘录 · task-${second}` },
    ]

    const res = writeDraft(this.root, {
      name: `flow-${sha10(`${first}|${second}|${selfSeq.join(",")}`)}`,
      description: `跨 task 重复的失败修复工具序列（${first} × ${second}，相似 ${hit.score.toFixed(2)}）`,
      origin: "sequence-similar",
      source: `pack:task-${first}; pack:task-${second}`,
      sourcePath: firstItem,
      body: skillBodyFromSequence({ selfTaskId: taskId, otherTaskId: hit.taskId, seq: selfSeq, score: hit.score }),
      createdAt: this.now().toISOString(),
      taskId,
      similarity: Number(hit.score.toFixed(4)),
    })
    if (res.created && res.name) {
      created.push({ name: res.name, path: res.path!, origin: "sequence-similar" })
      this.announce(res.name, "created", sourceRefs)
    } else if (res.reason) {
      reasons.push(res.reason)
    }
  }

  /** 其他素材包 id（字典序取先 SKILL_PACK_SCAN_MAX 个——语料有界，扫描不失控）。 */
  private otherPackIds(selfTaskId: string): string[] {
    let entries: string[]
    try {
      entries = fs.readdirSync(getRawDir(this.root, "archives"))
    } catch {
      return []
    }
    return entries
      .map(name => ARCHIVE_PACK_DIR_RE.exec(name)?.[1])
      .filter((id): id is string => id !== undefined && id !== selfTaskId)
      .sort()
      .slice(0, SKILL_PACK_SCAN_MAX)
  }

  private readExcerpt(manifest: MaterialPackManifest, reasons: string[]): { item: MaterialPackItem; payload: string } | undefined {
    const item = packActiveItems(manifest).find(i => i.kind === "exec-jsonl-excerpt")
    if (!item) return undefined
    const abs = path.join(this.root, ...item.path.split("/"))
    let payload: string
    try {
      payload = stripRawFrontMatter(fs.readFileSync(abs, "utf-8"))
    } catch {
      reasons.push("PACK_ITEM_MISSING")
      return undefined
    }
    if (sha256Text(payload) !== item.sha256) {
      reasons.push("PACK_HASH_MISMATCH")
      return undefined
    }
    return { item, payload }
  }

  // ── c 路内部 ────────────────────────────────────────────────────────

  private async detectProposal(taskId: string, created: SkillDraftCreatedItem[], reasons: string[]): Promise<void> {
    let packSection: string
    let loadedPaths: string[]
    try {
      const load = loadPackForCompile(this.root, taskId)
      packSection = load.promptSection
      loadedPaths = load.loadedPaths
    } catch (err) {
      const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "PACK_READ_FAILED"
      process.stderr.write(`[skill-draft] pack read failed for ${taskId}: ${code}\n`)
      reasons.push(code)
      return
    }

    let resp = ""
    try {
      resp = await this.propose(buildSkillProposePrompt({ taskId, packSection }))
    } catch (err) {
      process.stderr.write(`[skill-draft] propose failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}\n`)
      reasons.push("PROPOSE_FAILED")
      return
    }
    if (resp.trim() === "") {
      reasons.push("PROPOSE_EMPTY")
      return
    }
    const proposals = parseSkillProposals(resp, taskId)
    if (proposals.length === 0) {
      reasons.push("NO_VALID_PROPOSAL")
      return
    }
    const sourceRefs: KcSkillDraftSourceRef[] = loadedPaths.slice(0, 6).map(p => ({
      kind: "pack",
      pointer: p,
      label: `素材件 · ${p.split("/").pop() ?? p}`,
    }))
    for (const p of proposals) {
      const res = writeDraft(this.root, {
        name: p.name ?? `prop-${sha10(`${taskId}|${p.description}`)}`,
        description: p.description,
        origin: "curator-proposal",
        source: p.source,
        sourcePath: loadedPaths[0],
        body: proposalBody(p),
        createdAt: this.now().toISOString(),
        taskId,
      })
      if (res.created && res.name) {
        created.push({ name: res.name, path: res.path!, origin: "curator-proposal" })
        this.announce(res.name, "created", sourceRefs)
      } else if (res.reason) {
        reasons.push(res.reason)
      }
    }
  }

  // ── 对话改写 / 退役（票面第 4/6 行）─────────────────────────────────

  /**
   * owner 说改哪里 → 策展人 LLM seam 改写 → drafts 文件本体替换 → 卡刷新再预览。
   * status 恒 draft；失败（seam 炸/空/缺结构）零痕迹抛 SkillDraftError（路由层翻 HTTP）。
   */
  async reviseDraft(name: string, instruction: string): Promise<{ name: string; status: "draft"; path: string; updatedAt: string }> {
    const rec = readDraft(this.root, name)
    if (!rec) throw new SkillDraftError("DRAFT_NOT_FOUND", `草案不在盘或坏形：${name}`, 404)
    if (rec.fm.status === "granted") throw new SkillDraftError("DRAFT_GRANTED", "已授予草案的改写属票05 撤销/再授予流程", 409)
    if (rec.fm.status === "revoked") throw new SkillDraftError("DRAFT_REVOKED", "已退役草案留档不可改写（重提议走检测）", 409)

    const prompt = buildSkillRevisePrompt({ name, description: rec.fm.description, currentBody: rec.body, instruction })
    let rewritten = ""
    try {
      rewritten = await this.revise(prompt)
    } catch (err) {
      throw new SkillDraftError("REVISE_FAILED", err instanceof Error ? err.message : String(err), 500)
    }
    if (rewritten.trim() === "") throw new SkillDraftError("REVISE_EMPTY", "改写 LLM 无响应（缺席或被禁用）", 502)
    if (!rewritten.includes("## 步骤")) throw new SkillDraftError("REVISE_BAD_SHAPE", "改写结果缺 ## 步骤结构闸（正文不落半成品）", 502)

    const now = this.now().toISOString()
    const patch = patchDraftBody(this.root, name, { body: rewritten.trim(), now })
    if (!patch.ok) {
      throw new SkillDraftError(patch.reason ?? "REVISE_FAILED", patch.detail ?? "改写落盘失败", 500)
    }
    const fresh = readDraft(this.root, name)
    if (fresh) this.announceRecord(fresh, "revised")
    return { name, status: "draft", path: patch.path!, updatedAt: now }
  }

  /** 退役草案（status→revoked 留档；granted 拒——撤销授予=票05 机械链，红线4）。 */
  retireDraft(name: string): { name: string; status: "revoked"; path: string } {
    const res = retireDraft(this.root, name)
    if (!res.ok) {
      const code = res.reason ?? "DRAFT_NOT_FOUND"
      const status = code === "DRAFT_GRANTED" ? 409 : code === "DRAFT_ALREADY_REVOKED" ? 409 : code === "INVALID_NAME" ? 400 : 404
      throw new SkillDraftError(code, res.detail ?? `草案退役失败：${name}`, status)
    }
    const rec = readDraft(this.root, name)
    if (rec) this.announceRecord(rec, "retired")
    return { name, status: "revoked", path: res.path! }
  }

  // ── 读面直通（S2 路由底座）──────────────────────────────────────────

  listDrafts(): SkillDraftRecord[] {
    return listDrafts(this.root)
  }

  readDraft(name: string): SkillDraftRecord | undefined {
    return readDraft(this.root, name)
  }

  // ── 卡通知（Lane A 生产者；announce 炸只吞 stderr——通知失败不毁草案，先存后知同律）──

  private announce(name: string, action: KcSkillDraftCardData["action"], sourceRefs: KcSkillDraftSourceRef[]): void {
    const rec = readDraft(this.root, name)
    if (rec) this.announceRecord(rec, action, sourceRefs)
  }

  private announceRecord(rec: SkillDraftRecord, action: KcSkillDraftCardData["action"], sourceRefs?: KcSkillDraftSourceRef[]): void {
    if (!this.announceDraft) return
    try {
      // 显式 refs（三路产卡）优先；改写/退役重发回落 front-matter sourcePath（可点面不丢）
      const refs: KcSkillDraftSourceRef[] = sourceRefs ?? (rec.fm.sourcePath !== undefined
        ? [{
            kind: rec.fm.origin === "case-procedural" ? "case" : "pack",
            pointer: rec.fm.sourcePath,
            label: rec.fm.origin === "case-procedural" ? "源判例" : "来源原件",
          }]
        : [{ kind: "exec", pointer: rec.fm.source, label: "来源指针（front-matter 原样）" }])
      const data: KcSkillDraftCardData = {
        draftName: rec.fm.name,
        description: rec.fm.description,
        status: rec.fm.status,
        origin: rec.fm.origin,
        source: rec.fm.source,
        skillPath: rec.relPath,
        content: rec.body,
        sourceRefs: refs,
        skillName: rec.fm.name,
        ...(rec.fm.taskId !== undefined ? { taskId: rec.fm.taskId } : {}),
        ...(rec.fm.caseId !== undefined ? { caseId: rec.fm.caseId } : {}),
        ...(rec.fm.ruleRef !== undefined ? { ruleRef: rec.fm.ruleRef } : {}),
        ...(rec.fm.similarity !== undefined ? { similarity: rec.fm.similarity } : {}),
        action,
      }
      this.announceDraft({ id: `skl-${rec.fm.name}`, kind: "skill-draft", ts: this.now().toISOString(), data })
    } catch (err) {
      process.stderr.write(`[skill-draft] announce failed for ${rec.fm.name}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
}
