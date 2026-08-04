import { Command } from "commander"
import chalk from "chalk"
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, statSync, rmSync, chmodSync } from "fs"
import { resolve, join } from "path"
import { parseWorkflow, validateWorkflow, resolveOrgDir, PipelineConfigSchema, PipelineConfigV1Schema, ResourcePreFlight, ResourceProvisioner, ResourceManager } from "@octopus/shared"
import { WorkflowEngine, registerBuiltinProviders, type TestRunnerResult } from "@octopus/engine"
import { registerProvider, ClaudeSDKProvider, PiAgentProvider, getProviderAsync } from "@octopus/providers"
import { resolveCurrentOrg, resolveBuiltinWorkflowsDir } from "../utils/path"
import { load as yamlLoad, JSON_SCHEMA } from "js-yaml"

export const workflowCmd = new Command("workflow")
  .description("工作流管理")

workflowCmd
  .command("run")
  .description("执行工作流 YAML 文件")
  .argument("<yaml-path>", "YAML 文件路径")
  .option("--org <org>", "组织名")
  .option("--model <model>", "覆盖全局 model")
  .option("--engine <engine>", "覆盖全局 engine")
  .option("--input <key=value...>", "工作流输入参数（可多次指定，如 --input requirement='需求描述'）")
  .option("--execution-name <name>", "执行名称（显示在通知和日志中）")
  .action(async (yamlPath: string, options: { org?: string; model?: string; engine?: string; input?: string[]; executionName?: string }) => {
    const org = options.org || resolveCurrentOrg()
    const orgDir = resolveOrgDir(org)
    registerProvider('claude', () => new ClaudeSDKProvider())
    registerProvider('pi', () => new PiAgentProvider())

    const absPath = resolve(yamlPath)
    if (!existsSync(absPath)) {
      console.error(`Error: YAML file not found: ${absPath}`)
      process.exit(1)
    }

    const content = readFileSync(absPath, "utf-8")
    const wf = parseWorkflow(content)
    validateWorkflow(wf)

    if (options.model) wf.model = options.model
    if (options.engine) wf.engine = options.engine

    // Parse --input key=value pairs
    const initialInputs: Record<string, string> = {}
    if (options.input) {
      for (const pair of options.input) {
        const eqIdx = pair.indexOf("=")
        if (eqIdx > 0) {
          initialInputs[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1)
        } else {
          console.warn(`Warning: ignoring invalid input '${pair}' (expected key=value)`)
        }
      }
    }

    // Resolve providers dynamically for the workflow engine + cross-provider support
    const providers: Record<string, any> = {}
    const engineType = wf.engine || "claude"
    const provider = await getProviderAsync(engineType)
    if (provider) {
      providers[engineType] = provider
    }
    // Also register the other provider for swarm sub-agents
    if (engineType !== "pi") {
      try { providers["pi"] = await getProviderAsync("pi") } catch { /* not registered */ }
    }
    if (engineType !== "claude") {
      try { providers["claude"] = await getProviderAsync("claude") } catch { /* not registered */ }
    }

    // Resource preflight: ensure agent_file/skills are available in workspace
    const workspaceDir = orgDir ?? process.cwd()
    try {
      const preflight = new ResourcePreFlight()
      const manifest = preflight.analyze(wf)
      if (manifest.agents.length > 0 || manifest.skills.length > 0) {
        const check = preflight.check(manifest, workspaceDir)
        if (check.missing.length > 0) {
          const manager = new ResourceManager()
          manager.registerBuiltins()
          const provisioner = new ResourceProvisioner(manager)
          const provisionable = check.missing.filter(
            (m): m is { type: 'agent' | 'skill'; name: string } =>
              m.type === 'agent' || m.type === 'skill',
          )
          const result = await provisioner.provision(provisionable, workspaceDir)
          if (result.provisioned > 0) {
            console.log(`[preflight] Provisioned ${result.provisioned} resource(s) to ${workspaceDir}`)
          }
          if (result.failed.length > 0) {
            console.warn(`[preflight] Failed to provision: ${result.failed.join(", ")}`)
          }
        }
      }
    } catch (err) {
      console.warn(`[preflight] ${err instanceof Error ? err.message : String(err)}`)
    }

    const engine = new WorkflowEngine(
      wf,
      providers,
      process.cwd(),
      orgDir,
      undefined,
      undefined,
      undefined,
      Object.keys(initialInputs).length > 0 ? initialInputs : undefined,
      options.executionName,
    )

    // Load pipeline config for notify system
    registerBuiltinProviders()
    const pipelinePath = join(orgDir ?? process.cwd(), "pipeline.yaml")
    if (existsSync(pipelinePath)) {
      try {
        const raw = yamlLoad(readFileSync(pipelinePath, "utf-8"), { schema: JSON_SCHEMA }) as Record<string, unknown>
        if (raw?.apiVersion && raw?.kind === "Pipeline") {
          let config
          if (raw.apiVersion === "octopus/v1") {
            const v1 = PipelineConfigV1Schema.parse(raw)
            config = PipelineConfigSchema.parse({
              ...v1,
              apiVersion: "octopus/v2",
              kind: "Pipeline",
              providers: v1.providers ?? {},
              channels: v1.channels ?? {},
            })
          } else {
            config = PipelineConfigSchema.parse(raw)
          }
          engine.setPipelineConfig(config)
        }
      } catch (e) {
        console.warn(`Warning: Failed to load pipeline.yaml: ${e instanceof Error ? e.message : e}`)
      }
    }

    const result = await engine.run()

    if (result.status === "completed") {
      console.log("✓ Workflow completed successfully")
    } else if (result.status === "failed") {
      const failedEntry = Object.entries(result.nodeResults)
        .find(([, r]) => r.status === "failed")
      console.error(`✗ Workflow failed at node '${failedEntry?.[0] ?? "unknown"}'`)
      if (failedEntry) {
        const r = failedEntry[1]
        console.error(`  Exit code: ${r.exitCode ?? "N/A"}`)
        if (r.lastOutput) console.error(`  Output: ${r.lastOutput}`)
      }
    } else {
      console.log("⏸ Workflow paused (approval pending)")
    }
  })

workflowCmd
  .command("validate")
  .description("验证工作流 YAML 格式（不执行）")
  .argument("<yaml-path>", "YAML 文件路径")
  .action((yamlPath: string) => {
    const absPath = resolve(yamlPath)
    if (!existsSync(absPath)) {
      console.error(`Error: YAML file not found: ${absPath}`)
      process.exit(1)
    }

    const content = readFileSync(absPath, "utf-8")
    try {
      const wf = parseWorkflow(content)
      validateWorkflow(wf)
      console.log("✓ Workflow YAML is valid")
      console.log(`  Name: ${wf.name}`)
      console.log(`  Nodes: ${wf.nodes.length}`)
    } catch (error: any) {
      console.error(`✗ Validation failed: ${error.message}`)
      process.exit(1)
    }
  })

workflowCmd
  .command("list")
  .description("列出工作流")
  .option("--built-in", "列出系统内置工作流")
  .action(async (options: { builtIn?: boolean }) => {
    if (options.builtIn) {
      const dir = resolveBuiltinWorkflowsDir()
      if (!existsSync(dir)) {
        console.log("系统内置工作流目录不存在:", dir)
        console.log("请先运行: octopus setup --org <org>")
        return
      }

      // Walk nested structure: workflows/{group}/{name}/*.yaml
      const workflows: Array<{ name: string; group: string }> = []
      const groups = readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory())
      for (const groupDir of groups) {
        const groupPath = join(dir, groupDir.name)
        const names = readdirSync(groupPath, { withFileTypes: true })
          .filter(d => d.isDirectory())
        for (const nameDir of names) {
          const wfPath = join(groupPath, nameDir.name)
          const yamlFiles = readdirSync(wfPath).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))
          if (yamlFiles.length > 0) {
            workflows.push({ name: nameDir.name, group: groupDir.name })
          }
        }
      }

      if (workflows.length === 0) {
        console.log("无系统内置工作流")
        return
      }
      console.log("系统内置工作流:")
      for (const wf of workflows) {
        console.log(`  ${wf.group}/${wf.name}`)
      }
    } else {
      console.log("请指定 --built-in 以列出系统内置工作流，或使用 workflow run <yaml-path> 执行本地工作流")
    }
  })

function findCorePackWorkflowsDir(): string | null {
  const candidates = [
    join(__dirname, "core-pack", "workflows"),
    join(__dirname, "..", "..", "core-pack", "workflows"),
    join(__dirname, "..", "..", "node_modules", "@octopus", "core-pack", "workflows"),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}


workflowCmd
  .command("new")
  .description("从模板生成工作流 YAML")
  .option("--template <name>", "模板名称")
  .option("-o, --output <path>", "输出文件路径")
  .option("--param <key=value...>", "模板参数")
  .action(async (options: { template?: string; output?: string; param?: string[] }) => {
    const templatesDir = resolveTemplatesDir()

    if (!options.template) {
      // List available templates
      listTemplates(templatesDir)
      return
    }

    const templateFile = join(templatesDir, `${options.template}.yaml`)
    if (!existsSync(templateFile)) {
      console.error(`Template not found: ${options.template}`)
      console.error(`Available templates:`)
      listTemplates(templatesDir)
      process.exit(1)
    }

    // Parse params
    const params: Record<string, string> = {}
    if (options.param) {
      for (const p of options.param) {
        const eq = p.indexOf("=")
        if (eq > 0) params[p.slice(0, eq)] = p.slice(eq + 1)
      }
    }

    // Check required params from $template_params header
    const content = readFileSync(templateFile, "utf-8")
    const paramsMatch = content.match(/^\$template_params:\s*(.+)$/m)
    if (paramsMatch) {
      const required = paramsMatch[1].split(",").map(s => s.trim())
      const missing = required.filter(r => !params[r])
      if (missing.length > 0) {
        console.error(`Missing required params: ${missing.join(", ")}`)
        console.error(`Usage: octopus workflow new --template ${options.template} ${required.map(r => `--param ${r}=...`).join(" ")}`)
        process.exit(2)
      }
    }

    // Replace template variables {{var}}
    let output = content.replace(/^\$template_params:.*\n/m, "")
    for (const [key, value] of Object.entries(params)) {
      output = output.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value)
    }

    const outputPath = options.output || `./${options.template}.yaml`
    writeFileSync(outputPath, output)
    console.log(`Generated: ${outputPath}`)
  })

function resolveTemplatesDir(): string {
  // Check local core-pack first, then installed location
  const candidates = [
    join(process.cwd(), "packages/core-pack/templates/swarm"),
    join(process.cwd(), "node_modules/@octopus/core-pack/templates/swarm"),
  ]
  for (const dir of candidates) {
    if (existsSync(dir)) return dir
  }
  return candidates[0]  // will show "no templates" message
}

function listTemplates(templatesDir: string): void {
  if (!existsSync(templatesDir)) {
    console.log("No templates found.")
    return
  }
  const files = readdirSync(templatesDir).filter(f => f.endsWith(".yaml"))
  if (files.length === 0) {
    console.log("No templates available.")
    return
  }
  console.log("\nAvailable templates:")
  for (const file of files) {
    const name = file.replace(".yaml", "")
    const content = readFileSync(join(templatesDir, file), "utf-8")
    // Extract description from first comment line
    const desc = content.split("\n").find(l => l.startsWith("# ") && !l.includes("Template:") && !l.includes("$template"))?.replace("# ", "") || ""
    console.log(`  ${name.padEnd(20)} ${desc}`)
  }
}

// ── Simulate Command ──────────────────────────────────────────

workflowCmd
  .command("simulate")
  .description("模拟执行工作流（无 LLM 调用，副作用节点全部 mock）")
  .argument("<yaml-path>", "工作流 YAML 文件路径")
  .option("--test <path>", "测试 fixture 路径（默认自动发现 <name>.test.yaml）")
  .option("--scenario <name>", "运行指定场景（默认运行全部）")
  .option("--strict", "所有副作用节点必须有 mock 定义（默认开启）", true)
  .option("--no-strict", "无 mock 的节点自动通过")
  .option("--verbose", "显示详细执行日志")
  .option("--json", "输出 JSON 格式结果")
  .option("--real <node-ids...>", "指定 bash/python 节点真实执行")
  .action(async (yamlPath: string, options: {
    test?: string
    scenario?: string
    strict?: boolean
    verbose?: boolean
    json?: boolean
    real?: string[]
  }) => {
    const { loadWorkflow, loadTestFixture, discoverTestFixture, runTestSuite } = await import("@octopus/engine")

    const absPath = resolve(yamlPath)
    if (!existsSync(absPath)) {
      console.error(`Error: Workflow file not found: ${absPath}`)
      process.exit(1)
    }

    // Load workflow
    let workflow
    try {
      workflow = loadWorkflow(absPath)
    } catch (err: any) {
      console.error(`Error: Failed to load workflow: ${err.message}`)
      process.exit(1)
    }

    // Discover or load test fixture
    let fixturePath = options.test ? resolve(options.test) : null
    if (!fixturePath) {
      fixturePath = discoverTestFixture(absPath)
      if (!fixturePath) {
        console.error(`Error: No test fixture found.`)
        console.error(`Create a test fixture file: ${absPath.replace(/\.ya?ml$/, ".test.yaml")}`)
        process.exit(1)
      }
    }

    let fixture
    try {
      fixture = loadTestFixture(fixturePath)
    } catch (err: any) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }

    if (!options.json) {
      console.log(`Simulating: ${yamlPath}`)
      console.log(`━`.repeat(50))
      console.log()
    }

    // Run simulation
    const result = await runTestSuite(workflow, fixture, {
      strict: options.strict !== false,
      verbose: options.verbose,
      realExecution: options.real,
      scenarioFilter: options.scenario,
    })

    // Output results
    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      for (const simResult of result.results) {
        const icon = simResult.passed ? "✔" : "✖"
        console.log(`${icon} Scenario "${simResult.scenarioName}" (${simResult.durationMs}ms)`)

        // Show syntax pre-check errors (if any)
        if (simResult.syntaxErrors && simResult.syntaxErrors.length > 0) {
          console.log(`  ⚠ Syntax pre-check: ${simResult.syntaxErrors.length} error(s)`)
          for (const se of simResult.syntaxErrors) {
            const loc = se.line ? ` (line ${se.line})` : ""
            console.log(`    ✖ ${se.nodeType} node "${se.nodeId}"${loc}: ${se.error.split("\n")[0]}`)
          }
        }

        if (options.verbose) {
          for (const entry of simResult.executionTrace) {
            const mode = entry.mocked ? "mocked" : "real"
            const nodeIcon = ["skipped", "skipped_failed"].includes(entry.status) ? "○" :
              entry.status === "failed" ? "✖" : "✔"
            console.log(`  ${nodeIcon} ${entry.nodeId}: ${entry.status} [${mode}]`)
          }
        }

        // Show assertion results
        if (simResult.assertionReport.results.length > 0) {
          const assertIcon = simResult.assertionReport.passed ? "✔" : "✖"
          console.log(`  ${assertIcon} Assertions:`)
          for (const ar of simResult.assertionReport.results) {
            const arIcon = ar.passed ? "✔" : "✖"
            console.log(`    ${arIcon} ${ar.message}`)
          }
        }
        console.log()
      }

      console.log(`━`.repeat(50))
      const totalIcon = result.passed ? "✔" : "✖"
      console.log(`${totalIcon} Results: ${result.passedCount} passed, ${result.failedCount} failed (${result.results.length} scenarios, ${result.totalDurationMs}ms total)`)
    }

    if (!result.passed) {
      process.exit(1)
    }
  })

// ── Test Command (Phase 2 — Direct Run + Agent Delegation) ─────────

function getTestServerUrl(): string {
  return process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001"
}

function testAgentHeaders(org?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "Authorization": process.env.OCTOPUS_AGENT_TOKEN
      ? `Bearer ${process.env.OCTOPUS_AGENT_TOKEN}` : "Bearer agent",
  }
  if (org) headers["X-Octopus-Org"] = org
  return headers
}

// ── Direct Run: run simulator locally without Server ────────────────

async function runDirectTest(workflowPath: string, fixturePath: string, displayPath: string): Promise<void> {
  const { loadWorkflow, loadTestFixture, runTestSuite } = await import("@octopus/engine")

  let workflow
  try {
    workflow = loadWorkflow(workflowPath)
  } catch (err: any) {
    console.error(`Error: Failed to load workflow: ${err.message}`)
    process.exit(1)
  }

  let fixture
  try {
    fixture = loadTestFixture(fixturePath)
  } catch (err: any) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }

  console.log(`Testing: ${displayPath}`)
  console.log(`${"━".repeat(50)}`)
  console.log()

  const result = await runTestSuite(workflow, fixture, { strict: true })
  renderDirectTestResult(result)

  console.log()
  console.log(`${"━".repeat(50)}`)

  if (!result.passed) {
    console.log(chalk.yellow(`\n💡 Run with --fix to auto-fix via AI agent`))
    process.exit(1)
  }
}

function renderDirectTestResult(result: TestRunnerResult): void {
  // Collect all unique node IDs across scenarios for syntax check
  const allNodeIds = new Set<string>()
  const syntaxErrorMap = new Map<string, { error: string; line?: number }>()

  for (const simResult of result.results) {
    for (const entry of simResult.executionTrace) {
      allNodeIds.add(entry.nodeId)
    }
    if (simResult.syntaxErrors) {
      for (const se of simResult.syntaxErrors) {
        syntaxErrorMap.set(se.nodeId, { error: se.error, line: se.line })
      }
    }
  }

  // Phase 1: Syntax Check
  console.log(chalk.bold("📋 Phase 1: Syntax Check"))
  if (syntaxErrorMap.size === 0) {
    for (const nodeId of allNodeIds) {
      console.log(`  ${chalk.green("✔")} ${nodeId}: syntax OK`)
    }
  } else {
    for (const nodeId of allNodeIds) {
      const se = syntaxErrorMap.get(nodeId)
      if (se) {
        const loc = se.line ? ` (line ${se.line})` : ""
        console.log(`  ${chalk.red("✖")} ${nodeId}${loc}: ${se.error.split("\n")[0]}`)
      } else {
        console.log(`  ${chalk.green("✔")} ${nodeId}: syntax OK`)
      }
    }
  }
  console.log()

  // Phase 2: Simulation
  console.log(chalk.bold("⚙️  Phase 2: Simulation"))
  for (const simResult of result.results) {
    const scenarioIcon = simResult.passed ? chalk.green("✔") : chalk.red("✖")
    console.log(`  ${scenarioIcon} Scenario "${simResult.scenarioName}"`)

    for (const entry of simResult.executionTrace) {
      const nodeIcon = ["skipped", "skipped_failed"].includes(entry.status)
        ? chalk.dim("○")
        : entry.status === "failed"
          ? chalk.red("✖")
          : chalk.green("✔")
      const mode = entry.mocked ? "mocked" : "real"
      const duration = entry.durationMs > 0 ? `, ${entry.durationMs}ms` : ""
      console.log(`    ${nodeIcon} ${entry.nodeId}: ${entry.status} [${mode}${duration}]`)
    }
    console.log()
  }

  // Phase 3: Assertions
  console.log(chalk.bold("✅ Phase 3: Assertions"))
  for (const simResult of result.results) {
    if (simResult.assertionReport.results.length > 0) {
      for (const ar of simResult.assertionReport.results) {
        const arIcon = ar.passed ? chalk.green("✔") : chalk.red("✖")
        console.log(`  ${arIcon} ${ar.message || ar.name}`)
      }
    } else {
      console.log(`  ${chalk.dim("○")} No assertions defined`)
    }
  }
  console.log()

  // Summary
  const totalIcon = result.passed ? chalk.green("✔") : chalk.red("✖")
  console.log(`${totalIcon} Results: ${result.passedCount} passed, ${result.failedCount} failed (${result.results.length} scenario${result.results.length !== 1 ? "s" : ""}, ${result.totalDurationMs}ms)`)
}

// ── Agent Path: delegate to Server workspace clone ─────────────────

async function runAgentTest(absPath: string, displayPath: string, options: { org?: string }): Promise<void> {
  const serverUrl = getTestServerUrl()
  const org = options.org || resolveCurrentOrg()

  console.log(`Testing: ${displayPath}`)
  console.log(`${"━".repeat(50)}`)
  console.log()

  try {
    const res = await fetch(`${serverUrl}/api/agent/chat`, {
      method: "POST",
      headers: testAgentHeaders(org),
      body: JSON.stringify({
        message: `使用 octo-workflow-test skill 测试 ${absPath}`,
        delegate_to: "workspace",
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      console.error(chalk.red(`Server error (${res.status}): ${errText}`))
      process.exit(1)
    }

    // Read SSE stream — print text_delta in real-time for progress visibility
    const reader = res.body?.getReader()
    if (!reader) {
      console.error(chalk.red("No response stream"))
      process.exit(1)
    }

    const decoder = new TextDecoder()
    let fullContent = ""
    let buffer = ""
    let lastPrinted = ""
    let currentEvent = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim()
          if (currentEvent === "delegation_start") {
            console.log(chalk.dim("⏳ Workspace clone is analyzing workflow..."))
          }
          continue
        }
        if (line.startsWith("data: ")) {
          try {
            const payload = JSON.parse(line.slice(6))
            if (payload.content) {
              fullContent = payload.content
            } else if (payload.delta) {
              fullContent += payload.delta
            }
            // Show tool calls in real-time
            if (currentEvent === "tool_call" && payload.name) {
              const args = payload.input ? ` ${JSON.stringify(payload.input).slice(0, 80)}` : ""
              console.log(chalk.dim(`\n🔧 ${payload.name}${args}`))
            }
            // Show tool results
            if (currentEvent === "tool_result" && payload.tool_name) {
              const short = (payload.content || "").slice(0, 100).replace(/\n/g, " ")
              console.log(chalk.dim(`  → ${short}`))
            }
            // Stream new text content to stdout in real-time
            if (fullContent.length > lastPrinted.length) {
              const newPart = fullContent.slice(lastPrinted.length)
              process.stdout.write(newPart)
              lastPrinted = fullContent
            }
          } catch { /* skip malformed */ }
          currentEvent = ""
        }
      }
    }

    // Ensure final newline
    if (fullContent && !fullContent.endsWith("\n")) {
      console.log()
    }

    console.log()
    console.log(`${"━".repeat(50)}`)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)

    // Connection refused → server not running
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      console.error(chalk.red("Error: Cannot connect to Octopus server."))
      console.error()
      console.error("The server must be running for 'workflow test' to work.")
      console.error("Start it with:")
      console.error(`  ${chalk.cyan("pnpm dev")}`)
      console.error()
      console.error("Or use Claude Code directly with the octo-workflow-test skill:")
      console.error(`  ${chalk.cyan("使用 octo-workflow-test skill 测试 " + displayPath)}`)
    } else {
      console.error(chalk.red(`Error: ${msg}`))
    }
    process.exit(1)
  }
}

workflowCmd
  .command("test")
  .description("智能测试工作流（有 fixture 直跑模拟器，无 fixture 走 agent）")
  .argument("<yaml-path>", "工作流 YAML 文件路径")
  .option("--org <org>", "组织名")
  .option("--fix", "强制走 agent 路径，智能修复/生成 fixture")
  .action(async (yamlPath: string, options: { org?: string; fix?: boolean }) => {
    const absPath = resolve(yamlPath)
    if (!existsSync(absPath)) {
      console.error(`Error: Workflow file not found: ${absPath}`)
      process.exit(1)
    }

    // Determine execution path
    const { discoverTestFixture } = await import("@octopus/engine")
    const fixturePath = options.fix ? null : discoverTestFixture(absPath)

    if (fixturePath) {
      // Direct run: simulator locally, no Server needed
      await runDirectTest(absPath, fixturePath, yamlPath)
    } else {
      // Agent path: delegate to workspace clone via Server
      await runAgentTest(absPath, yamlPath, options)
    }
  })
