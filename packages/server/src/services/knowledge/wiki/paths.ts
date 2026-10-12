import fs from "fs"
import path from "path"
import os from "os"

/**
 * Wiki 根路径解析 — LLM-WIKI knowledge-loop 票01。
 *
 * 独立于 `getKnowledgeDir`（file-ops.ts L21）：那个 getter 有 mkdir 副作用、且它的
 * OCTOPUS_KNOWLEDGE_DIR env 会无视 org 拍平目录（data-plane notes gotcha #2）。
 * wiki 根是独立 git 仓库（org 级）：
 *
 *   org     →  ~/.octopus/orgs/<org>/knowledge/wiki/
 *   global  →  ~/.octopus/knowledge/wiki/
 *
 * 注入优先级：构造器 rootDir（archive-routes stateDir 测试先例）> OCTOPUS_WIKI_DIR env hook > org 路径。
 * 本模块不 mkdir——目录骨架 + git init 属编译服务职责（首编译时收口）。
 */
export function resolveWikiRoot(org?: string, injectedRoot?: string): string {
  if (injectedRoot) return injectedRoot
  if (process.env.OCTOPUS_WIKI_DIR) return process.env.OCTOPUS_WIKI_DIR
  const base = path.join(os.homedir(), ".octopus")
  return org
    ? path.join(base, "orgs", org, "knowledge", "wiki")
    : path.join(base, "knowledge", "wiki")
}

/** 四域 + cases 判例域（prototype Tab③ 目录布局，行 405-429）。 */
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
 * 确保 wiki 目录骨架存在：4 个规则域 + cases/ 判例域 + _retired/ 退役区。
 * 幂等（recursive mkdir）。
 */
export function ensureWikiSkeleton(root: string): void {
  for (const d of [...WIKI_DOMAINS, "_retired"]) {
    fs.mkdirSync(path.join(root, d), { recursive: true })
  }
}
