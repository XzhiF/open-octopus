// packages/server/src/services/knowledge/__tests__/skill-seq.test.ts
//
// P3 票04 — 跨 task 工具序列相似检测（S1 纯函数面；票面第 2 行 a 路，spec 故事 15）。
//
// 检测源=素材包 exec-jsonl-excerpt 件的 ` :: ` 渲染行（票02 摘录纪律产物）。
// 序列 token 口径（宁少勿滥）：只取**失败工具事件**的 toolName——
//   tool_call(isError)、bash_stderr、python_stderr、agent_event(tool_result ∧ is_error ∧ 有 name)；
//   纯 error/bash_log 行不进序列（非工具形，混入会让任意两个报错任务互「相似」）。
// 相似判定：归一化后 LCS 保序比值 = LCS/max(len)（case-symptom.ts 归一化思路的
// 序列版——症状是无序 token 集 jaccard，操作流程是有序序列，判定形状不同，自建纯函数）。
//
// expected 真相源：下方手算样例（spec 无算式可抄，fixture 注释逐字给分式），非实现反推。

import { describe, it, expect } from "vitest"
import {
  SKILL_SEQ_MIN_EVENTS,
  SKILL_SEQ_SIM_THRESHOLD,
  extractToolSequence,
  findSimilarSequenceTask,
  sequenceSimilarity,
} from "../skill-seq"

const EXCERPT_A = [
  "# 执行 JSONL 关键事件摘录",
  "",
  "## exec exec-a1（phase 1 · round 1）",
  "",
  "- [2026-10-14T01:00:05Z] do-a · tool_call :: {\"toolName\":\"Read\",\"isError\":true,\"input\":\"package.json\"}",
  "- [2026-10-14T01:00:20Z] do-a · error :: {\"error\":\"Cannot find module 'ws'\"}",
  "- [2026-10-14T01:00:31Z] do-a · bash_stderr :: {\"stderr\":\"pnpm build failed: ws missing\"}",
  "- [2026-10-14T01:01:02Z] do-a · agent_event :: {\"event_data\":{\"subtype\":\"tool_result\",\"is_error\":true,\"name\":\"Edit\"}}",
  "- [2026-10-14T01:01:30Z] do-a · tool_call :: {\"toolName\":\"Bash\",\"isError\":true,\"input\":\"pnpm install ws\"}",
  "- [2026-10-14T01:02:00Z] do-a · bash_log :: {\"output\":\"git commit -m 'fix: 补 ws 依赖'\"}",
].join("\n")

// 同形异文：报错文本/入参全不同，工具失败序列逐位相同 ⇒ 相似 1.0
const EXCERPT_B = [
  "## exec exec-b7（phase 2 · round 1）",
  "",
  "- [2026-10-14T05:00:01Z] do-b · tool_call :: {\"toolName\":\"Read\",\"isError\":true,\"input\":\"index.ts\"}",
  "- [2026-10-14T05:00:40Z] do-b · bash_stderr :: {\"stderr\":\"tsc error: ws not found\"}",
  "- [2026-10-14T05:01:11Z] do-b · agent_event :: {\"event_data\":{\"subtype\":\"tool_result\",\"is_error\":true,\"name\":\"Edit\"}}",
  "- [2026-10-14T05:01:55Z] do-b · tool_call :: {\"toolName\":\"Bash\",\"isError\":true,\"input\":\"pnpm add -D @types/ws\"}",
].join("\n")

// 异流程（Python 修复流）：与 A 的最长公共保序子序列 = [read]，1/max(4,3)
const EXCERPT_C = [
  "## exec exec-c3（phase 1 · round 1）",
  "",
  "- [2026-10-14T09:00:00Z] do-c · python_stderr :: {\"stderr\":\"KeyError: ws\"}",
  "- [2026-10-14T09:00:10Z] do-c · tool_call :: {\"toolName\":\"Read\",\"isError\":true,\"input\":\"cfg.py\"}",
  "- [2026-10-14T09:00:20Z] do-c · python_stderr :: {\"stderr\":\"exit 1\"}",
].join("\n")

const SEQ_A = ["read", "bash", "edit", "bash"]
const SEQ_C = ["python", "read", "python"]

describe("工具序列提取 + 相似判定（S1 纯函数·票04 a 路）", () => {
  it("阈值/下限常量钉值（宽进严出的运营调参入口，测试钉死防漂移）", () => {
    expect(SKILL_SEQ_SIM_THRESHOLD).toBe(0.6)
    expect(SKILL_SEQ_MIN_EVENTS).toBe(3)
  })

  it("extractToolSequence 只取失败工具事件，按出现序；纯 error/bash_log 行不进序列", () => {
    expect(extractToolSequence(EXCERPT_A)).toEqual(SEQ_A)
    expect(extractToolSequence(EXCERPT_C)).toEqual(SEQ_C)
    // 干净跑完/缺席形 ⇒ 空序列（诚实缺席，检测层零动作）
    expect(extractToolSequence("## exec e（phase 1 · round 1）\n\n- 摘录：（本次执行无关键事件——干净跑完）\n")).toEqual([])
    // 截断 JSON 坏形行跳过不炸
    expect(extractToolSequence("- [t] n · tool_call :: {\"toolName\":\"Read\",\"isError\":tr…（截断）")).toEqual([])
  })

  it("sequenceSimilarity 手算样例：恒等=1；[read] vs [read,bash,edit,bash]=1/4；乱序不加分（保序语义）；空=0", () => {
    expect(sequenceSimilarity(SEQ_A, SEQ_A)).toBe(1)
    expect(sequenceSimilarity(SEQ_A, SEQ_C)).toBe(0.25)
    expect(sequenceSimilarity(SEQ_C, SEQ_A)).toBe(0.25)
    // [bash,read] vs [read,bash]：LCS=1（保序），非 2
    expect(sequenceSimilarity(["bash", "read"], ["read", "bash"])).toBe(0.5)
    expect(sequenceSimilarity([], SEQ_A)).toBe(0)
    expect(sequenceSimilarity(["a"], ["a", "b"])).toBe(0.5)
  })

  it("findSimilarSequenceTask：B 命中（1.0 ≥ 0.6）；C 不中（0.25）；自身/短序列（<MIN_EVENTS=3）不参与", () => {
    const others = [
      { taskId: "b", seq: extractToolSequence(EXCERPT_B) },
      { taskId: "c", seq: extractToolSequence(EXCERPT_C) },
    ]
    const hit = findSimilarSequenceTask("a", SEQ_A, others)
    expect(hit).toEqual({ taskId: "b", score: 1 })

    // 太短的序列不成「流程」（宁少勿滥）
    expect(findSimilarSequenceTask("a", ["read", "read"], others)).toBeUndefined()
    expect(findSimilarSequenceTask("a", SEQ_A, [{ taskId: "x", seq: ["read"] }])).toBeUndefined()
    // 同 task 自比被调用方排除；这里显式传入也不命中（self 过滤是调用方职责，函数不判——
    // 但同分取先位：并列时调用方给的顺序=决胜序）
    const tie = findSimilarSequenceTask("a", SEQ_A, [
      { taskId: "z", seq: SEQ_A },
      { taskId: "y", seq: SEQ_A },
    ])
    expect(tie!.taskId).toBe("z")
  })
})
