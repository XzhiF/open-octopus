import { Command } from "commander"
import { VERSION } from "@octopus/shared"

export const versionCmd = new Command("version")
  .description("显示版本信息")
  .action(() => {
    console.log(`octopus v${VERSION}`)
  })