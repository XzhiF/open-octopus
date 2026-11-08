import type { StepExecution } from "@/lib/types"
import { parseYaml } from "@/lib/yaml-utils"

/**
 * 工作流 YAML 窗里的「工作流树」数据源。
 *
 * 主工作流来自执行详情（workflow_content），子工作流分两类：
 *  - `sub_workflow`：静态子流，工作区里有同名 YAML；
 *  - `dynamic_sub_workflow`：运行时由 LLM 生成 DAG，只有执行作用域快照
 *    （state/dynamic-workflows/<execId>/<baseName>[-iterN].yaml），没有工作区文件。
 *
 * 动态子流的 ref 解析顺序与 DAG 视图保持一致：
 *  1. YAML 里静态 `workflow:` 字段（节点还没跑也能先出现在树上，404 = 生成中）
 *  2. 执行步骤 `outputs.generated_workflow`（node_end 时落库）
 *  3. 运行中兜底：从 scoped 子节点 id（`<nodeId>:<child>[-iterN]`）反推快照名
 */
export interface SubWorkflowRef {
  /** API 里的 ref：静态子流 = YAML 的 workflow 字段；动态子流 = 执行快照名。 */
  ref: string
  /** true = dynamic_sub_workflow 运行时生成（只有运行快照，没有工作区定义）。 */
  isDynamic: boolean
  /** 来源节点 id。 */
  nodeId: string
  /** 循环迭代序号（-iterN），无则 null。 */
  iteration: number | null
  /** 工作流树上的显示名（不含执行 id）。 */
  label: string
}

const ITER_RE = /-iter(\d+)(\.ya?ml)?$/

export function iterationOf(name: string): number | null {
  const match = name.match(ITER_RE)
  return match ? Number(match[1]) : null
}

function stripIter(name: string): string {
  return name.replace(ITER_RE, (_match, _iteration: string, extension?: string) => extension ?? "")
}

/** 树上的名字：动态子流用节点 id / 静态 workflow 名，迭代时补 `· iterN`。 */
function labelFor(ref: string, nodeId: string, staticRef: string | null): string {
  const iteration = iterationOf(ref)
  const base = staticRef ? basename(staticRef) : nodeId
  return iteration == null ? base : `${base} · iter${iteration}`
}

function basename(ref: string): string {
  const tail = ref.split("/").pop() ?? ref
  return tail.replace(/\.ya?ml$/, "")
}

function stepBelongsToNode(step: StepExecution, nodeId: string): boolean {
  if (step.stepId === nodeId) return true
  if (step.stepId.startsWith(`${nodeId}:`)) return true
  if (step.stepId.startsWith(`${nodeId}-iter`)) return true
  if (step.parentNodeId === nodeId) return true
  return typeof step.parentNodeId === "string" && step.parentNodeId.startsWith(`${nodeId}:`)
}

/**
 * 从主工作流 YAML + 执行步骤里收集所有子工作流 ref（保持 YAML 顺序、按 ref 去重）。
 * `executionId` 缺省时不推导动态子流兜底名 —— 预览态没有执行作用域，推导出来也取不到。
 */
export function collectSubWorkflowRefs(
  yamlContent: string | null | undefined,
  steps: StepExecution[] | null | undefined,
  executionId?: string | null,
): SubWorkflowRef[] {
  if (!yamlContent) return []
  const parsed = parseYaml(yamlContent)
  const nodes = parsed?.nodes
  if (!Array.isArray(nodes)) return []

  const rootName = typeof parsed?.name === "string" && parsed.name.trim() ? parsed.name.trim() : "workflow"
  const stepList = steps ?? []
  const out: SubWorkflowRef[] = []
  const seen = new Set<string>()

  const push = (item: SubWorkflowRef) => {
    if (!item.ref) return
    const key = `${item.isDynamic ? "d" : "s"}:${item.ref}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(item)
  }

  const collectDynamic = (nodeId: string, rawWorkflow: unknown) => {
    const staticRef = typeof rawWorkflow === "string" && rawWorkflow.trim() ? rawWorkflow.trim() : null
    const baseName = staticRef ?? `${rootName}__${nodeId}`

    // 静态字段先占位：节点还没跑时树上也有一条「生成中…」。
    if (staticRef) {
      push({
        ref: staticRef,
        isDynamic: true,
        nodeId,
        iteration: iterationOf(staticRef),
        label: labelFor(staticRef, nodeId, staticRef),
      })
    }

    let foundGenerated = false
    for (const step of stepList) {
      if (!stepBelongsToNode(step, nodeId)) continue
      const generated = (step.outputs as Record<string, unknown> | undefined)?.generated_workflow
      if (typeof generated !== "string" || !generated) continue
      foundGenerated = true
      push({
        ref: generated,
        isDynamic: true,
        nodeId,
        iteration: iterationOf(generated) ?? step.iterationIndex ?? null,
        label: labelFor(generated, nodeId, staticRef),
      })
    }
    if (foundGenerated || !executionId) return

    // 运行中：outputs 只在 node_end 落库，但 scoped 子节点 id 已经能推出快照名。
    const iterations = new Set<number>()
    let scoped = false
    for (const step of stepList) {
      if (!step.stepId.startsWith(`${nodeId}:`)) continue
      scoped = true
      const iteration = iterationOf(step.stepId)
      if (iteration != null) iterations.add(iteration)
    }
    for (const iteration of [...iterations].sort((a, b) => a - b)) {
      const ref = `${baseName}-iter${iteration}`
      push({ ref, isDynamic: true, nodeId, iteration, label: labelFor(ref, nodeId, staticRef) })
    }
    if (iterations.size === 0 && scoped) {
      push({
        ref: baseName,
        isDynamic: true,
        nodeId,
        iteration: null,
        label: labelFor(baseName, nodeId, staticRef),
      })
    }
  }

  const visit = (list: unknown[]) => {
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue
      const node = raw as Record<string, unknown>
      const nodeId = typeof node.id === "string" ? node.id : ""
      const type = node.type

      if (type === "sub_workflow" && typeof node.workflow === "string" && node.workflow.trim()) {
        const ref = node.workflow.trim()
        push({
          ref,
          isDynamic: false,
          nodeId,
          iteration: null,
          label: labelFor(ref, nodeId, ref),
        })
      }
      if (type === "dynamic_sub_workflow" && nodeId) {
        collectDynamic(nodeId, node.workflow)
      }

      if (Array.isArray(node.nodes)) visit(node.nodes)
      if (Array.isArray(node.loop_body)) visit(node.loop_body)
    }
  }

  visit(nodes)
  return out
}

/** YAML 里的 `name:` 优先；缺省退回 ref 的末段（去 .yaml）。生成文件的 name 带执行 id，慎用。 */
export function workflowDisplayName(
  content: string | null | undefined,
  ref: string | null | undefined,
): string {
  if (content) {
    const parsed = parseYaml(content)
    const name = parsed?.name
    if (typeof name === "string" && name.trim()) return name.trim()
  }
  if (!ref) return "工作流"
  return basename(ref) || "工作流"
}

/** 动态子流快照的显示名：去掉执行 id 后缀与迭代后缀。 */
export function childDisplayName(ref: string): string {
  return stripIter(basename(ref))
}
