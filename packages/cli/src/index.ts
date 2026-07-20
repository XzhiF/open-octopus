import { Command } from "commander"
import { VERSION } from "@octopus/shared"
import { versionCmd } from "./commands/version"
import { initCmd } from "./commands/init"
import { setupCmd } from "./commands/setup"
import { upgradeCmd } from "./commands/upgrade"
import { reposCmd } from "./commands/repos"
import { workflowCmd } from "./commands/workflow"
import { skillSearchCmd } from "./commands/skill-search"
import { mcpCliCmd } from "./commands/mcp-cli"
import { workspaceCmd } from "./commands/workspace-cmd"
import { notifyCmd } from "./commands/notify"
import { agentCmd } from "./commands/agent"
import { agentsCmd } from "./commands/agents"
import { resourceCmd } from "./commands/resource"
import { schedulerCmd } from "./commands/scheduler"
import { workflowOptimizeCmd } from "./commands/workflow-optimize"
import { workflowRetireCmd } from "./commands/workflow-retire"
import { frontierCmd } from "./commands/frontier"
import { swarmCmd } from "./commands/swarm"
import { evolutionCmd } from "./commands/evolution"

export function createProgram(): Command {
  const program = new Command()
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
    .addCommand(workflowCmd)
    .addCommand(skillSearchCmd)
    .addCommand(mcpCliCmd)
    .addCommand(workspaceCmd)
    .addCommand(notifyCmd)
    .addCommand(agentCmd)
    .addCommand(agentsCmd)
    .addCommand(resourceCmd)
    .addCommand(schedulerCmd)
    .addCommand(frontierCmd)
    .addCommand(swarmCmd)
    .addCommand(evolutionCmd)

  // Register workflow sub-commands for optimization and retirement
  // Guard against duplicate registration (Commander singletons persist across test reruns)
  if (!workflowCmd.commands.find(c => c.name() === "optimize")) {
    workflowCmd.addCommand(workflowOptimizeCmd)
  }
  if (!workflowCmd.commands.find(c => c.name() === "retire")) {
    workflowCmd.addCommand(workflowRetireCmd)
  }

  return program
}

export { versionCmd, initCmd, setupCmd, upgradeCmd, reposCmd, workflowCmd, mcpCliCmd, skillSearchCmd, workspaceCmd, agentCmd, agentsCmd, resourceCmd, schedulerCmd, workflowOptimizeCmd, workflowRetireCmd }

const shouldRun = !process.env.VITEST && !process.env.NODE_TEST
if (shouldRun) {
  const program = createProgram()
  program.parse()
}