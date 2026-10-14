// packages/server/src/services/knowledge/shadow-compare.ts
//
// LLM-WIKI P1 ticket 12 — 影子对照导出（story 31）：按执行并排
//   注入侧（precompute 的 __relevant_rule_ids / KnowledgeInjector 的
//            __injected_rule_ids —— 既有 VarPool 键，只读）
//   查阅侧（执行者经 vars_update → VarPool 落盘的 wiki_refs，含 stale: 前缀）
// 输出四象限，作为 P2「删除注入链」单向门的决策数据。
//
// 知识中心票 08 —— 冻结只读（spec「shadow-compare 端点冻结只读」/ p2-gate-pass
// 证据链审计面）：注入链生产者（precompute/KnowledgeInjector）已物理删除，
// 新执行的 injectSide 恒空（relevant/injected=[]）；历史执行 var_pool 里的
// 注入侧键仍可解析对照。本模块与路由、表都不删，只随生产者冻结。
// 边界注定稿（票08 · spec 故事33）：**保留=有意为之的历史审计面**（过闸文书证据链），
// **删除留 P4 后议**（Out of Scope 明列）。读面清理（端点/注入侧键）划入后续清理
// （spec §注入链硬废），清理前勿新增消费者——消费者冻结见 shadow-compare.test.ts
// 「零新增消费者」负断言（故事33）。
//
// 纯函数：输入 = executions.var_pool 反序列化后的快照（JSONL/DB 同源），
// 输出 = 冻结形状（fixture 钉在 shadow-compare.test.ts，禁止实现自证）。

import { STALE_REF_PREFIX, WIKI_REFS_KEY } from "@octopus/shared"

/** 注入侧只读键（原生产者 precompute.ts / knowledge-injector.ts 已随票 08 删除；
 *  键名保留 = 历史快照仍可解析，证据链不失效）。 */
export const SHADOW_RELEVANT_KEY = "__relevant_rule_ids"
export const SHADOW_INJECTED_KEY = "__injected_rule_ids"
/** 查阅侧键（票 11 指针行 token / 票 10 handoff 的 vars_update → VarPool 信道）。 */
export const SHADOW_QUERY_KEY = WIKI_REFS_KEY

export interface ShadowComparison {
  executionId: string
  injectSide: { relevant: string[]; injected: string[] }
  querySide: {
    /** 原样 wiki_refs 条目（含 stale: 前缀），可追溯。 */
    refs: string[]
    /** 归一后的查阅 id 集（stale: 前缀剥离，去重保序）。 */
    queried: string[]
    /** stale 上报条目 id（单独可筛 —— 消费侧反哺生产侧信号）。 */
    stale: string[]
  }
  quadrants: {
    /** 注入 ∩ 查阅：双轨一致 */
    hit: string[]
    /** relevant \ injected：预计算判相关但未进 prompt（注入侧饥饿/未命中） */
    miss: string[]
    /** injected \ queried：注入了没人查（注入侧冗余） */
    injectOnly: string[]
    /** queried \ injected：自主查到而注入未覆盖（注入盲区） */
    queryOnly: string[]
  }
  /** P1 验收判据的原始计数（查阅命中率 vs 注入相关率的分子分母）。 */
  metrics: {
    injectedCount: number
    queriedCount: number
    hitCount: number
    staleCount: number
  }
}

/** 宽容读取 id 列表：JSON 字符串（生产形态）或原生数组皆可，垃圾值 → []。 */
function readIdList(raw: unknown): string[] {
  let value = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string" && v.length > 0)
}

/** 归一 wiki_refs：数组条目转字符串；字符串条目仅在 JSON 数组形态时接受（票 11
 *  契约是数组 —— 裸字符串按垃圾处理，不把脏形态悄悄当查阅成功）。 */
function readWikiRefs(raw: unknown): string[] {
  let value = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  return value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0)
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)]
}

function difference(left: string[], right: Set<string>): string[] {
  return dedupe(left).filter((id) => !right.has(id))
}

function intersect(left: string[], right: Set<string>): string[] {
  return dedupe(left).filter((id) => right.has(id))
}

/**
 * 影子对照：对一次执行持久化的 VarPool 快照做纯函数 diff。
 * pool 传 null（无 var_pool 行）也返回稳定空形状 —— 导出面永不为脏数据崩。
 */
export function buildShadowComparison(
  executionId: string,
  pool: Record<string, unknown> | null,
): ShadowComparison {
  const snapshot = pool ?? {}

  const relevant = readIdList(snapshot[SHADOW_RELEVANT_KEY])
  const injected = readIdList(snapshot[SHADOW_INJECTED_KEY])
  const refs = readWikiRefs(snapshot[SHADOW_QUERY_KEY])

  const stale: string[] = []
  const queried: string[] = []
  for (const entry of refs) {
    if (entry.startsWith(STALE_REF_PREFIX)) {
      const id = entry.slice(STALE_REF_PREFIX.length).trim()
      if (id) stale.push(id)
      if (id) queried.push(id)
    } else {
      queried.push(entry)
    }
  }

  const queriedSet = new Set(queried)
  const injectedSet = new Set(injected)

  const hit = intersect(injected, queriedSet)
  const injectOnly = difference(injected, queriedSet)
  const queryOnly = difference(queried, injectedSet)
  const miss = difference(relevant, injectedSet)

  return {
    executionId,
    injectSide: { relevant: dedupe(relevant), injected: dedupe(injected) },
    querySide: { refs, queried: dedupe(queried), stale: dedupe(stale) },
    quadrants: { hit, miss, injectOnly, queryOnly },
    metrics: {
      injectedCount: dedupe(injected).length,
      queriedCount: dedupe(queried).length,
      hitCount: hit.length,
      staleCount: dedupe(stale).length,
    },
  }
}
