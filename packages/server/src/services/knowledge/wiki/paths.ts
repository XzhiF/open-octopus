import fs from "fs"
import path from "path"
import os from "os"
import type { WikiPageType } from "@octopus/shared"
import { resolveGlobalWikiRoot, WIKI_PAGE_DIRS } from "../global-paths"

/**
 * Wiki 根路径解析 — LLM-WIKI knowledge-loop 票01。
 *
 * 独立于 `getKnowledgeDir`（file-ops.ts L21）：那个 getter 有 mkdir 副作用、且它的
 * OCTOPUS_KNOWLEDGE_DIR env 会无视 org 拍平目录（data-plane notes gotcha #2）。
 * wiki 根是独立 git 仓库（org 级）：
 *
 *   org     →  ~/.octopus/orgs/<org>/knowledge/wiki/
 *   global  →  ~/.octopus/knowledge/wiki/（单源解析 = global-paths helper，票03）
 *
 * 注入优先级：构造器 rootDir（archive-routes stateDir 测试先例）> OCTOPUS_WIKI_DIR env hook > org 路径。
 * 本模块不 mkdir——目录骨架 + git init 属编译服务职责（首编译时收口）。
 */
export function resolveWikiRoot(org?: string, injectedRoot?: string): string {
  if (injectedRoot) return injectedRoot
  if (process.env.OCTOPUS_WIKI_DIR) return process.env.OCTOPUS_WIKI_DIR
  if (!org) return resolveGlobalWikiRoot()
  return path.join(os.homedir(), ".octopus", "orgs", org, "knowledge", "wiki")
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
 * 确保 wiki 目录骨架存在：v3 五类页目录 + v2 存量域目录（兼容读）+ _retired/ 退役区。
 * 幂等（recursive mkdir）。
 */
export function ensureWikiSkeleton(root: string): void {
  for (const d of [...WIKI_ALL_DIRS, "_retired"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true })
  }
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
 * 优先级沿用 resolveWikiRoot：注入 rootDir > OCTOPUS_WIKI_DIR env > 上述窗口判定。
 * `octopusHome` = 假 ~/.octopus 根（测试注入 tmpdir fixture，绝不碰真实家目录；缺省 os.homedir()/.octopus）。
 */
export function resolveWikiRootCompat(org?: string, injectedRoot?: string, octopusHome?: string): string {
  if (injectedRoot) return injectedRoot
  if (process.env.OCTOPUS_WIKI_DIR) return process.env.OCTOPUS_WIKI_DIR
  const home = octopusHome ?? path.join(os.homedir(), ".octopus")
  const globalRoot = path.join(home, "knowledge", "wiki")
  if (hasWikiContent(globalRoot)) return globalRoot
  return org ? path.join(home, "orgs", org, "knowledge", "wiki") : globalRoot
}
