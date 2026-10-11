// packages/web-app/components/tasks/authoring/spec-gate.ts
//
// 票 09 · 入队清单计算单源（提自 authoring-workspace 内联 useMemo，逐字等价）。
// 草稿右栏（authoring-workspace → SpecPanel）与待执行控制台规格签
// （run-console/ready-spec-tab → SpecPanel readOnly）同吃这一份：
//   · computeSpecRows —— 六行清单判定（server gateV4Phases 同源预检：
//     phases 完备 ∧ spec 磁盘已核 ∧ 绑定可解析 ∧ inputs（内置目录镜像，
//     未知 ref = server 权威不阻塞）∧ runbook（起停 up∧ready ∨ preview ∨
//     verify）∧ repos 恒乐观）。「绑定确认」行已废（ADR-0028）。
//   · computeGateHits —— server 409 missing（`phase:<i>:<why>` 契约）反解
//     回填 ✗ 明细。ready 镜像无入队交互 → gateMissing 缺席 → 全空 = 清单只显 ✓。
// 纯函数无 React/DOM 依赖；判定改动只许在这一处发生（勿在控制台重写第二套）。

import type { TaskPhase, TaskSpec } from "@octopus/shared"
import type { BatchTreeEntry } from "@/lib/tasks-api"
import type { BuiltInWorkflowSummary } from "@/lib/workflow-presets-api"
import { findSpecEntry, isRelativeScratchSpec } from "./use-batch-tree"
import type { SpecPanelRows } from "./spec-panel"

/** 六行清单的 gate 键（与 SpecPanelProps.gateHits 形状同源）。 */
export type SpecGateHits = Record<"phases" | "spec" | "bind" | "inputs" | "repos" | "runbook", string[]>

export interface SpecRowsInput {
  phases: TaskPhase[]
  spec: TaskSpec
  /** built-in workflow 目录（inputs required 定义镜像；未加载 = 不阻塞）。 */
  catalog: BuiltInWorkflowSummary[]
  /** batch-tree 磁盘直扫快照（useBatchTree 的三段状态原样传入）。 */
  batches: BatchTreeEntry[]
  batchLoading: boolean
  batchError: string | null
}

/** v4 入队清单六行判定（authoring-workspace v4Rows 逐字提纯，勿改判据）。 */
export function computeSpecRows({
  phases, spec, catalog, batches, batchLoading, batchError,
}: SpecRowsInput): SpecPanelRows {
  // #53 K5 + 原型 chat-draft-v4 改版：磁盘树未就绪 → spec 行「⏳ 未核」（不再
  // 退化字符串假绿）；入队 = 所有 phase 全满足（spec 落盘 ∧ issues 产物 ∧
  // 绑定可解析 ∧ inputs ∧ runbook）。「绑定确认」闸 ⑤ 已废（2026-10-10
  // ADR-0028：绑定存在且可解析 = 已确认）。✗ 行按 phase 点名。
  const specTreeReady = !batchLoading && !batchError
  const rowPhases = phases.length >= 1
  const relPhases = phases.filter((p) => isRelativeScratchSpec(p.specPath))
  const specUnknown = !specTreeReady
  const specMissingIdx = relPhases.filter((p) => findSpecEntry(batches, p.specPath) === null).map((p) => p.index)
  const rowSpec = rowPhases && !specUnknown && specMissingIdx.length === 0
  const rowBind = rowPhases && phases.every((p) => (p.workflowRef ?? "").trim().length > 0)
  // runbook 与 server readyTask 硬检同判据：起停 up∧ready ∨ preview ∨ verify
  const rb = spec.acceptance_runbook
  const rowRunbook =
    !!(rb?.up?.command?.trim() && rb?.ready?.command?.trim()) ||
    !!spec.acceptance_preview?.command?.trim() ||
    !!spec.acceptance_verify?.command?.trim()
  let inputsUnknown = false
  const rowInputs = rowPhases && phases.every((p) => {
    const def = catalog.find((w) => w.ref === p.workflowRef)
    if (!def) { if (p.workflowRef) inputsUnknown = true; return true } // 未知 ref = task-home 工作流，server 权威
    const required = Object.entries(def.inputs ?? {}).filter(([, d]) => d.required).map(([k]) => k)
    return required.every((k) => {
      const v = (p.inputValues?.[k] ?? "").trim()
      return v.length > 0 || v.includes("${")
    })
  })
  // repos 行不并入 canEnqueue —— 本地无 fs 无从验证，恒乐观 ✅；✗ 只由服务端
  // 409 missing 回填（与 inputs 行的「服务端权威」同模式）。
  return {
    rowPhases, rowSpec, specUnknown, specMissingIdx, absSpecCount: phases.length - relPhases.length,
    rowBind, rowInputs, rowRunbook,
    inputsUnknown, specTreeReady, rowRepos: true,
  }
}

/** v4 gate 409 missing 反解（票 04 契约 `phase:<i>:<why>`：no-phases /
 *  spec-missing / issues-missing / no-final-verification / workflow-ref /
 *  input:<key>；仓库预检 `project:<name>`；runbook 全局键。binding-unconfirmed
 *  随闸 ⑤ 废除退役，ADR-0028）→ 回填六行清单 ✗ + 人话。 */
export function computeGateHits(gateMissing: string[] | null): SpecGateHits {
  const hits: SpecGateHits = { phases: [], spec: [], bind: [], inputs: [], repos: [], runbook: [] }
  for (const key of gateMissing ?? []) {
    // 项目仓库预检键（服务端权威：repos/index.md 解析）—— 先拦前缀再走 catch-all。
    if (key.startsWith("project:")) {
      hits.repos.push(`仓库不可解析：${key.slice("project:".length)}（repos/index.md local 路径缺失/失效）`)
      continue
    }
    if (key === "runbook") {
      hits.runbook.push("缺「跑起来看」预设：acceptance_runbook（up+ready）∨ preview ∨ verify 任一")
      continue
    }
    const m = /^phase:(\d+):(.+)$/.exec(key)
    if (!m) { hits.phases.push(key); continue }
    const i = Number(m[1])
    const why = m[2]
    if (why === "no-phases") hits.phases.push("phases 列表为空")
    else if (why === "spec-missing") hits.spec.push(`Phase ${i}：批次目录中 spec 文件缺失`)
    else if (why === "issues-missing") hits.spec.push(`Phase ${i}：issues/ 无任何票（批次产物未落地）`)
    else if (why === "no-final-verification") hits.spec.push(`Phase ${i}：issues/ 缺 e2e 终票（或 spec 未声明 unit-only）`)
    else if (why === "workflow-ref") hits.bind.push(`Phase ${i}：工作流引用无法解析`)
    else if (why.startsWith("input:")) hits.inputs.push(`Phase ${i}：必填输入 ${why.slice("input:".length)} 未填（或占位符解析为空）`)
    else hits.phases.push(key)
  }
  return hits
}
