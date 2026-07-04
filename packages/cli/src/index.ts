import { Command } from "commander"
import { VERSION } from "@octopus/shared"
import { versionCmd } from "./commands/version"
import { initCmd } from "./commands/init"
import { setupCmd } from "./commands/setup"
import { upgradeCmd } from "./commands/upgrade"
import { reposCmd } from "./commands/repos"
import { repoCmd } from "./commands/repo"
import { workflowCmd } from "./commands/workflow"
import { skillSearchCmd } from "./commands/skill-search"
import { mcpCliCmd } from "./commands/mcp-cli"
import { workspaceCmd } from "./commands/workspace-cmd"
import { notifyCmd } from "./commands/notify"
import { agentCmd } from "./commands/agent"
import { agentsCmd } from "./commands/agents"
import { resourcesCmd } from "./commands/resources"

export function createProgram(): Command {
  return new Command()
    .name("octopus")
    .description("Octopus - 企业级 Skill + Workflow 工具集")
    .version(VERSION)
    .option("--server <url>", "Server 地址 (默认: http://localhost:3001)")
    .hook("preAction", (thisCommand) => {
      const serverUrl = thisCommand.opts().server
      if (serverUrl) process.env.OCTOPUS_SERVER_URL = serverUrl
    })
    .addCommand(versionCmd)
    .addCommand(initCmd)
    .addCommand(setupCmd)
    .addCommand(upgradeCmd)
    .addCommand(reposCmd)
    .addCommand(repoCmd)
    .addCommand(workflowCmd)
    .addCommand(skillSearchCmd)
    .addCommand(mcpCliCmd)
    .addCommand(workspaceCmd)
    .addCommand(notifyCmd)
    .addCommand(agentCmd)
    .addCommand(agentsCmd)
    .addCommand(resourcesCmd)
}

export { versionCmd, initCmd, setupCmd, upgradeCmd, reposCmd, repoCmd, workflowCmd, mcpCliCmd, skillSearchCmd, workspaceCmd, agentCmd, agentsCmd, resourcesCmd }

const shouldRun = !process.env.VITEST && !process.env.NODE_TEST
if (shouldRun) {
  const program = createProgram()
  program.parse()
}