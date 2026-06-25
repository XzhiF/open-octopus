import { Command } from "commander"
import chalk from "chalk"

function getServerUrl(): string {
  return process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001"
}

function agentHeaders(org?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": process.env.OCTOPUS_AGENT_TOKEN ? `Bearer ${process.env.OCTOPUS_AGENT_TOKEN}` : "Bearer agent",
  }
  if (org) headers["X-Octopus-Org"] = org
  return headers
}

async function agentGet(path: string, org?: string): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetch(`${getServerUrl()}/api/agent${path}`, {
    headers: agentHeaders(org),
  })
  const data = await res.json()
  return { ok: res.ok, data }
}

async function agentPost(path: string, body: unknown, org?: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${getServerUrl()}/api/agent${path}`, {
    method: "POST",
    headers: agentHeaders(org),
    body: JSON.stringify(body),
  })
  const data = await res.json()
  return { ok: res.ok, status: res.status, data }
}

async function agentDelete(path: string, org?: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${getServerUrl()}/api/agent${path}`, {
    method: "DELETE",
    headers: agentHeaders(org),
  })
  const data = await res.json()
  return { ok: res.ok, status: res.status, data }
}

function resolveOrg(options: { org?: string }): string | undefined {
  if (options.org) return options.org
  if (process.env.OCTOPUS_ORG) return process.env.OCTOPUS_ORG
  // Auto-detect org from cwd path: ~/.octopus/orgs/{org}/...
  const cwd = process.cwd()
  const match = cwd.match(/\.octopus\/orgs\/([^/]+)/)
  if (match) return match[1]
  return undefined
}

export const agentCmd = new Command("agent")
  .description("Agent management commands")

// ── Health ─────────────────────────────────────────────────────────

async function actuatorGet(path: string): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetch(`${getServerUrl()}/api/actuator${path}`)
  const data = await res.json()
  return { ok: res.ok, data }
}

agentCmd.command("health")
  .description("Check agent subsystem health")
  .action(async () => {
    try {
      const { ok, data } = await actuatorGet("/health")
      const health = data as Record<string, unknown>
      if (ok) {
        const components = health.components as Record<string, { status: string; details?: Record<string, unknown> }> | undefined
        console.log(`${chalk.green("●")} Status: ${health.status}`)
        if (components) {
          for (const [name, comp] of Object.entries(components)) {
            const icon = comp.status === 'ok' ? chalk.green("●") : comp.status === 'down' ? chalk.red("●") : chalk.yellow("●")
            console.log(`  ${icon} ${name}: ${comp.status}`)
          }
        }
      } else {
        console.error(chalk.red(`Error: ${JSON.stringify(data)}`))
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`Error: ${msg}`))
    }
  })

// ── Sessions ───────────────────────────────────────────────────────

agentCmd.command("sessions")
  .description("List agent sessions")
  .option("--org <org>", "Organization name")
  .option("--limit <n>", "Max results", "20")
  .action(async (options) => {
    try {
      const { data } = await agentGet(`/sessions?limit=${options.limit}`, resolveOrg(options))
      console.log(JSON.stringify(data, null, 2))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`Error: ${msg}`))
    }
  })

// ── Memory ─────────────────────────────────────────────────────────

agentCmd.command("memory")
  .description("Memory management commands")
  .argument("[action]", "Action: show, search, add, rebuild-fts, archive (default: show)")
  .argument("[query]", "Search query (for search action)")
  .option("--org <org>", "Organization name")
  .option("--layer <layer>", "Memory layer: long-term, daily, session")
  .option("--clone <name>", "Clone name (for clone-scoped memory)")
  .option("--content <text>", "Content to add (for add action)")
  .action(async (action: string | undefined, query: string | undefined, options) => {
    try {
      const org = resolveOrg(options)
      const act = action ?? "show"

      if (act === "show") {
        const layer = options.layer ?? "long-term"
        const params = new URLSearchParams()
        if (options.clone) params.set("clone", options.clone)
        const qs = params.toString() ? `?${params}` : ""
        const { ok, data } = await agentGet(`/memory/${layer}${qs}`, org)
        if (ok) {
          const mem = data as { content?: string }
          console.log(mem.content ?? JSON.stringify(data, null, 2))
        } else {
          console.error(chalk.red(`Error: ${JSON.stringify(data)}`))
          process.exitCode = 1
        }
        return
      }

      if (act === "search") {
        if (!query) {
          console.error(chalk.red("Error: search query is required"))
          process.exitCode = 1
          return
        }
        const params = new URLSearchParams({ q: query })
        if (options.layer) params.set("layer", options.layer)
        const { data } = await agentGet(`/memory/search?${params}`, org)
        console.log(JSON.stringify(data, null, 2))
        return
      }

      if (act === "add") {
        if (!options.content) {
          console.error(chalk.red("Error: --content is required for add"))
          process.exitCode = 1
          return
        }
        const body: Record<string, unknown> = { content: options.content }
        if (options.layer) body.layer = options.layer
        if (options.clone) body.clone = options.clone
        const result = await agentPost("/memory", body, org)
        if (result.ok) {
          console.log(chalk.green("记忆已添加"))
        } else {
          console.error(chalk.red(`Error: ${JSON.stringify(result.data)}`))
          process.exitCode = 1
        }
        return
      }

      if (act === "rebuild-fts") {
        const result = await agentPost("/memory/rebuild-fts", {}, org)
        if (result.ok) {
          console.log(chalk.green("FTS 索引重建完成"))
        } else {
          console.error(chalk.red(`Error: ${JSON.stringify(result.data)}`))
          process.exitCode = 1
        }
        return
      }

      if (act === "archive") {
        const result = await agentPost("/memory/archive", {}, org)
        if (result.ok) {
          console.log(chalk.green("跨天归档已触发"))
        } else {
          console.error(chalk.red(`Error: ${JSON.stringify(result.data)}`))
          process.exitCode = 1
        }
        return
      }

      console.error(chalk.red(`Unknown memory action: ${act}. Use show, search, add, rebuild-fts, or archive.`))
      process.exitCode = 1
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`Error: ${msg}`))
      process.exitCode = 1
    }
  })

// ── Clones ─────────────────────────────────────────────────────────

agentCmd.command("clones")
  .description("List agent clones")
  .option("--org <org>", "Organization name")
  .action(async (options) => {
    try {
      const { data } = await agentGet("/clones", resolveOrg(options))
      console.log(JSON.stringify(data, null, 2))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`Error: ${msg}`))
    }
  })

// ── Skills ─────────────────────────────────────────────────────────

agentCmd.command("skills")
  .description("List agent skills")
  .option("--org <org>", "Organization name")
  .action(async (options) => {
    try {
      const { data } = await agentGet("/skills", resolveOrg(options))
      console.log(JSON.stringify(data, null, 2))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`Error: ${msg}`))
    }
  })

// ── Config ─────────────────────────────────────────────────────────

agentCmd.command("config")
  .description("Show or update agent config")
  .option("--org <org>", "Organization name")
  .option("--set <key=value>", "Update a config field")
  .action(async (options) => {
    try {
      const org = resolveOrg(options)
      if (options.set) {
        const eqIdx = options.set.indexOf("=")
        if (eqIdx <= 0) {
          console.error(chalk.red("Invalid --set format. Use key=value"))
          return
        }
        const key = options.set.slice(0, eqIdx)
        const value = options.set.slice(eqIdx + 1)
        const res = await fetch(`${getServerUrl()}/api/agent/config`, {
          method: "PUT",
          headers: agentHeaders(org),
          body: JSON.stringify({ [key]: value }),
        })
        const data = await res.json()
        if (res.ok) {
          console.log(chalk.green("Config updated"))
          console.log(JSON.stringify(data, null, 2))
        } else {
          console.error(chalk.red(`Error: ${JSON.stringify(data)}`))
        }
      } else {
        const { data } = await agentGet("/config", org)
        console.log(JSON.stringify(data, null, 2))
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`Error: ${msg}`))
    }
  })

// ── Tasks ──────────────────────────────────────────────────────────

agentCmd.command("tasks")
  .description("List or manage agent tasks")
  .argument("[action]", "Action: list (default), cancel, history")
  .argument("[id]", "Task ID (for cancel)")
  .option("--org <org>", "Organization name")
  .action(async (action: string | undefined, id: string | undefined, options) => {
    try {
      const org = resolveOrg(options)
      const act = action ?? "list"

      if (act === "cancel") {
        if (!id) {
          console.error(chalk.red("Error: task ID is required for cancel"))
          process.exitCode = 1
          return
        }
        const result = await agentPost(`/tasks/${id}/cancel`, {}, org)
        if (result.ok) {
          console.log(chalk.green(`任务 ${id} 已取消`))
        } else {
          console.error(chalk.red(`Error: ${JSON.stringify(result.data)}`))
          process.exitCode = 1
        }
        return
      }

      if (act === "history") {
        const { data } = await agentGet("/tasks/history", org)
        console.log(JSON.stringify(data, null, 2))
        return
      }

      // Default: list
      const { data } = await agentGet("/tasks", org)
      console.log(JSON.stringify(data, null, 2))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`Error: ${msg}`))
    }
  })

// ── Safe Mode ──────────────────────────────────────────────────────

agentCmd.command("safe-mode")
  .description("Check or toggle safe mode")
  .option("--org <org>", "Organization name")
  .option("--enable", "Enable safe mode")
  .option("--disable", "Disable safe mode")
  .action(async (options) => {
    try {
      const org = resolveOrg(options)
      if (options.enable) {
        const res = await fetch(`${getServerUrl()}/api/agent/safe-mode/enable`, {
          method: "POST",
          headers: agentHeaders(org),
        })
        const data = await res.json()
        console.log(res.ok ? chalk.green("Safe mode enabled") : chalk.red(JSON.stringify(data)))
      } else if (options.disable) {
        const res = await fetch(`${getServerUrl()}/api/agent/safe-mode/disable`, {
          method: "POST",
          headers: agentHeaders(org),
        })
        const data = await res.json()
        console.log(res.ok ? chalk.green("Safe mode disabled") : chalk.red(JSON.stringify(data)))
      } else {
        const { data } = await agentGet("/safe-mode", org)
        console.log(JSON.stringify(data, null, 2))
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`Error: ${msg}`))
    }
  })

// ── Chat ────────────────────────────────────────────────────────────

agentCmd.command("chat")
  .description("Send a chat message to the agent")
  .argument("<message>", "Message to send")
  .option("--org <org>", "Organization name")
  .option("--session <id>", "Session ID (creates new if omitted)")
  .option("--debug", "Enable debug mode for this chat")
  .action(async (message: string, options) => {
    try {
      const org = resolveOrg(options)
      let sessionId = options.session

      // Enable debug mode if requested
      if (options.debug) {
        await fetch(`${getServerUrl()}/api/agent/config`, {
          method: "PUT",
          headers: agentHeaders(org),
          body: JSON.stringify({ debug: { enabled: true } }),
        })
      }

      // Create session if not provided
      if (!sessionId) {
        const createRes = await fetch(`${getServerUrl()}/api/agent/sessions`, {
          method: "POST",
          headers: agentHeaders(org),
          body: JSON.stringify({}),
        })
        const createData = await createRes.json() as { id?: string }
        sessionId = createData.id
        if (!sessionId) {
          console.error(chalk.red("Failed to create session"))
          process.exitCode = 1
          return
        }
      }

      // Send message via SSE
      const chatRes = await fetch(`${getServerUrl()}/api/agent/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: { ...agentHeaders(org), Accept: "text/event-stream" },
        body: JSON.stringify({ message }),
      })

      if (!chatRes.ok) {
        const errData = await chatRes.json()
        console.error(chalk.red(`Error: ${JSON.stringify(errData)}`))
        process.exitCode = 1
        return
      }

      // Read SSE stream
      const reader = chatRes.body?.getReader()
      if (!reader) {
        console.error(chalk.red("No response stream"))
        process.exitCode = 1
        return
      }

      const decoder = new TextDecoder()
      let fullContent = ""
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          if (line.startsWith("event: text_delta")) continue
          if (line.startsWith("data: ")) {
            try {
              const payload = JSON.parse(line.slice(6))
              if (payload.content) {
                fullContent = payload.content
              } else if (payload.delta) {
                fullContent += payload.delta
              }
            } catch { /* skip malformed */ }
          }
          if (line.startsWith("event: done")) continue
        }
      }

      if (fullContent) {
        console.log(fullContent)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`Error: ${msg}`))
      process.exitCode = 1
    }
  })

// ── Clone Create ────────────────────────────────────────────────────

agentCmd.command("clone")
  .description("Clone management commands")
  .argument("<action>", "Action: create, list, use, merge, delete")
  .argument("[name]", "Clone name (for create/use/merge/delete)")
  .option("--org <org>", "Organization name")
  .option("--workspace <id>", "Workspace to bind")
  .option("--keep-workspace", "Keep workspace when deleting")
  .option("--delete-workspace", "Delete workspace when deleting")
  .action(async (action: string, name: string | undefined, options) => {
    try {
      const org = resolveOrg(options)

      if (action === "list") {
        const { data } = await agentGet("/clones", org)
        console.log(JSON.stringify(data, null, 2))
        return
      }

      if (action === "create") {
        if (!name) {
          console.error(chalk.red("Error: clone name is required"))
          process.exitCode = 1
          return
        }
        const body: Record<string, unknown> = { name }
        if (options.workspace) body.workspace_id = options.workspace
        const result = await agentPost("/clones", body, org)

        if (result.ok) {
          const cloneData = (result.data as { clone?: { name: string } }).clone
          console.log(chalk.green(`分身创建成功: ${cloneData?.name ?? name}`))

          const fs = await import("fs")
          const path = await import("path")
          const os = await import("os")
          const cloneDir = path.join(os.homedir(), ".octopus", "agent", "clones", name)
          if (!fs.existsSync(cloneDir)) {
            fs.mkdirSync(cloneDir, { recursive: true })
          }
          const personaPath = path.join(cloneDir, "persona.md")
          if (!fs.existsSync(personaPath)) {
            fs.writeFileSync(personaPath, `# ${name} 分身人格\n\n专注于 ${name} 相关任务。\n`, "utf-8")
          }
          const wsRefPath = path.join(cloneDir, "workspace-ref.json")
          if (!fs.existsSync(wsRefPath)) {
            fs.writeFileSync(wsRefPath, JSON.stringify({
              workspace_id: options.workspace ?? null,
              created_at: new Date().toISOString(),
            }, null, 2), "utf-8")
          }
        } else {
          console.error(chalk.red(`Error: ${JSON.stringify(result.data)}`))
          process.exitCode = 1
        }
        return
      }

      if (action === "use") {
        if (!name) {
          console.error(chalk.red("Error: clone name is required"))
          process.exitCode = 1
          return
        }
        const result = await agentPost(`/clones/${name}/activate`, {}, org)
        if (result.ok) {
          console.log(chalk.green(`已切换到 ${name} 视角`))
        } else {
          const errData = result.data as { error?: { message?: string } }
          console.error(chalk.red(`Error: ${errData?.error?.message ?? JSON.stringify(result.data)}`))
          process.exitCode = 1
        }
        return
      }

      if (action === "merge") {
        if (!name) {
          console.error(chalk.red("Error: clone name is required"))
          process.exitCode = 1
          return
        }
        const result = await agentPost(`/clones/${name}/merge`, {}, org)
        if (result.ok) {
          console.log(chalk.green(`分身 ${name} 已合并，经验归档到主 Agent`))
        } else {
          const errData = result.data as { error?: { message?: string } }
          console.error(chalk.red(`Error: ${errData?.error?.message ?? JSON.stringify(result.data)}`))
          process.exitCode = 1
        }
        return
      }

      if (action === "delete") {
        if (!name) {
          console.error(chalk.red("Error: clone name is required"))
          process.exitCode = 1
          return
        }
        const params = new URLSearchParams()
        if (options.keepWorkspace) params.set("keep_workspace", "true")
        if (options.deleteWorkspace) params.set("keep_workspace", "false")
        const qs = params.toString() ? `?${params}` : ""
        const result = await agentDelete(`/clones/${name}${qs}`, org)
        if (result.ok) {
          console.log(chalk.green(`分身 ${name} 已删除（记忆不会归档）`))
        } else {
          const errData = result.data as { error?: { message?: string } }
          console.error(chalk.red(`Error: ${errData?.error?.message ?? JSON.stringify(result.data)}`))
          process.exitCode = 1
        }
        return
      }

      console.error(chalk.red(`Unknown clone action: ${action}. Use create, list, use, merge, or delete.`))
      process.exitCode = 1
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`Error: ${msg}`))
      process.exitCode = 1
    }
  })

// ── Onboarding ──────────────────────────────────────────────────────

agentCmd.command("onboarding")
  .description("Manage agent onboarding")
  .option("--org <org>", "Organization name")
  .option("--reset", "Reset onboarding state")
  .action(async (options) => {
    try {
      const org = resolveOrg(options)

      if (options.reset) {
        const res = await fetch(`${getServerUrl()}/api/agent/config`, {
          method: "PUT",
          headers: agentHeaders(org),
          body: JSON.stringify({ onboarding_completed: false }),
        })
        const data = await res.json()
        if (res.ok) {
          console.log(chalk.green("Onboarding 已重置，下次进入将重新显示引导"))
        } else {
          console.error(chalk.red(`Error: ${JSON.stringify(data)}`))
          process.exitCode = 1
        }
      } else {
        const { data } = await agentGet("/config", org)
        const config = data as { config?: { onboarding_completed?: boolean } }
        const completed = config.config?.onboarding_completed ?? false
        console.log(`Onboarding: ${completed ? chalk.green("已完成") : chalk.yellow("未完成")}`)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`Error: ${msg}`))
      process.exitCode = 1
    }
  })

// ── Evolution List ──────────────────────────────────────────────────

agentCmd.command("evolution")
  .description("Evolution management commands")
  .argument("[action]", "Action: list (default), rollback, revert-to-builtin")
  .argument("[id-or-skill]", "Log ID (for rollback) or skill name (for revert-to-builtin)")
  .option("--org <org>", "Organization name")
  .option("--limit <n>", "Max results", "20")
  .action(async (action: string | undefined, idOrSkill: string | undefined, options) => {
    try {
      const org = resolveOrg(options)

      if (action === "rollback") {
        if (!idOrSkill) {
          console.error(chalk.red("Error: evolution log ID is required"))
          process.exitCode = 1
          return
        }
        const result = await agentPost(`/evolution/rollback/${idOrSkill}`, {}, org)
        if (result.ok) {
          console.log(chalk.green(`进化已回滚: ${idOrSkill}`))
        } else {
          const errData = result.data as { error?: { message?: string } }
          console.error(chalk.red(`Error: ${errData?.error?.message ?? JSON.stringify(result.data)}`))
          process.exitCode = 1
        }
        return
      }

      if (action === "revert-to-builtin") {
        if (!idOrSkill) {
          console.error(chalk.red("Error: skill name is required"))
          process.exitCode = 1
          return
        }
        const result = await agentDelete(`/skills/${idOrSkill}/local`, org)
        if (result.ok) {
          console.log(chalk.green(`已回退到内置版: ${idOrSkill}`))
        } else {
          const errData = result.data as { error?: { message?: string } }
          console.error(chalk.red(`Error: ${errData?.error?.message ?? JSON.stringify(result.data)}`))
          process.exitCode = 1
        }
        return
      }

      // Default: list changelog
      const { data } = await agentGet(`/evolution/changelog?limit=${options.limit}`, org)
      console.log(JSON.stringify(data, null, 2))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`Error: ${msg}`))
    }
  })

// ── Debug Log ───────────────────────────────────────────────────────

agentCmd.command("debug")
  .description("View debug logs")
  .argument("[action]", "Action: log (default), assemble")
  .argument("[id]", "Session ID (for log) or chat ID (for assemble)")
  .option("--org <org>", "Organization name")
  .option("--limit <n>", "Max results", "100")
  .option("--level <level>", "Log level filter")
  .option("--session <id>", "Filter by session ID")
  .action(async (action: string | undefined, id: string | undefined, options) => {
    try {
      const org = resolveOrg(options)
      const act = action ?? "log"

      if (act === "assemble") {
        if (!id) {
          console.error(chalk.red("Error: chat ID is required for assemble"))
          process.exitCode = 1
          return
        }
        const { ok, data } = await agentGet(`/debug/assemble/${id}`, org)
        if (ok) {
          console.log(JSON.stringify(data, null, 2))
        } else {
          console.error(chalk.red(`Error: ${JSON.stringify(data)}`))
          process.exitCode = 1
        }
        return
      }

      // Default: log
      const params = new URLSearchParams({ limit: options.limit })
      if (options.level) params.set("level", options.level)
      if (options.session) params.set("session_id", options.session)
      if (id && !options.session) params.set("session_id", id)
      const { data } = await agentGet(`/debug/log?${params}`, org)
      console.log(JSON.stringify(data, null, 2))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`Error: ${msg}`))
    }
  })
