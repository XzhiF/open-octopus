import fs from "fs"
import path from "path"
import os from "os"

/**
 * 全局知识根路径与三层目录骨架 — 知识中心票02（spec §Implementation Decisions「三层架构」）。
 *
 * 目录契约逐字取自 prototype Tab② 行 243-269：
 *
 *   ~/.octopus/knowledge/            ← 知识库根（全局唯一，与 org 无关 · D6）
 *   ├── raw/{inbox,archives,research}  层1 不可变源
 *   └── wiki/{entities,concepts,topics,sources,cases,_retired}  层2 五类页
 *
 * 注入优先级（与 resolveWikiRoot 同律）：参数 rootDir > `OCTOPUS_KNOWLEDGE_DIR` env > `~/.octopus/knowledge`。
 * env 复用 file-ops.ts `getKnowledgeDir()` 的同名钩子——两者指向同一路径
 * （`~/.octopus/knowledge`），测试与部署只需设一个变量。
 *
 * 本模块只做「解析 + mkdir -p」，零副作用文件写入；SCHEMA.md / user_preference.md /
 * _archive/ 等根内文件属票03（全局化搬家）与票04（页格式），不在此处创建。
 * 也不触碰 org 级路径链（file-ops / wiki/paths）——重叠留给票03 后续统一。
 */

/** raw 层三个子目录（prototype 行 245-249）。 */
export const RAW_DIRS = ["inbox", "archives", "research"] as const
export type RawDir = (typeof RAW_DIRS)[number]

/** wiki 层五类页目录（prototype 行 254-262）。 */
export const WIKI_PAGE_DIRS = ["entities", "concepts", "topics", "sources", "cases"] as const
export type WikiPageDir = (typeof WIKI_PAGE_DIRS)[number]

/** wiki 层退役区（prototype 行 263）。 */
export const WIKI_RETIRED_DIR = "_retired"

/** Octopus home（口径同 services/agent/paths.ts：$OCTOPUS_HOME > ~/.octopus）。 */
function octopusHome(): string {
  return process.env.OCTOPUS_HOME ?? path.join(os.homedir(), ".octopus")
}

/**
 * 全局知识根解析。测试/调用方注入 root 时绝不落真 `~/.octopus`。
 */
export function resolveKnowledgeRoot(injectedRoot?: string): string {
  if (injectedRoot) return injectedRoot
  if (process.env.OCTOPUS_KNOWLEDGE_DIR) return process.env.OCTOPUS_KNOWLEDGE_DIR
  return path.join(octopusHome(), "knowledge")
}

/** 知识根下的 raw 层根。 */
export function getRawRoot(root: string): string {
  return path.join(root, "raw")
}

/** 知识根下的某个 raw 子目录（inbox/archives/research）。 */
export function getRawDir(root: string, dir: RawDir): string {
  return path.join(getRawRoot(root), dir)
}

/** 知识根下的 wiki 层根。 */
export function getGlobalWikiRoot(root: string): string {
  return path.join(root, "wiki")
}

/**
 * 幂等创建三层目录骨架：知识根 + raw/{inbox,archives,research} +
 * wiki/{entities,concepts,topics,sources,cases,_retired}。
 * 只 mkdir -p，已存在即原样保留（永不改写既有 raw 文件——不可变契约）。
 * 返回解析后的知识根绝对路径。
 */
export function ensureKnowledgeSkeleton(injectedRoot?: string): string {
  const root = resolveKnowledgeRoot(injectedRoot)
  fs.mkdirSync(root, { recursive: true })
  for (const dir of RAW_DIRS) fs.mkdirSync(getRawDir(root, dir), { recursive: true })
  const wiki = getGlobalWikiRoot(root)
  for (const dir of [...WIKI_PAGE_DIRS, WIKI_RETIRED_DIR]) fs.mkdirSync(path.join(wiki, dir), { recursive: true })
  return root
}

// ── 票03 追加：全局化搬家的 org 钉常量（D6①；"重叠留给票03 后续统一" 的落点）──────
// 票03 的搬家服务与读 API 需要「全局知识根」的无参解析与 DB org 钉常量；根解析直接
// 复用上方 resolveKnowledgeRoot/getGlobalWikiRoot（不另立门户），org 常量在此单源。

/**
 * 全局知识根的无参解析（票03 搬家/读 API 入口）。委托 resolveKnowledgeRoot()——
 * 与票02 三层骨架同口径（参数注入 > OCTOPUS_KNOWLEDGE_DIR env > ~/.octopus/knowledge）。
 */
export function resolveGlobalKnowledgeRoot(): string {
  return resolveKnowledgeRoot()
}

/** 全局 wiki 根（= 知识根/wiki）——票03 搬家终点；org wiki 路径此后不再读。 */
export function resolveGlobalWikiRoot(): string {
  return getGlobalWikiRoot(resolveGlobalKnowledgeRoot())
}

/**
 * D6①：DB wiki_articles.org 钉写常量（schema 不动，语义全局）。
 * 读 API（tree/article/search）与 re-key 迁移共用这一个真相源。
 */
export const GLOBAL_WIKI_ORG = "global"
