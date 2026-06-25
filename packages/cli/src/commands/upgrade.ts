import { Command } from "commander"
import { VERSION } from "@octopus/shared"
import { SetupRunner } from "../setup-runner"
import { Installer } from "../installer"
import { resolveCurrentOrg } from "../utils/path"
import { resolveGlobalDir } from "@octopus/shared"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

export const upgradeCmd = new Command("upgrade")
  .description("升级（检查版本并触发 setup）")
  .option("--org <org>", "组织名")
  .action(async (options: { org?: string }) => {
    const org = options.org || resolveCurrentOrg()
    const cwd = process.cwd()

    if (!existsSync(join(cwd, ".octopus"))) {
      console.error("Workspace not initialized. Run: octopus init <dir>")
      process.exit(1)
    }

    const installer = new Installer(cwd, org, true)
    installer.run()
    console.log("✓ Workspace upgrade complete")

    const versionPath = join(resolveGlobalDir(), ".version")
    const currentVersion = existsSync(versionPath)
      ? readFileSync(versionPath, "utf-8").trim()
      : ""

    if (currentVersion === VERSION) {
      console.log("Version unchanged, skip setup")
    } else {
      const runner = new SetupRunner(org, false, false)
      await runner.run()
    }

    console.log(`✓ Upgraded to v${VERSION}`)
  })