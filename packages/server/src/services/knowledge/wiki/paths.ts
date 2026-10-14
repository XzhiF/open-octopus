import fs from "fs"
import path from "path"
import type { WikiPageType } from "@octopus/shared"
import {
  deriveOrgWikiRootAt,
  deriveWikiRootAt,
  getGlobalWikiRoot,
  legacyWikiDirEnv,
  octopusHomeFor,
  resolveGlobalWikiRoot,
  resolveKnowledgeRoot,
  WIKI_PAGE_DIRS,
} from "../global-paths"

/**
 * Wiki 根路径解析 — LLM-WIKI knowledge-loop 票01；code-review S3 起布局**单源委托**
 * global-paths（derive 族/legacyWikiDirEnv），本文件不再自拼 `~/.octopus/orgs/...`。
 *
 * wiki 根是独立 git 仓库：
 *
 *   org     →  ~/.octopus/orgs/<org>/knowledge/wiki/   （旧轨，$OCTOPUS_HOME 窗生效）
 *   global  →  ~/.octopus/knowledge/wiki/（resolveGlobalWikiRoot，票03）
 *
 * 注入优先级三处同律：构造器 rootDir > `OCTOPUS_WIKI_DIR` 弃用别名（legacyWikiDirEnv）
 * > 布局解析。本模块不 mkdir——目录骨架 + git init 属编译服务职责（首编译时收口）。
 */
export function resolveWikiRoot(org?: string, injectedRoot?: string): string {
  if (injectedRoot) return injectedRoot
  const legacy = legacyWikiDirEnv()
  if (legacy) return legacy
  if (!org) return resolveGlobalWikiRoot()
  return deriveOrgWikiRootAt(octopusHomeFor(), org)
}

/** 四域 + cases 判例域（v2 存量目录——兼容可读，重蒸馏票07 后整体迁 _retired/）。 */
export const WIKI_DOMAINS = ["projects", "workflows", "business", "research", "cases"] as const
export type WikiDomainDir = (typeof WIKI_DOMAINS)[number]

/** INDEX H2 域节中文名 — 逐字取自 prototype Tab③ lines 450-464。 */
export const WIKI_DOMAIN_LABELS: Record<WikiDomainDir, string> = {
  projects: "项目知识",
  workflows: "工作流知识",
  business: "业务规则",
  research: "调研蒸馏",
  cases: "问题案例档",
}

/**
 * 页路径面 v3（票04 基座）：五类页目录（prototype Tab② 目录契约）。
 * 单源 = global-paths（票02 三层骨架同表）——此处 re-export 供形态层
 * （扫描/骨架/INDEX 分组）消费；页形态逻辑一律经此解析目录，不硬编码 org wiki 路径。
 */
export { WIKI_PAGE_DIRS, type WikiPageDir } from "../global-paths"

/** INDEX 五类分组节头 — 逐字 prototype Tab② INDEX 样例（`## Entities (7)` 式）。 */
export const WIKI_PAGE_GROUP_LABELS: Record<WikiPageType, string> = {
  entity: "Entities",
  concept: "Concepts",
  topic: "Topics",
  source: "Sources",
  case: "Cases",
}

/** 扫描/骨架用目录全集：v3 五类 ∪ v2 五域（cases 重合）；顺序 v3 在前。 */
export const WIKI_ALL_DIRS: readonly string[] = [...WIKI_PAGE_DIRS, ...WIKI_DOMAINS.filter(d => d !== "cases")]

/**
 * 重蒸馏锚点随迁对照表（票07 落盘产物，单源路径常量）：`{oldId}#{anchor}` → 新页 +
 * carried 标记。compile.nextRuleAnchor 读其 anchors 清单把「已剥落锚点」并入发号空间
 * （永不复用铁律对非 topic 迁移页的延伸防护）；读侧 wiki_refs 解析也以此为账。
 */
export const REDISTILL_MAP_REL = "_retired/v2/redistill-map.json"

/**
 * 确保 wiki 目录骨架存在：v3 五类页目录 + _retired/ 退役区。幂等（recursive mkdir）。
 *
 * 票08 清理账（spec 故事29）：**不再创建 v2 存量域目录（projects/workflows/business/research）**——
 * 它们已被重蒸馏票07 整体迁 `_retired/v2/`，编译期再 mkdir 会在真盘长出空目录（清而不净）。
 * 写入面自保：`compile.atomicWrite` 落盘前 recursive mkdir，历史 v2 词条若仍需写不受影响。
 * 存量的空 v2 目录由 {@link removeEmptyV2DomainDirs} 一次性清理。
 * `cases` 是 v3 判例域（WIKI_PAGE_DIRS 含之），是票03 判例目的地面——保留，绝不列入清理。
 */
export function ensureWikiSkeleton(root: string): void {
  for (const d of [...WIKI_PAGE_DIRS, "_retired"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true })
  }
}

/**
 * 票08 待清理的 v2 存量域目录（projects/workflows/business/research）。
 * 单列常量而非复用 WIKI_DOMAINS：`cases` 虽在 WIKI_DOMAINS 里，但它是 v3 判例目的地，
 * **绝不**进清理面（此处物理隔离防误删）。
 */
export const V2_LEGACY_DOMAINS = ["projects", "workflows", "business", "research"] as const

/**
 * 一次性移除 wiki 根上历史 v2 空域目录。**只删确为空者**，非空即跳过并留痕
 * （归档/删除纪律：绝不动有内容目录）。目录不存在＝已清理，幂等 no-op。
 * 真实盘执行归主控 ops（合入后调用本函数一次）；测试跑 tmpdir，零触真盘。
 */
export function removeEmptyV2DomainDirs(
  root: string,
  log: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): { removed: string[]; skipped: string[] } {
  const removed: string[] = []
  const skipped: string[] = []
  for (const d of V2_LEGACY_DOMAINS) {
    const abs = path.join(root, d)
    if (!fs.existsSync(abs)) continue // 已清理 / 从未创建 → no-op
    let entries: string[]
    try {
      entries = fs.readdirSync(abs)
    } catch {
      skipped.push(d)
      continue
    }
    if (entries.length === 0) {
      fs.rmdirSync(abs) // rmdirSync 仅空目录可删；前面已判 length===0
      removed.push(d)
      log(`[wiki-cleanup] 移除空 v2 域目录 ${d}/`)
    } else {
      skipped.push(d)
      log(`[wiki-cleanup] v2 域目录 ${d}/ 非空（${entries.length} 项）→ 跳过，绝不删有内容目录`)
    }
  }
  return { removed, skipped }
}

/**
 * 判定 wiki 根是否有真实内容（票03 搬家扫描/兼容读窗共用同一口径）：
 * 有 .git 仓、或有 INDEX/LOG 导航层、或任一域目录/退役区有 .md——纯 ensureWikiSkeleton
 * 造出的空骨架（只有目录）判 false。骨架 ≠ 内容。
 */
export function hasWikiContent(root: string): boolean {
  if (!fs.existsSync(root)) return false
  if (fs.existsSync(path.join(root, ".git"))) return true
  for (const special of ["INDEX.md", "LOG.md"]) {
    if (fs.existsSync(path.join(root, special))) return true
  }
  for (const d of [...WIKI_ALL_DIRS, "_retired"]) {
    try {
      if (fs.readdirSync(path.join(root, d)).some(n => n.endsWith(".md"))) return true
    } catch { /* 域目录缺席 */ }
  }
  return false
}

/**
 * 读 API 的 wiki 根解析（票03 D6①）：搬家窗口期语义——
 *   - 全局根有内容 → 只读全局根（旧 org wiki 路径此后不再读，"兼容读一次"收口于搬家完成）
 *   - 全局根尚无内容（迁移未跑）→ 兼容读旧 org wiki 路径（org 参数容错承接）
 * 优先级沿用 resolveWikiRoot：注入 rootDir > OCTOPUS_WIKI_DIR 弃用别名 > 上述窗口判定。
 * 全局根候选与 resolveKnowledgeRoot **同式**（正源 env 拍平生效；注入 fake home 时以注入为准，
 * env 让位）；org 轨在兼容窗恒按 home 基布局。
 * `injectedHome` = 假 ~/.octopus 根（测试注入 tmpdir fixture，绝不碰真实家目录；
 * 缺省走单源 octopusHomeFor：$OCTOPUS_HOME > os.homedir()/.octopus）。
 */
export function resolveWikiRootCompat(org?: string, injectedRoot?: string, injectedHome?: string): string {
  if (injectedRoot) return injectedRoot
  const legacy = legacyWikiDirEnv()
  if (legacy) return legacy
  const home = octopusHomeFor(injectedHome)
  const globalRoot = injectedHome ? deriveWikiRootAt(injectedHome) : getGlobalWikiRoot(resolveKnowledgeRoot())
  if (hasWikiContent(globalRoot)) return globalRoot
  return org ? deriveOrgWikiRootAt(home, org) : globalRoot
}
