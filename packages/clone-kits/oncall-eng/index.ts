// packages/clone-kits/oncall-eng/index.ts
//
// 示例分身工具包：值班工程师。
// 三个工具 + 一个越权探针，用来把 clone-dev 的验证链路真正跑通。

import fs from "node:fs"
import path from "node:path"
import {
  assertSafePath,
  buildServer,
  defineTool,
  defaultSelfTest,
  type KitContext,
  type KitTool,
  type KitToolResult,
} from "../_sdk/index"

interface ExecutionRow {
  id: string
  workflow: string
  status: string
  started_at: string
  failed_node?: string
}

function readExecutions(ctx: KitContext): ExecutionRow[] {
  const candidates = [
    path.join(ctx.kitDir, "fixtures", "executions.json"),
    path.join(ctx.cloneDir, "fixtures", "executions.json"),
  ]
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, "utf-8")) as ExecutionRow[]
      } catch {
        return []
      }
    }
  }
  return []
}

function appendAction(ctx: KitContext, row: Record<string, unknown>): void {
  const dir = assertSafePath(path.join(ctx.cloneDir, "actions"), [ctx.cloneDir])
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(
    path.join(dir, "rerun-log.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`,
    "utf-8",
  )
}

/** 工具实现绑定到具体分身目录（ctx 来自 registry 的 kitContext）。 */
function makeTools(ctx: KitContext): KitTool[] {
  return [
    defineTool({
      name: "list_failed_executions",
      description: "按时间窗列出失败的工作流执行，返回执行 id、工作流名、失败节点。",
      input: { type: "object", properties: { limit: { type: "number" } } },
      handler: async (args) => {
        const limit = Number(args.limit ?? 10)
        return { items: readExecutions(ctx).filter((r) => r.status === "failed").slice(0, limit) }
      },
    }),
    defineTool({
      name: "rerun_node",
      description: "重跑指定执行里的失败节点。默认 dry-run，只记录动作不真正触发。",
      input: {
        type: "object",
        properties: {
          execution_id: { type: "string" },
          node_id: { type: "string" },
          dry_run: { type: "boolean" },
        },
        required: ["execution_id", "node_id"],
      },
      handler: async (args) => {
        const executionId = String(args.execution_id ?? "")
        const nodeId = String(args.node_id ?? "")
        if (!executionId || !nodeId) throw new Error("execution_id / node_id 必填")
        appendAction(ctx, { execution_id: executionId, node_id: nodeId })
        return { queued: true, execution_id: executionId, node_id: nodeId, dry_run: args.dry_run !== false }
      },
    }),
    defineTool({
      name: "read_node_logs",
      description: "读某个节点最近一段日志（按行号返回）。",
      input: { type: "object", properties: { node_id: { type: "string" }, lines: { type: "number" } } },
      handler: async (args) => {
        const nodeId = String(args.node_id ?? "")
        if (!nodeId) throw new Error("node_id 必填")
        const logFile = assertSafePath(path.join(ctx.cloneDir, "logs", `${nodeId}.log`), [ctx.cloneDir])
        const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8") : ""
        return { node_id: nodeId, lines: text ? text.split("\n").slice(-20) : [] }
      },
    }),
    defineTool({
      name: "export_evidence",
      description: "把一段证据写到分身目录（越权路径会被拒绝）。",
      input: {
        type: "object",
        properties: { name: { type: "string" }, body: { type: "string" } },
        required: ["name"],
      },
      handler: async (args) => {
        const target = assertSafePath(path.join(ctx.cloneDir, String(args.name ?? "evidence.md")), [ctx.cloneDir])
        fs.writeFileSync(target, String(args.body ?? ""), "utf-8")
        return { path: target }
      },
    }),
  ]
}

export function createKitServer(ctx: KitContext) {
  return buildServer(`octopus-clone-${ctx.cloneName}`, makeTools(ctx))
}

export const tools = ["list_failed_executions", "rerun_node", "read_node_logs", "export_evidence", "boundary_guard"]


/** 验证用自检：正常工具逐个调用一次；越权探针必须被拒绝。 */
export async function selfTest(ctx: KitContext): Promise<KitToolResult[]> {
  const out = await defaultSelfTest(makeTools(ctx), {
    execution_id: "e2e",
    node_id: "n1",
    name: "evidence.md",
    body: "self-test",
  })
  const guard = (() => {
    try {
      assertSafePath("/etc/passwd", [ctx.cloneDir])
      return { name: "boundary_guard", ok: false, detail: "越权路径未被拒绝" }
    } catch {
      return { name: "boundary_guard", ok: true }
    }
  })()
  return [...out, guard]
}
