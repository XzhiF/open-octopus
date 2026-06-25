import { Command } from "commander"
import chalk from "chalk"
import { readFile } from "fs/promises"
import yaml from "js-yaml"
import { resolveMcpDir, resolveCurrentOrg } from "../utils/path"

export const mcpCliCmd = new Command("mcp-cli")
  .description("调用 MCP server tool (YAML 注册表直连)")
  .argument("<server>", "MCP server 名称")
  .argument("<tool>", "Tool 名称")
  .argument("[params]", "JSON 参数字符串", "{}")
  .option("--env <env>", "MCP 环境名", "prod")
  .option("--org <org>", "组织名")
  .action(async (serverName: string, toolName: string, paramsStr: string, opts) => {
    const org = opts.org ?? resolveCurrentOrg()
    const mcpDir = resolveMcpDir(org)
    const mcpFile = `${mcpDir}/mcp_${opts.env}.yaml`

    try {
      const content = await readFile(mcpFile, "utf-8")
      const registry = yaml.load(content, { schema: yaml.JSON_SCHEMA }) as any

      const serverConfig = registry?.servers?.[serverName]
      if (!serverConfig) {
        console.log(chalk.red(`MCP server "${serverName}" not found in ${mcpFile}`))
        console.log(chalk.dim("Available servers:"), Object.keys(registry?.servers ?? {}).join(", ") || "none")
        process.exit(1)
      }

      const params = JSON.parse(paramsStr)
      console.log(chalk.blue(`Calling ${serverName}.${toolName}`))
      console.log(chalk.dim("Server:"), serverConfig.url ?? serverConfig.baseUrl)
      console.log(chalk.dim("Params:"), JSON.stringify(params))
      console.log(chalk.dim("Org:"), org)

      const toolConfig = serverConfig?.tools?.[toolName]
      if (toolConfig) {
        console.log(chalk.dim("Tool:"), toolConfig.description ?? toolName)
      }

      console.log(chalk.yellow("MCP CLI 调用方案已生成，实际 HTTP 调用待 Server 包实现"))

    } catch (err: any) {
      if (err.code === "ENOENT") {
        console.log(chalk.red(`MCP registry not found: ${mcpFile}`))
        console.log(chalk.dim("Run octopus setup --org <org> first"))
      } else if (err instanceof SyntaxError) {
        console.log(chalk.red(`Invalid JSON params: ${paramsStr}`))
      } else {
        console.log(chalk.red(err.message))
      }
      process.exit(1)
    }
  })