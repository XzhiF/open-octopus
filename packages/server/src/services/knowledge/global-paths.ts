import os from "os"
import path from "path"

/**
 * 全局知识根路径 helper — 知识中心票03（D6① wiki 全局唯一）。
 *
 * 全局根解析收敛到唯一小函数 `resolveGlobalKnowledgeRoot()`，其余派生路径都从它拼接。
 * 目录契约（spec §三层架构）：
 *   ~/.octopus/knowledge/        ← 全局知识根
 *     ├── wiki/                  ← 全局 wiki 根（票03 搬家终点，独立 .git）
 *     ├── user_preference.md     ← 人工文件区现行版（票03 迁入）
 *     └── _archive/              ← 退役归档区（票03 放偏好原件副本；票04 放 org knowledge 全量）
 *
 * 纪律：本模块只解析路径，不 mkdir（副作用收口在编译/迁移服务，paths.ts 同律）。
 * 注：票02 若并行新建同名 global-paths helper，两者冲突时以本文件为收敛点（报告已注明）。
 */
export function resolveGlobalKnowledgeRoot(): string {
  return path.join(os.homedir(), ".octopus", "knowledge")
}

/** 全局 wiki 根 — 搬家终点（org wiki 路径此后不再读）。 */
export function resolveGlobalWikiRoot(): string {
  return path.join(resolveGlobalKnowledgeRoot(), "wiki")
}

/**
 * D6①：DB wiki_articles.org 钉写常量（schema 不动，语义全局）。
 * 读 API（tree/article/search）与 re-key 迁移共用这一个真相源。
 * 知识根下的 user_preference.md / _archive/ 派生路径由消费方（global-move.ts）
 * 按注入的 knowledgeRoot 拼接（测试 tmpdir fixture 需要可覆盖根，故此处不提供无参派生 helper）。
 */
export const GLOBAL_WIKI_ORG = "global"
