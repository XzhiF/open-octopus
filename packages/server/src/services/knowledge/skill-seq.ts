// packages/server/src/services/knowledge/skill-seq.ts
//
// 跨 task 工具序列相似检测 — P3 票04 检测 a 路的判据面（spec 故事 15「跨 task 重复的
// 同类操作序列（JSONL 面）」，票面第 2 行「阈值宽进严出——宁少勿滥」）。
//
// 纯函数零 IO（case-symptom.ts 同族制式：自建、可单测、阈值单源常量=运营调参入口）。
//  * 提取源 = 素材包 exec-jsonl-excerpt 件（票02 摘录纪律的 ` :: ` 渲染行）；
//    token 只认**失败工具事件**（tool_call isError / bash_stderr / python_stderr /
//    agent_event tool_result is_error 且带 name），小写归一。纯 error 行与
//    bash_log fix-commit 行**不进序列**——它们没有工具形，混入后任意两个报错任务
//    都会「相似」，检测即失真。
//  * 判定 = LCS（最长公共保序子序列）/ max(len)。症状相似（票03）是无序集合 jaccard，
//    操作流程相似必须保序（先读后改 ≠ 先改后读是两回事），形状不同故自建。
//  * 下限 SKILL_SEQ_MIN_EVENTS：短序列不成「流程」（宁少勿滥）。

import { normalizeSymptom } from "./case-symptom"

/** 序列相似阈值（LCS 保序比值 ≥ 此值 ⇒ 出草案过人裁）。票面运营参数，测试钉值。 */
export const SKILL_SEQ_SIM_THRESHOLD = 0.6

/** 成「流程」的最少失败工具事件数（双方都要 ≥ 此数才比对——两三条报错不构成操作流）。 */
export const SKILL_SEQ_MIN_EVENTS = 3

/** 摘录渲染行：`- [ts] node · event :: {json…}`（archive-materials renderKeyEvent 形制）。 */
const EXCERPT_LINE_RE = /^- \[[^\]]*\] \S+ · (\S+) :: (\{.*)$/

interface SequenceTokenFields {
  toolName?: unknown
  name?: unknown
  isError?: unknown
  is_error?: unknown
  subtype?: unknown
  event_data?: unknown
}

function tokenFrom(lineEvent: string, payload: SequenceTokenFields): string | undefined {
  const lower = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined
    const norm = normalizeSymptom(v).replace(/\s+/g, "")
    return norm === "" ? undefined : norm
  }
  switch (lineEvent) {
    case "tool_call": {
      if (payload.isError !== true && payload.is_error !== true) return undefined
      return lower(payload.toolName)
    }
    case "bash_stderr":
      return "bash"
    case "python_stderr":
      return "python"
    case "agent_event": {
      const data = payload.event_data as SequenceTokenFields | undefined
      if (!data || typeof data !== "object") return undefined
      if (data.subtype !== "tool_result") return undefined
      if (data.is_error !== true && data.isError !== true) return undefined
      return lower(data.toolName ?? data.name)
    }
    default:
      return undefined
  }
}

/**
 * 从 exec-jsonl-excerpt 正文提取失败工具序列（出现序，小写归一 token）。
 * 行 JSON 解析失败（截断形）= 该行诚实跳过，永不抛。
 */
export function extractToolSequence(excerptPayload: string): string[] {
  const out: string[] = []
  for (const raw of excerptPayload.split("\n")) {
    const m = EXCERPT_LINE_RE.exec(raw)
    if (!m) continue
    const event = m[1] ?? ""
    let fields: SequenceTokenFields
    try {
      fields = JSON.parse(m[2] ?? "{}") as SequenceTokenFields
    } catch {
      continue
    }
    const token = tokenFrom(event, fields)
    if (token !== undefined) out.push(token)
  }
  return out
}

/** LCS 长度（经典 DP，O(nm)；序列已被摘录上限压小，无性能忧）。 */
export function lcsLength(a: string[], b: string[]): number {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return 0
  let prev = new Array<number>(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(m + 1).fill(0)
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!)
    }
    prev = cur
  }
  return prev[m]!
}

/** 保序相似 = LCS / max(len)；任一空 ⇒ 0。 */
export function sequenceSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  return lcsLength(a, b) / Math.max(a.length, b.length)
}

export interface SequenceCorpusEntry {
  taskId: string
  seq: string[]
}

export interface SequenceHit {
  taskId: string
  score: number
}

/**
 * 在既有任务序列语料中找同类操作流：分高者胜，同分取调用方顺序的先位
 * （调用方负责语料排序确定，如按 taskId 字典序）。
 * 自 task 排除；任一方 < SKILL_SEQ_MIN_EVENTS 不参与；无 ≥ SKILL_SEQ_SIM_THRESHOLD 命中 ⇒ undefined。
 */
export function findSimilarSequenceTask(selfTaskId: string, selfSeq: string[], others: SequenceCorpusEntry[]): SequenceHit | undefined {
  if (selfSeq.length < SKILL_SEQ_MIN_EVENTS) return undefined
  let best: SequenceHit | undefined
  for (const o of others) {
    if (o.taskId === selfTaskId) continue
    if (o.seq.length < SKILL_SEQ_MIN_EVENTS) continue
    const score = sequenceSimilarity(selfSeq, o.seq)
    if (score >= SKILL_SEQ_SIM_THRESHOLD && (best === undefined || score > best.score)) {
      best = { taskId: o.taskId, score }
    }
  }
  return best
}
