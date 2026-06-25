/**
 * 最小验证脚本：测试跨执行变量引用解析修复
 *
 * 模拟 heheda workspace 的 3 步工作流场景：
 *   step1-gather → step2-analyze → step3-report
 *
 * 验证以下变量引用是否正确解析：
 *   - $parent.var_pool.gathered_info      (step2 引用 step1)
 *   - $parent.var_pool.analysis_result    (step3 引用 step2)
 *   - $ancestor[1].var_pool.gathered_info (step3 引用 step1)
 *
 * 运行：npx tsx scripts/verify-cross-exec-resolve.ts
 */

import { CrossExecResolver, substituteVars, VarPool } from "../packages/shared/src/index"
import type { ExecutionLookup } from "../packages/shared/src/index"

// ── Mock DB ──────────────────────────────────────────────────────────

const mockDb = new Map<string, { parent_id?: string; var_pool?: string; input_values?: string }>()

// step1-gather (root, no parent)
mockDb.set("exec-step1", {
  parent_id: "0",
  var_pool: JSON.stringify({
    gathered_info: "TypeScript 5.0 核心亮点：1) 装饰器 2) const类型参数 3) union enum",
    topic_summary: "TS5.0特性",
    topic: "TypeScript 5.0 新特性",
  }),
  input_values: JSON.stringify({ topic: "TypeScript 5.0 新特性" }),
})

// step2-analyze (child of step1)
mockDb.set("exec-step2", {
  parent_id: "exec-step1",
  var_pool: JSON.stringify({
    analysis_result: "要点1 | 要点2 | 要点3",
    info: "TypeScript 5.0 核心亮点：1) 装饰器 2) const类型参数 3) union enum",
  }),
  input_values: JSON.stringify({ info: "$parent.var_pool.gathered_info" }),
})

// step3-report (child of step2, grandchild of step1)
mockDb.set("exec-step3", {
  parent_id: "exec-step2",
  var_pool: "{}",
  input_values: JSON.stringify({
    info: "$ancestor[1].var_pool.gathered_info",
    analysis: "$parent.var_pool.analysis_result",
  }),
})

const mockNodeOutputs = new Map<string, Record<string, any>>()
mockNodeOutputs.set("exec-step1:collect", {
  gathered_info: "TypeScript 5.0 核心亮点：1) 装饰器 2) const类型参数 3) union enum",
  topic_summary: "TS5.0特性",
})

// ── Create resolver ──────────────────────────────────────────────────

const lookup: ExecutionLookup = {
  getById: (id: string) => {
    const row = mockDb.get(id)
    return row ?? null
  },
  getNodeOutputs: (executionId: string, nodeId: string) => {
    return mockNodeOutputs.get(`${executionId}:${nodeId}`) ?? null
  },
}

const resolver = new CrossExecResolver(lookup)

// ── Test cases ───────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(description: string, actual: string, expected: string) {
  if (actual === expected) {
    console.log(`  ✅ ${description}`)
    passed++
  } else {
    console.log(`  ❌ ${description}`)
    console.log(`     期望: ${expected}`)
    console.log(`     实际: ${actual}`)
    failed++
  }
}

console.log("\n🔍 === 测试 1: CrossExecResolver 直接解析 ===\n")

// Test 1a: $parent.var_pool.gathered_info from step2
const resolved1 = resolver.resolve("$parent.var_pool.gathered_info", "exec-step2")
assert(
  "$parent.var_pool.gathered_info (step2→step1)",
  resolved1,
  "TypeScript 5.0 核心亮点：1) 装饰器 2) const类型参数 3) union enum",
)

// Test 1b: $parent.var_pool.analysis_result from step3
const resolved2 = resolver.resolve("$parent.var_pool.analysis_result", "exec-step3")
assert(
  "$parent.var_pool.analysis_result (step3→step2)",
  resolved2,
  "要点1 | 要点2 | 要点3",
)

// Test 1c: $ancestor[1].var_pool.gathered_info from step3 (grandparent)
const resolved3 = resolver.resolve("$ancestor[1].var_pool.gathered_info", "exec-step3")
assert(
  "$ancestor[1].var_pool.gathered_info (step3→step1)",
  resolved3,
  "TypeScript 5.0 核心亮点：1) 装饰器 2) const类型参数 3) union enum",
)

// Test 1d: No parent → should return original text
const resolved4 = resolver.resolve("$parent.var_pool.xxx", "exec-step1")
assert(
  "$parent.var_pool.xxx (step1, no parent) → unresolved",
  resolved4,
  "$parent.var_pool.xxx",
)

console.log("\n🔍 === 测试 2: substituteVars + CrossExecResolver 联合解析 ===\n")

// Test 2a: Simulate the analyze node's prompt
const pool2 = new VarPool({ info: "TypeScript 5.0 核心亮点：1) 装饰器 2) const类型参数 3) union enum" })
const prompt2 = "请分析以下信息：$inputs.info"
const result2 = substituteVars(prompt2, pool2, undefined, resolver, "exec-step2")
assert(
  "substituteVars: $inputs.info resolved from pool",
  result2,
  "请分析以下信息：TypeScript 5.0 核心亮点：1) 装饰器 2) const类型参数 3) union enum",
)

// Test 2b: Simulate the scenario where YAML default is unresolved in pool
// This is the BUG scenario — pool has the raw $parent.* reference
const pool3 = new VarPool({ info: "$parent.var_pool.gathered_info" })
const prompt3 = "请分析以下信息：$inputs.info"
// After the fix, inputValues should be resolved BEFORE being stored in pool.
// But let's also test that substituteVars with the resolver can handle it:
const result3 = substituteVars(prompt3, pool3, undefined, resolver, "exec-step2")
// Note: substituteVars replaces $inputs.info with pool value, which is "$parent.var_pool.gathered_info"
// The resolver runs FIRST on the full text, but $inputs.info isn't a $parent.* reference.
// After $inputs.info → "$parent.var_pool.gathered_info", the resolver already ran.
// So the result would still be the unresolved reference. This is WHY we need the fix:
// resolve inputs BEFORE storing in pool!
console.log(`  ℹ️  substituteVars with unresolved pool: "${result3}"`)
console.log(`     (This shows why we must resolve YAML defaults BEFORE storing in VarPool)`)

console.log("\n🔍 === 测试 3: 模拟修复后的 start() 流程 ===\n")

// Simulate the fixed ExecutionService.start() logic:
function simulateFixedStart(executionId: string, inputValues?: Record<string, string>, yamlDefaults?: Record<string, string>) {
  const exec = mockDb.get(executionId)
  if (!exec) throw new Error("Execution not found")

  let resolvedInputs = inputValues ?? {}
  if (exec.parent_id && exec.parent_id !== "0") {
    // Merge YAML defaults with provided inputValues
    const merged: Record<string, string> = {
      ...(yamlDefaults ?? {}),
      ...(inputValues ?? {}),
    }

    // Resolve cross-execution references
    resolvedInputs = {}
    for (const [key, value] of Object.entries(merged)) {
      if (typeof value === "string" && (value.includes("$parent.") || value.includes("$ancestor["))) {
        resolvedInputs[key] = resolver.resolve(value, executionId)
      } else {
        resolvedInputs[key] = value
      }
    }
  }

  return resolvedInputs
}

// Test 3a: step2-analyze — YAML default should be resolved
const step2Defaults = { info: "$parent.var_pool.gathered_info" }
const step2Resolved = simulateFixedStart("exec-step2", undefined, step2Defaults)
assert(
  "step2: YAML default $parent.var_pool.gathered_info resolved",
  step2Resolved.info,
  "TypeScript 5.0 核心亮点：1) 装饰器 2) const类型参数 3) union enum",
)

// Test 3b: step3-report — both YAML defaults should be resolved
const step3Defaults = {
  info: "$ancestor[1].var_pool.gathered_info",
  analysis: "$parent.var_pool.analysis_result",
}
const step3Resolved = simulateFixedStart("exec-step3", undefined, step3Defaults)
assert(
  "step3: $ancestor[1].var_pool.gathered_info resolved",
  step3Resolved.info,
  "TypeScript 5.0 核心亮点：1) 装饰器 2) const类型参数 3) union enum",
)
assert(
  "step3: $parent.var_pool.analysis_result resolved",
  step3Resolved.analysis,
  "要点1 | 要点2 | 要点3",
)

// Test 3c: Caller-provided value should override YAML default
const step2Override = simulateFixedStart("exec-step2", { info: "用户自定义值" }, step2Defaults)
assert(
  "step2: caller value overrides YAML default",
  step2Override.info,
  "用户自定义值",
)

// Test 3d: Root execution — no resolution needed
const step1Resolved = simulateFixedStart("exec-step1", { topic: "TypeScript 5.0" })
assert(
  "step1: root execution, no cross-exec refs",
  step1Resolved.topic,
  "TypeScript 5.0",
)

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`)
console.log(`结果: ${passed} passed, ${failed} failed, ${passed + failed} total`)
console.log(`${"═".repeat(50)}\n`)

if (failed > 0) {
  process.exit(1)
}
