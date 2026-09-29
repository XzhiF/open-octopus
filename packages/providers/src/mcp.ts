// packages/providers/src/mcp.ts
//
// 进程内 MCP 工具桥 —— 把「服务端原生工具」以 SDK MCP tool 的形式注入 agent 会话，
// 让模型在同一轮对话里拿到真实工具返回值（区别于事后拦截的伪工具：record_daily
// 等写侧工具只在流结束后被路由层执行，结果不回灌模型）。
//
// SDK 依赖被完整封在这里：server 只看到 InProcessToolDef / createInProcessMcpServer
// 两个不透明符号，不引入 @anthropic-ai/claude-agent-sdk 类型。

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'

export interface InProcessToolResult {
  /** 回灌给模型的文本（通常是 JSON.stringify 后的结果） */
  text: string
  /** 错误语义：显式标记失败，模型能看清「没查到」与「查询坏了」的区别 */
  isError?: boolean
}

export interface InProcessToolDef {
  name: string
  description: string
  /** Zod raw shape（SDK tool() 的 inputSchema 形态）。结构类型收口，
   *  不把 zod 类型暴露给 server，也不在此包引 zod 运行时依赖。 */
  schema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => InProcessToolResult | Promise<InProcessToolResult>
}

/**
 * mcpServers 选项值的不透明类型 —— 由 createInProcessMcpServer 产出，
 * 原样塞进 SendQueryOptions.mcpServers。
 */
export type InProcessMcpServer = { readonly __brand: 'InProcessMcpServer' }

/**
 * 构造一个进程内 MCP server。模型侧可见工具名为
 * `mcp__{serverName}__{tool.name}`，调用在同进程内同步执行并回灌结果。
 */
export function createInProcessMcpServer(
  serverName: string,
  tools: InProcessToolDef[],
): InProcessMcpServer {
  const server = createSdkMcpServer({
    name: serverName,
    // schema 以 zod raw shape 由调用方传入；SDK 泛型在「异构工具列表」上无法
    // 统一推断（每个工具 Schema 不同），整表桥接到 createSdkMcpServer 的入参类型。
    tools: tools.map((t) =>
      tool(
        t.name,
        t.description,
        t.schema as never,
        async (args: never) => {
          const r = await t.handler((args ?? {}) as unknown as Record<string, unknown>)
          return {
            content: [{ type: 'text' as const, text: r.text }],
            ...(r.isError ? { isError: true } : {}),
          }
        },
      ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any,
  })
  return server as unknown as InProcessMcpServer
}
