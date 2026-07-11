import { Command } from "commander"
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, statSync, rmSync, chmodSync } from "fs"
import { resolve, join } from "path"
import { parseWorkflow, validateWorkflow, resolveOrgDir, PipelineConfigSchema, PipelineConfigV1Schema } from "@octopus/shared"
import { WorkflowEngine, registerBuiltinProviders } from "@octopus/engine"
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