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
 * 注入优先级（全库统一口径，本模块单源）：参数 rootDir > `OCTOPUS_KNOWLEDGE_DIR` env > `~/.octopus/knowledge`；
 * home 基受 `$OCTOPUS_HOME` 窗（测试/隔离部署注入假 home）。
 * `OCTOPUS_WIKI_DIR` 为**弃用别名**（票01 时代直写 wiki 根，legacyWikiDirEnv 单源定义）——
 * 正源只有一个：知识根 env，wiki 根 = 知识根/wiki。
 *
 * 本模块只做「解析 + mkdir -p」，零副作用文件写入；SCHEMA.md / _archive/ 等根内文件属票03（全局化搬家）与票04（页格式），不在此处创建。
 * org 轨与兼容窗**同收口于此**（code-review S3：resolveKnowledgeDir / derive 族 /
 * legacyWikiDirEnv——file-ops 与 wiki/paths 全部委托，不再各自拼路径）。
 */

/** raw 层三个子目录（prototype 行 245-249）。 */
export const RAW_DIRS = ["inbox", "archives", "research"] as const
export type RawDir = (typeof RAW_DIRS)[number]

/** wiki 层五类页目录（prototype 行 254-262）。 */
export const WIKI_PAGE_DIRS = ["entities", "concepts", "topics", "sources", "cases"] as const
export type WikiPageDir = (typeof WIKI_PAGE_DIRS)[number]

/** wiki 层退役区（prototype 行 263）。 */
export const WIKI_RETIRED_DIR = "_retired"

/**
 * skill 草案区（P3 票04，spec 故事 24）：知识根 `drafts/skills/{name}/SKILL.md`。
 * **待授予过程资产**——不在 wiki git 仓、不是知识页、不进 INDEX；scanWikiEntries/
 * listRawSources 的约定目录扫不到它（天然隔离）。
 */
export const SKILL_DRAFTS_DIR_REL = "drafts/skills" as const

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
 * 知识根下的 skill 草案区根（P3 票04，spec 故事 24）。
 * 落点 `<root>/drafts/skills/`，与 raw/wiki 平级——草案非不可变源、非知识页。
 */
export function getSkillDraftsRoot(root: string): string {
  return path.join(root, SKILL_DRAFTS_DIR_REL)
}

/**
 * 幂等创建目录骨架：知识根 + raw/{inbox,archives,research} +
 * wiki/{entities,concepts,topics,sources,cases,_retired} + drafts/skills（P3 票04）。
 * 只 mkdir -p，已存在即原样保留（永不改写既有 raw 文件——不可变契约）。
 * 返回解析后的知识根绝对路径。
 */
export function ensureKnowledgeSkeleton(injectedRoot?: string): string {
  const root = resolveKnowledgeRoot(injectedRoot)
  fs.mkdirSync(root, { recursive: true })
  for (const dir of RAW_DIRS) fs.mkdirSync(getRawDir(root, dir), { recursive: true })
  const wiki = getGlobalWikiRoot(root)
  for (const dir of [...WIKI_PAGE_DIRS, WIKI_RETIRED_DIR]) fs.mkdirSync(path.join(wiki, dir), { recursive: true })
  fs.mkdirSync(getSkillDraftsRoot(root), { recursive: true })
  return root
}

// ── 票03 追加：全局化搬家的 org 钉常量（D6①）──────────────────────────────
// 搬家服务与读 API 需要「全局知识根」的无参解析与 DB org 钉常量；根解析直接
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

// ── code-review S3 收口：org 轨 + 假 home 窗 + 弃用别名——单源解析族 ──────────────
// 原「重叠留给票03 后续统一」的账在此清：file-ops.getKnowledgeDir、wiki/paths.resolveWikiRoot、
// resolveWikiRootCompat 全部委托下列函数，路径布局公式只在本文件出现一次。

/**
 * home 基单源：注入假 home（测试窗）> `$OCTOPUS_HOME` > `~/.octopus`。
 * 与 octopusHome() 同律，多一个注入位——compat 窗与布局 derive 族共用。
 */
export function octopusHomeFor(injectedHome?: string): string {
  return injectedHome ?? octopusHome()
}

/** 布局式：home 基下的知识根（真 home 入口走 resolveKnowledgeRoot，这里供注入窗/别名换算）。 */
export function deriveKnowledgeRootAt(homeBase: string): string {
  return path.join(homeBase, "knowledge")
}

/** 布局式：home 基下的全局 wiki 根 = 知识根/wiki。 */
export function deriveWikiRootAt(homeBase: string): string {
  return path.join(deriveKnowledgeRootAt(homeBase), "wiki")
}

/** 布局式：home 基下的 org 级旧知识目录（票09 硬废后仅供兼容读与归档脚本）。 */
export function deriveOrgKnowledgeDirAt(homeBase: string, org: string): string {
  return path.join(homeBase, "orgs", org, "knowledge")
}

/** 布局式：home 基下的 org 级旧 wiki 目录（搬家兼容窗用）。 */
export function deriveOrgWikiRootAt(homeBase: string, org: string): string {
  return path.join(deriveOrgKnowledgeDirAt(homeBase, org), "wiki")
}

/**
 * org-aware 知识目录单源解析（file-ops.getKnowledgeDir 的委托对象）：
 * `OCTOPUS_KNOWLEDGE_DIR` 拍平（测试钩子本意=无视布局直接给目录，org 参数一并吞掉——
 * 旧语义逐字保留）> org 轨 > 全局轨。纯解析零 mkdir（票09 护栏）。
 */
export function resolveKnowledgeDir(org?: string): string {
  if (process.env.OCTOPUS_KNOWLEDGE_DIR) return process.env.OCTOPUS_KNOWLEDGE_DIR
  const home = octopusHome()
  return org ? deriveOrgKnowledgeDirAt(home, org) : deriveKnowledgeRootAt(home)
}

/**
 * **弃用别名**：`OCTOPUS_WIKI_DIR` 直写 wiki 根（票01 时代测试钩子）。
 * 正源 env 是 OCTOPUS_KNOWLEDGE_DIR（wiki 根=知识根/wiki）；别名定义收口在这一函数，
 * 迁移完存量钩子后整体删除。优先级三处同律：注入 rootDir > 别名 > 布局解析。
 */
export function legacyWikiDirEnv(): string | undefined {
  return process.env.OCTOPUS_WIKI_DIR
}
