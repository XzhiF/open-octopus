// packages/clone-kits/_sdk/index.ts
//
// 分身工具包 SDK。kit 只依赖这里 + @octopus/providers，不反向依赖 server。
//
// 约定（clone-dev v1）：
//   - 每个 kit 导出 `createKitServer(ctx)` → SDK 进程内 MCP server
//   - 可选导出 `selfTest(ctx)` → 逐工具自检结果，验证脚本用它证明「工具可用」
//   - 可选导出 `tools` → 声明的工具名，用于与 task_spec 对账
//
// 路径安全：工具里所有文件读写都必须过 `assertSafePath`，根限于分身目录与
// 显式允许的仓库目录。越权路径必须抛错 —— 这也是验证判据 ② 的被测点。

import path from "node:path"
import { createSdkMcpServer, tool } from "@octopus/providers"

export { createSdkMcpServer, tool }

export interface KitContext {
  cloneName: string
  cloneDir: string
  repoRoot: string | null
  kitDir: string
}

export interface KitToolResult {
  name: string
  ok: boolean
  detail?: string
}

const DENIED = [/^\/etc\//, /^\/usr\//, /^\/bin\//, /(^|\/)\.\.(\/|$)/]

/** 把相对/绝对路径限制在 allowedRoots 内，越界抛错。 */
export function assertSafePath(input: string, allowedRoots: string[]): string {
  if (!input || typeof input !== "string") throw new Error("path required")
  if (DENIED.some((re) => re.test(input))) throw new Error(`拒绝访问越权路径: ${input}`)
  const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(allowedRoots[0], input)
  const inside = allowedRoots.some((root) => {
    const rel = path.relative(path.resolve(root), abs)
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
  })
  if (!inside) throw new Error(`拒绝访问越权路径: ${input}`)
  return abs
}

/** 工具定义的最小形状；具体 kit 用 defineTool 写，再用 buildServer 汇总。 */
export interface KitTool {
  name: string
  description: string
  input: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

export function defineTool(def: KitTool): KitTool {
  return def
}

/** 把一组 handler 包成 SDK 进程内 MCP server。 */
export function buildServer(name: string, tools: KitTool[]) {
  return createSdkMcpServer({
    name,
    version: "1.0.0",
    tools: tools.map((t) =>
      tool(t.name, t.description, t.input as never, async (args: never) => {
        const result = await t.handler(args as Record<string, unknown>)
        return { content: [{ type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) }] }
      }),
    ),
  })
}

/** 默认自检：逐个调用 handler 的探针（kit 可覆盖）。 */
export async function defaultSelfTest(tools: KitTool[], args?: Record<string, unknown>): Promise<KitToolResult[]> {
  const out: KitToolResult[] = []
  for (const t of tools) {
    try {
      await t.handler(args ?? {})
      out.push({ name: t.name, ok: true })
    } catch (err) {
      out.push({ name: t.name, ok: false, detail: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}
