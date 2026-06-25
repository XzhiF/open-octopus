// packages/cli/src/commands/notify.ts
import { Command } from "commander"
import { readFileSync, existsSync } from "fs"

export const notifyCmd = new Command("notify")
  .description("发送通知消息（需从工作流内调用）")
  .requiredOption("--title <title>", "通知标题")
  .option("--body <body>", "通知正文", "")
  .option("--severity <severity>", "严重级别: info|warn|error", "info")
  .option("--channel <channel>", "目标 channel", "default")
  .option("--ignore-failure", "失败时不报错（退出码 0）", false)
  .action(async (opts: { title: string; body: string; severity: string; channel: string; ignoreFailure: boolean }) => {
    const validSeverities = ["info", "warn", "error"]
    if (!validSeverities.includes(opts.severity)) {
      console.error(`ERROR: Invalid severity '${opts.severity}'. Must be one of: ${validSeverities.join(", ")}`)
      process.exit(1)
    }
    // TODO(V1.1): Engine 侧需实现 context file 写入机制。
    // 当前 octopus notify 命令仅在手动创建上下文文件后可用。
    // 计划: BashExecutor 在 bash 节点执行前将 {providers, channels, variables}
    // 写入 os.tmpdir()/octopus-notify-{executionId}-{nodeId}.json,
    // 并将路径注入 OCTOPUS_NOTIFY_CONTEXT_PATH 环境变量。
    // bash 节点执行完毕后在 finally 块中删除临时文件。
    const contextPath = process.env.OCTOPUS_NOTIFY_CONTEXT_PATH
    if (!contextPath || !existsSync(contextPath)) {
      console.error("ERROR: OCTOPUS_NOTIFY_CONTEXT_PATH not set or file not found.")
      console.error("This command must be called from within an Octopus workflow.")
      process.exit(1)
    }

    try {
      const { VarPool, TemplateRenderer } = await import("@octopus/shared")
      const { NotifyDispatcher, ProviderRegistry, registerBuiltinProviders } = await import("@octopus/engine")

      registerBuiltinProviders()
      const registry = new ProviderRegistry()
      const renderer = new TemplateRenderer()
      const dispatcher = new NotifyDispatcher(registry, renderer)

      const ctx = JSON.parse(readFileSync(contextPath, "utf-8"))
      const pool = new VarPool(ctx.variables ?? {})
      const results = await dispatcher.dispatch({
        hook: {
          type: "notify",
          channel: opts.channel,
          template: {
            severity: opts.severity as "info" | "warn" | "error",
            title: opts.title,
            body: opts.body,
          },
        },
        pool,
        providers: ctx.providers ?? {},
        channels: ctx.channels ?? {},
      })

      const hasFailure = results.some(r => !r.success)
      if (hasFailure && !opts.ignoreFailure) {
        const errors = results.filter(r => !r.success).map(r => `${r.channel}: ${r.error}`)
        console.error(`Notification failed:\n${errors.join("\n")}`)
        process.exit(1)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!opts.ignoreFailure) {
        console.error(`Notify error: ${msg}`)
        process.exit(1)
      }
    }
  })
