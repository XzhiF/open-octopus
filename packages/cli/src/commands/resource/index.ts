/**
 * resource command group — 注册所有子命令
 *
 * 14 个子命令覆盖资源全生命周期：
 * init, register, install, uninstall, list, search, info,
 * deps, update, outdated, sync, gc, audit, doctor
 */
import { Command } from "commander"
import { initCommand } from "./init"
import { registerCommand } from "./register"
import { installCommand } from "./install"
import { uninstallCommand } from "./uninstall"
import { listCommand } from "./list"
import { searchCommand } from "./search"
import { infoCommand } from "./info"
import { depsCommand } from "./deps"
import { updateCommand, outdatedCommand } from "./update"
import { syncCommand } from "./sync"
import { gcCommand } from "./gc"
import { auditCommand } from "./audit"
import { doctorCommand } from "./doctor"

export function resourceCommand(): Command {
  const cmd = new Command("resource")
    .description("Manage skills, agents, workflows, and sources")

  cmd.addCommand(initCommand())
  cmd.addCommand(registerCommand())
  cmd.addCommand(installCommand())
  cmd.addCommand(uninstallCommand())
  cmd.addCommand(listCommand())
  cmd.addCommand(searchCommand())
  cmd.addCommand(infoCommand())
  cmd.addCommand(depsCommand())
  cmd.addCommand(updateCommand())
  cmd.addCommand(outdatedCommand())
  cmd.addCommand(syncCommand())
  cmd.addCommand(gcCommand())
  cmd.addCommand(auditCommand())
  cmd.addCommand(doctorCommand())

  return cmd
}
