// packages/server/src/services/knowledge/material-pack.ts
//
// 素材包（Material Pack）— P3 归档资产化票02 契约模块（spec §Implementation Decisions「素材包」）。
//
// 形态：`raw/archives/task-{id}/` 目录 + `manifest.json`（包索引）。归档时六类一手素材
// （验收台账 / phase 打回记录 / 执行 JSONL 关键事件摘录 / PR diff stat+hunk /
// matt 产物指针 / ADR·context-notes）逐件冻结，总结降级为包内第七件。
//
// 契约与纪律：
//  * **件级冻结契约与既有单文件 raw 完全一致**：front-matter 五件套
//    （origin/title/ingestedAt/bytes/hash），hash=payload sha256，`wx` 排他写永不覆盖——
//    复用 raw.ts 的 renderRawFrontMatter/sha256Text/normalizeNewlines 单源，不另造口径。
//  * **manifest 是「包索引」，定义为可变件**（红线注：raw 不可变哲学落在素材件本体；
//    剔除某件 = manifest 标记 excluded（留审计），素材文件本体永不改写/删除）。
//  * **编译读包 = manifest 先行、按需下钻单件**（token 预算纪律）：
//    loadPackForCompile 产出 prompt 面——清单恒在，单件正文只在预算内/焦点命中时载入，
//    超预算件以「未载入，按需回源读 {path}」显形（禁静默）。
//  * 历史兼容：旧单文件 `task-{id}-summary.md` 不迁移不报错（读取方各自兼容）。
//  * 本模块零队列零 wiki 触碰——落盘属 raw 冻结（不入队，票02 同律）；wiki 写永远经队列。

import fs from "fs"
import path from "path"
import { getRawDir } from "./global-paths"
import { normalizeNewlines, renderRawFrontMatter, sha256Text, stripRawFrontMatter } from "./raw"

// ── 命名契约（单源；测试/路由/卡片/UI 按值消费）───────────────────────

/** 六类一手素材 kind（spec 素材包契约逐字；顺序 = 包内编号序）。 */
export const MATERIAL_ITEM_KINDS = [
  "acceptance-ledger",
  "phase-rejections",
  "exec-jsonl-excerpt",
  "pr-diff",
  "matt-artifacts",
  "adr-context-notes",
] as const
export type MaterialItemKind = (typeof MATERIAL_ITEM_KINDS)[number]

/** 总结降级为包内一件（票02「唯一产物 → 之一」）。 */
export const ARCHIVE_SUMMARY_KIND = "archive-summary"

export const PACK_MANIFEST_FILE = "manifest.json"

/** 包目录名（钉名安全律由调用方的 TASK_ID_RE 前置保证）。 */
export function packDirName(taskId: string): string {
  return `task-${taskId}`
}

/** 包目录的知识根相对 POSIX 路径。 */
export function packDirRel(taskId: string): string {
  return `raw/archives/${packDirName(taskId)}`
}

/** manifest 的知识根相对路径（入队 label / 路由消费面）。 */
export function packManifestRel(taskId: string): string {
  return `${packDirRel(taskId)}/${PACK_MANIFEST_FILE}`
}

// ── 类型 ──────────────────────────────────────────────────────────────

export interface MaterialPackItem {
  kind: string
  /** 人读名（素材包卡「名/类/大小」的「名」） */
  name: string
  /** 可定位回源指针（db:/task-home:/exec:/git: 前缀族，spec 故事2 溯源链） */
  origin: string
  /** 知识根相对 POSIX 路径（raw/archives/task-{id}/NN-….md） */
  path: string
  bytes: number
  /** payload 的 sha256（与件内 front-matter hash 同源同值——冻结契约对质凭据） */
  sha256: string
  /** 剔除标记（人裁素材源；本体文件不删，红线3：不是审批态，是策展事实记录） */
  excluded?: boolean
}

export interface MaterialPackRecompile {
  at: string
  excludePath?: string | null
  focus?: string | null
  queueTaskId: string
}

export interface MaterialPackManifest {
  v: 1
  taskId: string
  createdAt: string
  updatedAt?: string
  items: MaterialPackItem[]
  recompiles: MaterialPackRecompile[]
}

export class MaterialPackError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(`${code}: ${message}`)
    this.name = "MaterialPackError"
  }
}

const PACK_DIR_RE = /^task-[A-Za-z0-9][A-Za-z0-9._-]*$/
/** 件名 = 单段安全 .md 名（与 PINNED_FILE_RE 同律）。 */
const PACK_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/

// ── writer/reader（件冻结 + manifest 读写）────────────────────────────

export function packDirAbs(root: string, taskId: string): string {
  return path.join(getRawDir(root, "archives"), packDirName(taskId))
}

/**
 * 单件冻结落盘：front-matter 五件套 + payload，`wx` 排他。同 hash 重放 = 幂等回指；
 * 异 hash 撞钉名位 = 抛 MaterialPackError(CONFLICT)——不可变源绝不改写第一份。
 */
export function freezePackItem(
  root: string,
  taskId: string,
  input: { fileName: string; kind: string; name: string; origin: string; title: string; payload: string; ingestedAt?: string },
): MaterialPackItem {
  if (!PACK_FILE_RE.test(input.fileName)) {
    throw new MaterialPackError("INVALID_PARAM", `件名须为单段安全 .md 名：${input.fileName}`, 400)
  }
  const dirAbs = packDirAbs(root, taskId)
  fs.mkdirSync(dirAbs, { recursive: true })
  const payload = normalizeNewlines(input.payload)
  const sha = sha256Text(payload)
  const bytes = Buffer.byteLength(payload, "utf-8")
  const abs = path.join(dirAbs, input.fileName)
  const body = renderRawFrontMatter({
    origin: input.origin,
    title: input.title,
    ingestedAt: input.ingestedAt ?? new Date().toISOString(),
    bytes,
    hash: sha,
  }) + payload
  try {
    fs.writeFileSync(abs, body, { flag: "wx" })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    let current = ""
    try {
      current = fs.readFileSync(abs, "utf-8")
    } catch {
      throw new MaterialPackError("CONFLICT", `钉名位不可读：${input.fileName}`, 409)
    }
    const currentHash = sha256Text(stripRawFrontMatter(current))
    if (currentHash === sha) return { kind: input.kind, name: input.name, origin: input.origin, path: `${packDirRel(taskId)}/${input.fileName}`, bytes, sha256: sha }
    throw new MaterialPackError("CONFLICT", `钉名位内容已不同（不可变契约）：${input.fileName}`, 409)
  }
  return { kind: input.kind, name: input.name, origin: input.origin, path: `${packDirRel(taskId)}/${input.fileName}`, bytes, sha256: sha }
}

export function readPackManifest(root: string, taskId: string): MaterialPackManifest | null {
  const abs = path.join(packDirAbs(root, taskId), PACK_MANIFEST_FILE)
  let text: string
  try {
    text = fs.readFileSync(abs, "utf-8")
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text) as MaterialPackManifest
    if (parsed.v !== 1 || parsed.taskId !== taskId || !Array.isArray(parsed.items)) return null
    return parsed
  } catch {
    return null
  }
}

/** manifest 是可变的包索引（剔除标记/总结追加都重写它；素材件本体永不改写）。 */
export function writePackManifest(root: string, taskId: string, manifest: MaterialPackManifest): void {
  const dirAbs = packDirAbs(root, taskId)
  fs.mkdirSync(dirAbs, { recursive: true })
  fs.writeFileSync(path.join(dirAbs, PACK_MANIFEST_FILE), JSON.stringify(manifest, null, 2), "utf-8")
}

export function packActiveItems(manifest: MaterialPackManifest): MaterialPackItem[] {
  return manifest.items.filter(i => !i.excluded)
}

/**
 * 包内容指纹：活跃件（kind|path|sha256）+ 剔除史的规范化摘要。
 * 编译幂等快路径与重编译都以它为键——剔除/追加总结件必然改变它（放行重编译），
 * 其余字节扰动不影响。
 */
export function packDigest(manifest: MaterialPackManifest): string {
  const lines = packActiveItems(manifest)
    .map(i => `${i.kind}|${i.path}|${i.sha256}`)
    .sort()
  const excluded = manifest.items.filter(i => i.excluded).map(i => `x:${i.path}`).sort()
  return sha256Text([...lines, ...excluded].join("\n"))
}

// ── 读包（manifest 先行 · 按需下钻 · token 预算纪律）──────────────────

/** 非焦点件进 prompt 的单件字节预算（超预算 = 不载入，显形「按需回源读」）。 */
export const PACK_ITEM_PROMPT_CAP_BYTES = 6_000
/** 焦点命中件放宽（票02 故事4：取到对应素材件再编译）。 */
export const PACK_FOCUS_ITEM_CAP_BYTES = 20_000

/** 焦点指令 → 素材 kind 的确定性词表（对话重编译的下钻判据；spec 故事4 例词逐字覆盖）。 */
const FOCUS_HINTS: Array<{ re: RegExp; kinds: string[] }> = [
  { re: /打回|驳回|返工|reject|反馈|验收不/i, kinds: ["phase-rejections"] },
  { re: /jsonl|执行日志|日志|报错|错误|工具失败|重试|retry/i, kinds: ["exec-jsonl-excerpt"] },
  { re: /diff|pr\b|变更|提交|代码/i, kinds: ["pr-diff"] },
  { re: /台账|验收台账|ledger/i, kinds: ["acceptance-ledger"] },
  { re: /adr|决策|决定/i, kinds: ["adr-context-notes"] },
  { re: /matt|产物|context.?notes|笔记/i, kinds: ["matt-artifacts", "adr-context-notes"] },
]

export function focusMatchedKinds(focus: string | undefined | null): string[] {
  if (!focus) return []
  const hit = new Set<string>()
  for (const h of FOCUS_HINTS) if (h.re.test(focus)) for (const k of h.kinds) hit.add(k)
  return [...hit]
}

export interface PackCompileLoad {
  manifest: MaterialPackManifest
  digest: string
  summary: { item: MaterialPackItem; content: string } | null
  /** 进编译 prompt 的「素材包」段（清单恒在 + 预算内件正文 + 超预算显形） */
  promptSection: string
  loadedPaths: string[]
  omittedPaths: string[]
}

function stripFrontMatter(fileText: string): string {
  return stripRawFrontMatter(fileText)
}

/**
 * 读包组 prompt 面。manifest 先行：清单段列出全部活跃件（kind/name/bytes/sha/路径）；
 * 单件正文按需下钻——焦点命中件放宽预算，其余件超预算即整体不载入（显形不静默）。
 * 件 hash 对质：盘上正文实算 ≠ manifest.sha256 ⇒ PACK_HASH_MISMATCH（不可变契约守护）。
 */
export function loadPackForCompile(
  root: string,
  taskId: string,
  opts: { focusInstruction?: string } = {},
): PackCompileLoad {
  const manifest = readPackManifest(root, taskId)
  if (!manifest) throw new MaterialPackError("PACK_NOT_FOUND", `素材包不存在：${packDirRel(taskId)}`, 404)
  const active = packActiveItems(manifest)
  const focusKinds = new Set(focusMatchedKinds(opts.focusInstruction))

  const bodies = new Map<string, string>()
  for (const item of active) {
    const segs = item.path.split("/")
    const dirName = segs[segs.length - 2] ?? ""
    const fileName = segs[segs.length - 1] ?? ""
    if (!PACK_DIR_RE.test(dirName) || !PACK_FILE_RE.test(fileName)) {
      throw new MaterialPackError("INVALID_PARAM", `manifest 件路径越界：${item.path}`, 400)
    }
    const abs = path.join(getRawDir(root, "archives"), dirName, fileName)
    let content: string
    try {
      content = stripFrontMatter(fs.readFileSync(abs, "utf-8"))
    } catch {
      throw new MaterialPackError("PACK_ITEM_MISSING", `manifest 声称的件不在盘：${item.path}`, 409)
    }
    if (sha256Text(content) !== item.sha256) {
      throw new MaterialPackError("PACK_HASH_MISMATCH", `件 hash 对质失败（不可变契约被破坏？）：${item.path}`, 409)
    }
    bodies.set(item.path, content)
  }

  const summaryItem = active.find(i => i.kind === ARCHIVE_SUMMARY_KIND) ?? null
  const summary = summaryItem && bodies.has(summaryItem.path)
    ? { item: summaryItem, content: bodies.get(summaryItem.path)! }
    : null

  const lines: string[] = []
  lines.push(`# 素材包清单（manifest · 先行 · task-${taskId}）`)
  lines.push("")
  for (const item of active) {
    lines.push(`- ${item.name}（${item.kind}）· ${item.bytes} B · sha256 ${item.sha256.slice(0, 12)}… · ${item.path}`)
  }
  const loadedPaths: string[] = []
  const omittedPaths: string[] = []
  const itemBlocks: string[] = []
  for (const item of active) {
    if (item.kind === ARCHIVE_SUMMARY_KIND) continue // 总结 = 编译主源，已另行全文进 prompt
    const cap = focusKinds.has(item.kind) ? PACK_FOCUS_ITEM_CAP_BYTES : PACK_ITEM_PROMPT_CAP_BYTES
    const content = bodies.get(item.path)!
    if (Buffer.byteLength(content, "utf-8") > cap) {
      omittedPaths.push(item.path)
      itemBlocks.push(`### ${item.name}（${item.kind}）\n\n（未载入：${item.bytes} B 超单件预算 ${cap} B——按需回源读 ${item.path}）`)
      continue
    }
    loadedPaths.push(item.path)
    itemBlocks.push(`### ${item.name}（${item.kind}）\n\n${content}`)
  }
  lines.push("")
  lines.push("## 素材件正文（按需下钻 · 未载入件以指针显形）")
  lines.push("")
  lines.push(itemBlocks.join("\n\n"))
  if (opts.focusInstruction && opts.focusInstruction.trim() !== "") {
    lines.push("")
    lines.push("## 策展焦点指令")
    lines.push("")
    lines.push(`owner 指令：「${opts.focusInstruction.trim()}」——本次重编译优先围绕该焦点从上述素材件取证提炼，产物须体现包内原始素材。`)
  }

  return {
    manifest,
    digest: packDigest(manifest),
    summary,
    promptSection: lines.join("\n"),
    loadedPaths,
    omittedPaths,
  }
}

/** 素材包卡的件视图（manifest → KcMaterialPackCardData.items 投影，单源）。 */
export function packItemsForCard(manifest: MaterialPackManifest): Array<{ kind: string; name: string; path: string; bytes: number; sha256: string; excluded?: boolean }> {
  return manifest.items.map(i => ({
    kind: i.kind,
    name: i.name,
    path: i.path,
    bytes: i.bytes,
    sha256: i.sha256,
    ...(i.excluded ? { excluded: true } : {}),
  }))
}
