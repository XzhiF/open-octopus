import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  statSync,
} from "fs"
import { join } from "path"
import inquirer from "inquirer"
import {
  VERSION,
  resolveGlobalDir,
  resolveOrgDir,
  loadGlobalConfig,
  loadOrgConfig,
  parseManifest,
  buildProjectInfos,
  generateIndex,
  ResourceManager,
} from "@octopus/shared"

const DEFAULT_IGNORE_PATTERNS = [
  "repos/index.md",
  "repos/projects**",
]

export interface SetupReport {
  newFiles: string[]
  mergedFiles: string[]
  skippedFiles: string[]
  conflicts: ConflictEntry[]
}

export interface ConflictEntry {
  file: string
  section: string
  key: string
  userValue: string
  templateValue: string
}

export class SetupRunner {
  private org: string
  private force: boolean
  private dryRun: boolean
  private orgDir: string
  private globalDir: string
  private corePackPath: string | null
  private presetsPath: string | null
  private ignorePatterns: string[]
  private report: SetupReport

  constructor(org: string, force = false, dryRun = false) {
    this.org = org
    this.force = force
    this.dryRun = dryRun
    this.globalDir = resolveGlobalDir()
    this.orgDir = org ? resolveOrgDir(org) : ""
    this.corePackPath = this.findCorePackPath()
    this.presetsPath = this.findPresetsPath()
    this.ignorePatterns = this.loadIgnorePatterns()
    this.report = {
      newFiles: [],
      mergedFiles: [],
      skippedFiles: [],
      conflicts: [],
    }
  }

  needInteractiveSetup(): boolean {
    if (this.org) return false
    if (!existsSync(join(this.globalDir, "config.yaml"))) return true
    const globalConfig = loadGlobalConfig(join(this.globalDir, "config.yaml"))
    return !globalConfig.default_org
  }

  getReport(): SetupReport {
    return this.report
  }

  async run(): Promise<void> {
    this.resolveOrg()
    if (this.needInteractiveSetup()) {
      await this.interactiveOrgSetup()
      this.orgDir = resolveOrgDir(this.org)
    }

    this.checkGlobalDir()
    this.ensureOrgDirs()
    this.handleGlobalConfig()
    this.handleOrgConfig()
    this.handleOrgMcpRegistry()
    this.handleOrgEnvFiles()
    this.handleOrgManifest()
    this.handleOrgManifestGuide()
    this.handleOrgIndex()
    this.handleUserPreference()
    this.handleIgnoreList()
    this.handleModelsYaml()
    this.writeVersion()
    this.syncWorkspaceSkills()
    await this.installCorePackResources()
    this.printReport()
  }

  private resolveOrg(): void {
    if (this.org) return
    const configPath = join(this.globalDir, "config.yaml")
    if (existsSync(configPath)) {
      const cfg = loadGlobalConfig(configPath)
      this.org = cfg.default_org || ""
    }
    if (this.org) {
      this.orgDir = resolveOrgDir(this.org)
    }
  }

  private async interactiveOrgSetup(): Promise<void> {
    console.log("First-time setup — enter org info")

    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "orgName",
        message: "Org name (e.g. xzf, opensource):",
        validate: (v: string) => v.trim() ? true : "Required",
      },
      {
        type: "input",
        name: "orgPrefix",
        message: "Org prefix (e.g. xzf-):",
        default: (ans: any) => `${ans.orgName}-`,
      },
      {
        type: "input",
        name: "orgDisplayName",
        message: "Org display name (人可读名称):",
        default: (ans: any) => ans.orgName,
      },
      {
        type: "input",
        name: "orgDescription",
        message: "Org description:",
        default: (ans: any) => `${ans.orgName} projects`,
      },
    ])

    this.org = answers.orgName.trim()
    this.orgDir = resolveOrgDir(this.org)

    if (!this.dryRun) {
      mkdirSync(this.globalDir, { recursive: true })
      writeFileSync(
        join(this.globalDir, "config.yaml"),
        `default_org: ${this.org}\n`,
        "utf-8",
      )
      console.log(`  Created config.yaml (default_org: ${this.org})`)
    }

    this.createOrgConfig(
      answers.orgName.trim(),
      answers.orgPrefix.trim(),
      answers.orgDescription.trim(),
      answers.orgDisplayName.trim(),
    )

    console.log(`Org ${this.org} created`)
  }

  private createOrgConfig(
    orgName: string,
    orgPrefix: string,
    orgDescription: string,
    orgDisplayName: string,
  ): void {
    const configPath = join(this.orgDir, "config.yaml")
    const rel = `${orgName}/config.yaml`

    if (existsSync(configPath)) return

    let content: string | null = null

    if (this.presetsPath) {
      const orgTpl = join(this.presetsPath, "orgs", orgName, "config.yaml.tpl")
      if (existsSync(orgTpl)) {
        content = readFileSync(orgTpl, "utf-8").replace(/\{org\}/g, orgName)
      } else {
        const stdTpl = join(this.presetsPath, "orgs", "standard", "config.yaml.tpl")
        if (existsSync(stdTpl)) {
          content = readFileSync(stdTpl, "utf-8")
          content = content.replace(/\{org\}/g, orgName)
          content = content.replace(/\{prefix\}/g, orgPrefix)
          content = content.replace(/\{description\}/g, orgDescription)
        }
      }
    }

    if (this.dryRun) {
      console.log(`  (dry-run) Will create ${rel}`)
      this.report.newFiles.push(rel)
      return
    }

    mkdirSync(this.orgDir, { recursive: true })

    if (content) {
      writeFileSync(configPath, content, "utf-8")
      this.report.newFiles.push(rel)
      console.log(`  Created ${rel} from preset/template`)
    } else {
      const displayName = orgDisplayName || orgName
      writeFileSync(
        configPath,
        `name: ${displayName}\nprefix: ${orgPrefix}\ndescription: ${orgDescription}\nplatform: gitlab\ngroups:\n  - ${orgName}\nclone_base: ~/.octopus/orgs/${orgName}/repos/projects\n`,
        "utf-8",
      )
      this.report.newFiles.push(rel)
      console.log(`  Created ${rel}`)
    }
  }

  private checkGlobalDir(): void {
    if (!existsSync(this.globalDir)) {
      if (this.dryRun) {
        console.log("  (dry-run) Will create ~/.octopus/")
        return
      }
      mkdirSync(this.globalDir, { recursive: true })
      console.log("  Created ~/.octopus/")
    } else {
      console.log("  ~/.octopus/ already exists")
    }
  }

  private ensureOrgDirs(): void {
    if (!this.org || !this.orgDir) return

    const orgSubdirs = [
      "env",
      "mcp",
      "repos",
      "repos/projects",
      "evolution",
      "evolution/experiences",
      "config",
    ]

    for (const subdir of orgSubdirs) {
      const path = join(this.orgDir, subdir)
      if (!existsSync(path)) {
        if (this.dryRun) {
          console.log(`  (dry-run) Will create ${this.org}/${subdir}/`)
          continue
        }
        mkdirSync(path, { recursive: true })
        console.log(`  Created ${this.org}/${subdir}/`)
      }
    }
  }

  private handleGlobalConfig(): void {
    const configPath = join(this.globalDir, "config.yaml")
    const rel = "config.yaml"

    if (existsSync(configPath)) {
      console.log(`  ${rel} exists, not overwriting`)
      this.report.skippedFiles.push(rel)
      return
    }

    if (this.dryRun) {
      console.log("  (dry-run) Will create config.yaml")
      this.report.newFiles.push(rel)
      return
    }

    const tplPath = this.corePackPath
      ? join(this.corePackPath, "config", "global_config.yaml.tpl")
      : null

    if (tplPath && existsSync(tplPath)) {
      let content = readFileSync(tplPath, "utf-8")
      if (this.org) {
        content = content.replace("{default_org}", this.org)
      }
      writeFileSync(configPath, content, "utf-8")
      this.report.newFiles.push(rel)
      console.log(`  Created ${rel}`)
    } else {
      writeFileSync(
        configPath,
        `default_org: ${this.org || "xzf"}\n`,
        "utf-8",
      )
      this.report.newFiles.push(rel)
      console.log(`  Created ${rel}`)
    }
  }

  private handleOrgConfig(): void {
    if (!this.org || !this.orgDir) return

    const configPath = join(this.orgDir, "config.yaml")
    const rel = `${this.org}/config.yaml`

    if (existsSync(configPath)) {
      console.log(`  ${rel} exists, not overwriting`)
      this.report.skippedFiles.push(rel)
      return
    }

    let content: string | null = null

    if (this.presetsPath) {
      const orgTpl = join(this.presetsPath, "orgs", this.org, "config.yaml.tpl")
      if (existsSync(orgTpl)) {
        content = readFileSync(orgTpl, "utf-8").replace(/\{org\}/g, this.org)
      } else {
        const stdTpl = join(this.presetsPath, "orgs", "standard", "config.yaml.tpl")
        if (existsSync(stdTpl)) {
          content = readFileSync(stdTpl, "utf-8").replace(/\{org\}/g, this.org)
        }
      }
    }

    if (this.dryRun) {
      console.log(`  (dry-run) Will create ${rel}`)
      this.report.newFiles.push(rel)
      return
    }

    mkdirSync(this.orgDir, { recursive: true })

    if (content) {
      writeFileSync(configPath, content, "utf-8")
      this.report.newFiles.push(rel)
      console.log(`  Created ${rel}`)
    } else {
      const prefix = `${this.org}-`
      writeFileSync(
        configPath,
        `name: ${this.org}\nprefix: ${prefix}\ndescription: ${this.org} projects\nplatform: gitlab\ngroups:\n  - ${this.org}\nclone_base: ~/.octopus/orgs/${this.org}/repos/projects\n`,
        "utf-8",
      )
      this.report.newFiles.push(rel)
      console.log(`  Created ${rel}`)
    }
  }

  private handleOrgMcpRegistry(): void {
    if (!this.org || !this.orgDir) return

    const mcpDir = join(this.orgDir, "mcp")
    mkdirSync(mcpDir, { recursive: true })

    let presetMcpDir: string | null = null

    if (this.presetsPath) {
      const orgMcp = join(this.presetsPath, "orgs", this.org, "mcp")
      if (existsSync(orgMcp)) {
        presetMcpDir = orgMcp
      } else {
        const stdMcp = join(this.presetsPath, "orgs", "standard", "mcp")
        if (existsSync(stdMcp)) {
          presetMcpDir = stdMcp
        }
      }
    }

    if (!presetMcpDir || !existsSync(presetMcpDir)) {
      console.log("  No MCP preset found, skipping")
      return
    }

    const yamlFiles = readdirSync(presetMcpDir).filter(
      (f) => f.endsWith(".yaml"),
    )

    for (const yamlFile of yamlFiles) {
      const rel = `${this.org}/mcp/${yamlFile}`
      const target = join(mcpDir, yamlFile)

      if (this.shouldIgnore(rel)) {
        console.log(`  Skip ${rel} (in ignore list)`)
        this.report.skippedFiles.push(rel)
        continue
      }

      if (existsSync(target)) {
        console.log(`  ${rel} exists, not overwriting`)
        this.report.skippedFiles.push(rel)
        continue
      }

      if (this.dryRun) {
        console.log(`  (dry-run) Will create ${rel}`)
        this.report.newFiles.push(rel)
        continue
      }

      copyFileSync(join(presetMcpDir, yamlFile), target)
      this.report.newFiles.push(rel)
      console.log(`  Created ${rel}`)
    }
  }

  private handleOrgEnvFiles(): void {
    if (!this.org || !this.orgDir) return

    const envDir = join(this.orgDir, "env")
    mkdirSync(envDir, { recursive: true })

    let presetEnvDir: string | null = null

    if (this.presetsPath) {
      const orgEnv = join(this.presetsPath, "orgs", this.org, "env")
      if (existsSync(orgEnv)) {
        presetEnvDir = orgEnv
      } else {
        const stdEnv = join(this.presetsPath, "orgs", "standard", "env")
        if (existsSync(stdEnv)) {
          presetEnvDir = stdEnv
        }
      }
    }

    if (!presetEnvDir || !existsSync(presetEnvDir)) {
      console.log("  No env preset found, skipping")
      return
    }

    const mdFiles = readdirSync(presetEnvDir).filter((f) => f.endsWith(".md"))

    for (const mdFile of mdFiles) {
      const rel = `${this.org}/env/${mdFile}`
      const target = join(envDir, mdFile)

      if (this.shouldIgnore(rel)) {
        if (!existsSync(target)) {
          if (!this.dryRun) {
            copyFileSync(join(presetEnvDir, mdFile), target)
            this.report.newFiles.push(rel)
            console.log(`  Created ${rel} (ignore: create if absent)`)
          }
        } else {
          console.log(`  Skip ${rel} (in ignore list)`)
          this.report.skippedFiles.push(rel)
        }
        continue
      }

      if (!existsSync(target)) {
        if (this.dryRun) {
          console.log(`  (dry-run) Will create ${rel}`)
          this.report.newFiles.push(rel)
          continue
        }
        copyFileSync(join(presetEnvDir, mdFile), target)
        this.report.newFiles.push(rel)
        console.log(`  Created ${rel}`)
        continue
      }

      const { sections: userSections, headerLines: userHeaderLines } = this.parseEnvMd(target)
      const { sections: templateSections } = this.parseEnvMd(join(presetEnvDir, mdFile))
      const { merged, conflicts } = this.mergeEnvSections(
        userSections,
        templateSections,
      )

      for (const c of conflicts) {
        this.report.conflicts.push({
          file: rel,
          section: c.section,
          key: c.key,
          userValue: c.userValue,
          templateValue: c.templateValue,
        })
      }

      if (this.dryRun) {
        this.report.mergedFiles.push(rel)
        console.log(
          `  (dry-run) Will merge ${rel} (${conflicts.length} conflicts)`,
        )
        continue
      }

      const header = userHeaderLines.join("\n")
      this.writeEnvMd(target, merged, header)
      this.report.mergedFiles.push(rel)
      console.log(`  Merged ${rel} (${conflicts.length} conflicts)`)
    }
  }

  private handleOrgManifest(): void {
    if (!this.org || !this.orgDir) return

    const manifestPath = join(this.orgDir, "repos", "manifest.md")
    const rel = `${this.org}/repos/manifest.md`

    let tpl: string | null = null

    if (this.presetsPath) {
      const orgTpl = join(this.presetsPath, "orgs", this.org, "manifest.md.tpl")
      if (existsSync(orgTpl)) {
        tpl = orgTpl
      } else {
        const stdTpl = join(this.presetsPath, "orgs", "standard", "manifest.md.tpl")
        if (existsSync(stdTpl)) {
          tpl = stdTpl
        }
      }
    }

    if (!tpl) {
      console.log("  No manifest template found, skipping")
      return
    }

    if (!existsSync(manifestPath)) {
      if (this.dryRun) {
        console.log(`  (dry-run) Will create ${rel}`)
        this.report.newFiles.push(rel)
        return
      }

      let content = readFileSync(tpl, "utf-8").replace(/\{org\}/g, this.org)
      mkdirSync(join(this.orgDir, "repos"), { recursive: true })
      writeFileSync(manifestPath, content, "utf-8")
      this.report.newFiles.push(rel)
      console.log(`  Created ${rel}`)
      return
    }

    const tplContent = readFileSync(tpl, "utf-8").replace(/\{org\}/g, this.org)
    const { entries: userEntries, headerLines: userHeaderLines } = this.parseManifestMd(manifestPath)
    const { entries: templateEntries } = this.parseManifestMdFromString(tplContent)
    const { merged, conflicts } = this.mergeManifestEntries(
      userEntries,
      templateEntries,
    )

    for (const c of conflicts) {
      this.report.conflicts.push({
        file: rel,
        section: c.group,
        key: c.name,
        userValue: c.userBranch,
        templateValue: c.templateBranch,
      })
    }

    if (this.dryRun) {
      this.report.mergedFiles.push(rel)
      console.log(
        `  (dry-run) Will merge ${rel} (${conflicts.length} conflicts)`,
      )
      return
    }

    this.writeManifestMd(manifestPath, merged, userHeaderLines)
    this.report.mergedFiles.push(rel)
    console.log(`  Merged ${rel} (${conflicts.length} conflicts)`)
  }

  private handleOrgManifestGuide(): void {
    if (!this.org || !this.orgDir) return

    const guidePath = join(this.orgDir, "repos", "manifest-guide.md")
    const rel = `${this.org}/repos/manifest-guide.md`

    if (existsSync(guidePath)) {
      console.log(`  ${rel} exists, not overwriting`)
      this.report.skippedFiles.push(rel)
      return
    }

    let guideSrc: string | null = null

    if (this.presetsPath) {
      const orgGuide = join(this.presetsPath, "orgs", this.org, "manifest-guide.md")
      if (existsSync(orgGuide)) {
        guideSrc = orgGuide
      } else {
        const stdGuide = join(this.presetsPath, "orgs", "standard", "manifest-guide.md")
        if (existsSync(stdGuide)) {
          guideSrc = stdGuide
        }
      }
    }

    if (!guideSrc) return

    if (this.dryRun) {
      console.log(`  (dry-run) Will create ${rel}`)
      this.report.newFiles.push(rel)
      return
    }

    let content = readFileSync(guideSrc, "utf-8").replace(/\{org\}/g, this.org)
    writeFileSync(guidePath, content, "utf-8")
    this.report.newFiles.push(rel)
    console.log(`  Created ${rel}`)
  }

  private handleOrgIndex(): void {
    if (!this.org || !this.orgDir) return

    const indexPath = join(this.orgDir, "repos", "index.md")
    const rel = `${this.org}/repos/index.md`

    if (existsSync(indexPath)) {
      console.log(`  Skip ${rel} (exists)`)
      this.report.skippedFiles.push(rel)
      return
    }

    const manifestPath = join(this.orgDir, "repos", "manifest.md")
    if (!existsSync(manifestPath)) {
      console.log("  manifest.md not found, cannot generate index")
      return
    }

    if (this.dryRun) {
      console.log(`  (dry-run) Will generate ${rel}`)
      this.report.newFiles.push(rel)
      return
    }

    const orgConfig = loadOrgConfig(this.org)
    const cloneBase = orgConfig.clone_base || join(this.orgDir, "repos", "projects")
    const manifestContent = readFileSync(manifestPath, "utf-8")
    const manifestEntries = parseManifest(manifestContent)

    const projectInfos = buildProjectInfos(
      manifestEntries,
      cloneBase,
      undefined,
      false,
    )

    const content = generateIndex(projectInfos)
    mkdirSync(join(this.orgDir, "repos"), { recursive: true })
    writeFileSync(indexPath, content, "utf-8")
    this.report.newFiles.push(rel)
    console.log(`  Generated ${rel}`)
  }

  private handleUserPreference(): void {
    const prefPath = join(this.globalDir, "user_preference.md")
    const rel = "user_preference.md"

    if (existsSync(prefPath)) {
      console.log(`  ${rel} exists, not overwriting`)
      this.report.skippedFiles.push(rel)
      return
    }

    const tplPath = this.corePackPath
      ? join(this.corePackPath, "config", "user_preference.md.tpl")
      : null

    if (tplPath && existsSync(tplPath)) {
      if (this.dryRun) {
        console.log("  (dry-run) Will create user_preference.md")
        return
      }
      copyFileSync(tplPath, prefPath)
      console.log("  Created user_preference.md")
      this.report.newFiles.push(rel)
    }
  }

  private handleIgnoreList(): void {
    const ignorePath = join(this.globalDir, "setup_ignore.yaml")
    const rel = "setup_ignore.yaml"

    if (existsSync(ignorePath)) {
      console.log(`  ${rel} exists, not overwriting`)
      this.report.skippedFiles.push(rel)
      return
    }

    const tplPath = this.corePackPath
      ? join(this.corePackPath, "config", "setup_ignore.yaml.tpl")
      : null

    if (tplPath && existsSync(tplPath)) {
      if (this.dryRun) {
        console.log("  (dry-run) Will create setup_ignore.yaml")
        return
      }
      let content = readFileSync(tplPath, "utf-8")
      if (this.org) {
        content = content.replace(/\{org\}/g, this.org)
      }
      writeFileSync(ignorePath, content, "utf-8")
      this.report.newFiles.push(rel)
      console.log("  Created setup_ignore.yaml")
    }
  }

  private handleModelsYaml(): void {
    const modelsPath = join(this.globalDir, "models.yaml")
    const rel = "models.yaml"

    if (existsSync(modelsPath)) {
      console.log(`  ${rel} exists, not overwriting`)
      this.report.skippedFiles.push(rel)
      return
    }

    const tplPath = this.corePackPath
      ? join(this.corePackPath, "config", "models.yaml.tpl")
      : null

    if (tplPath && existsSync(tplPath)) {
      if (this.dryRun) {
        console.log("  (dry-run) Will create models.yaml")
        this.report.newFiles.push(rel)
        return
      }
      copyFileSync(tplPath, modelsPath)
      this.report.newFiles.push(rel)
      console.log("  Created models.yaml")
    }
  }

  private writeVersion(): void {
    const versionPath = join(this.globalDir, ".version")
    if (this.dryRun) {
      console.log(`  (dry-run) Will write .version = ${VERSION}`)
      return
    }
    writeFileSync(versionPath, VERSION, "utf-8")
    console.log(`  .version = ${VERSION}`)
  }

  private printReport(): void {
    console.log("\nSetup report")

    if (this.report.newFiles.length > 0) {
      console.log("New:")
      for (const f of this.report.newFiles) {
        console.log(`  + ${f}`)
      }
    }

    if (this.report.mergedFiles.length > 0) {
      console.log("Merged:")
      for (const f of this.report.mergedFiles) {
        console.log(`  ~ ${f}`)
      }
    }

    if (this.report.skippedFiles.length > 0) {
      console.log("Skipped:")
      for (const f of this.report.skippedFiles) {
        console.log(`  o ${f}`)
      }
    }

    if (this.report.conflicts.length > 0) {
      console.log("Conflicts (user values kept):")
      for (const c of this.report.conflicts) {
        console.log(
          `  ${c.file} -> ${c.section}.${c.key}: user="${c.userValue}" vs template="${c.templateValue}"`,
        )
      }
    }

    console.log(`\nSetup complete (v${VERSION})`)
  }

  private shouldIgnore(relPath: string): boolean {
    for (const pattern of this.ignorePatterns) {
      if (this.matchPattern(relPath, pattern)) {
        return true
      }
    }
    return false
  }

  private matchPattern(str: string, pattern: string): boolean {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")
    return new RegExp(`^${regexStr}$`).test(str)
  }

  private loadIgnorePatterns(): string[] {
    const ignorePath = join(this.globalDir, "setup_ignore.yaml")
    if (existsSync(ignorePath)) {
      return this.parseYamlList(ignorePath)
    }

    if (this.corePackPath) {
      const tplPath = join(this.corePackPath, "config", "setup_ignore.yaml.tpl")
      if (existsSync(tplPath)) {
        return this.parseYamlList(tplPath)
      }
    }

    return [...DEFAULT_IGNORE_PATTERNS]
  }

  private parseYamlList(filePath: string): string[] {
    const lines = readFileSync(filePath, "utf-8").split("\n")
    const patterns: string[] = []
    for (const line of lines) {
      const stripped = line.trim()
      if (stripped.startsWith("- ")) {
        patterns.push(stripped.substring(2).trim())
      }
    }
    return patterns
  }

  parseEnvMd(filePath: string): { sections: Record<string, Record<string, string>>; headerLines: string[] } {
    const sections: Record<string, Record<string, string>> = {}
    let currentSection: string | null = null
    const headerLines: string[] = []

    const content = readFileSync(filePath, "utf-8")
    for (const line of content.split("\n")) {
      const stripped = line.trim()
      if (stripped.startsWith("## ")) {
        currentSection = stripped.substring(3).trim()
        sections[currentSection] = {}
        continue
      }
      if (stripped.startsWith("- ") && currentSection !== null) {
        const keyVal = stripped.substring(2).split(":")
        const key = keyVal[0].trim()
        const value = keyVal.length > 1 ? keyVal.slice(1).join(":").trim() : ""
        if (currentSection) {
          sections[currentSection][key] = value
        }
        continue
      }
      if (currentSection === null) {
        headerLines.push(line)
        continue
      }
    }

    return { sections, headerLines }
  }

  mergeEnvSections(
    user: Record<string, Record<string, string>>,
    template: Record<string, Record<string, string>>,
  ): { merged: Record<string, Record<string, string>>; conflicts: EnvConflict[] } {
    const merged: Record<string, Record<string, string>> = {}
    const conflicts: EnvConflict[] = []

    for (const section of Object.keys(user)) {
      if (!(section in template)) {
        merged[section] = { ...user[section] }
        continue
      }

      const mergedKeys: Record<string, string> = { ...user[section] }

      for (const [key, templateValue] of Object.entries(template[section])) {
        if (!(key in mergedKeys)) {
          mergedKeys[key] = templateValue
        } else if (mergedKeys[key] !== templateValue) {
          conflicts.push({
            section,
            key,
            userValue: mergedKeys[key],
            templateValue,
          })
        }
      }

      merged[section] = mergedKeys
    }

    for (const section of Object.keys(template)) {
      if (!(section in merged)) {
        merged[section] = { ...template[section] }
      }
    }

    return { merged, conflicts }
  }

  writeEnvMd(
    filePath: string,
    sections: Record<string, Record<string, string>>,
    header?: string,
  ): void {
    const lines: string[] = []

    if (header) {
      lines.push(header)
      lines.push("")
    }

    for (const [section, keys] of Object.entries(sections)) {
      lines.push(`## ${section}`)
      for (const [key, value] of Object.entries(keys)) {
        lines.push(`- ${key}: ${value}`)
      }
      lines.push("")
    }

    writeFileSync(filePath, lines.join("\n"), "utf-8")
  }

  parseManifestMd(filePath: string): { entries: ManifestEntries; headerLines: string[] } {
    const content = readFileSync(filePath, "utf-8")
    return this.parseManifestMdFromString(content)
  }

  parseManifestMdFromString(content: string): { entries: ManifestEntries; headerLines: string[] } {
    const entries: ManifestEntries = {}
    let currentGroup = ""
    const headerLines: string[] = []

    for (const line of content.split("\n")) {
      const stripped = line.trim()

      if (stripped.startsWith("## ")) {
        const headerContent = stripped.substring(3).trim()
        if (headerContent.includes("(")) {
          currentGroup = headerContent.split("(")[0].trim()
        } else {
          currentGroup = headerContent
        }
        if (!(currentGroup in entries)) {
          entries[currentGroup] = []
        }
        continue
      }

      if (!currentGroup) {
        headerLines.push(line)
        continue
      }

      if (!stripped || stripped.startsWith("#") || stripped.startsWith(">")) {
        continue
      }

      if (!stripped.startsWith("-")) {
        continue
      }

      const entryContent = stripped.substring(1).trim()
      const entry = this.parseManifestLine(entryContent)
      if (entry.name) {
        if (!(currentGroup in entries)) {
          entries[currentGroup] = []
        }
        entries[currentGroup].push(entry)
      }
    }

    return { entries, headerLines }
  }

  private parseManifestLine(content: string): ManifestLine {
    let manualTags: string[] = []
    if (content.includes("{") && content.includes("}")) {
      const tagStart = content.indexOf("{")
      const tagEnd = content.indexOf("}")
      const tagStr = content.substring(tagStart + 1, tagEnd)
      manualTags = tagStr
        .replace("/", ",")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t)
      content =
        content.substring(0, tagStart).trim() +
        content.substring(tagEnd + 1).trim()
    }

    let branch = "master"
    if (content.includes("[") && content.includes("]")) {
      const brStart = content.indexOf("[")
      const brEnd = content.indexOf("]")
      branch = content.substring(brStart + 1, brEnd).trim()
      content =
        content.substring(0, brStart).trim() +
        content.substring(brEnd + 1).trim()
    }

    let gitUrl = ""
    const urlMatch = content.match(/(https?:\/\/\S+|git@\S+)/)
    if (urlMatch) {
      gitUrl = urlMatch[1]
      content =
        content.substring(0, urlMatch.index!) +
        content.substring(urlMatch.index! + urlMatch[0].length)
      content = content.trim()
    }

    return { name: content.trim(), gitUrl, branch, manualTags }
  }

  mergeManifestEntries(
    user: ManifestEntries,
    template: ManifestEntries,
  ): { merged: ManifestEntries; conflicts: ManifestConflict[] } {
    const merged: ManifestEntries = {}
    const conflicts: ManifestConflict[] = []

    for (const [group, userEntries] of Object.entries(user)) {
      const userNames = new Set(userEntries.map((e) => e.name))
      const mergedEntries: ManifestLine[] = [...userEntries]

      if (group in template) {
        for (const tplEntry of template[group]) {
          if (!userNames.has(tplEntry.name)) {
            mergedEntries.push(tplEntry)
          } else {
            const userEntry = userEntries.find((e) => e.name === tplEntry.name)!
            if (userEntry.branch !== tplEntry.branch) {
              conflicts.push({
                group,
                name: tplEntry.name,
                userBranch: userEntry.branch,
                templateBranch: tplEntry.branch,
              })
            }
          }
        }
      }

      merged[group] = mergedEntries
    }

    for (const [group, tplEntries] of Object.entries(template)) {
      if (!(group in merged)) {
        merged[group] = [...tplEntries]
      }
    }

    return { merged, conflicts }
  }

  writeManifestMd(filePath: string, entries: ManifestEntries, headerLines?: string[]): void {
    const defaultHeader = [
      "# Project Manifest",
      "",
      "> 人工维护的项目清单。格式: `- 项目名 git_url [分支] {标签}`",
      "> 分支默认 master，GitHub 项目通常填 [main]；标签可选，逗号分隔",
      "",
    ]
    const lines: string[] = headerLines ? [...headerLines] : [...defaultHeader]

    for (const [group, groupEntries] of Object.entries(entries)) {
      lines.push(`## ${group}`)
      lines.push("")
      for (const entry of groupEntries) {
        const parts: string[] = [entry.name]
        if (entry.gitUrl) parts.push(entry.gitUrl)
        if (entry.branch !== "master") parts.push(`[${entry.branch}]`)
        if (entry.manualTags.length > 0)
          parts.push(`{${entry.manualTags.join(", ")}}`)
        lines.push(`- ${parts.join(" ")}`)
      }
      lines.push("")
    }

    writeFileSync(filePath, lines.join("\n"), "utf-8")
  }

  private findCorePackPath(): string | null {
    const candidates = [
      join(__dirname, "core-pack"),
      join(__dirname, "..", "..", "core-pack"),
      join(__dirname, "..", "..", "node_modules", "@octopus", "core-pack"),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  /** Incrementally sync core skills into all org workspaces */
  private syncWorkspaceSkills(): void {
    if (!this.corePackPath) return
    const sourceSkillsDir = join(this.corePackPath, "skills")
    if (!existsSync(sourceSkillsDir)) return

    const wsRoot = join(this.orgDir, "workspaces")
    if (!existsSync(wsRoot)) return

    // Only sync workspace-specific skills (not all core-pack skills)
    const workspaceSkills = ["octo-dev-copilot", "octo-workflow-dev", "octo-swarm-dev", "octo-browser-debug", "octo-browser-vision", "octo-e2e-tester"]

    for (const wsName of readdirSync(wsRoot)) {
      const wsDir = join(wsRoot, wsName)
      if (!statSync(wsDir).isDirectory()) continue
      const skillsDir = join(wsDir, ".claude", "skills")
      mkdirSync(skillsDir, { recursive: true })

      for (const skillName of workspaceSkills) {
        const src = join(sourceSkillsDir, skillName)
        if (!existsSync(src)) continue
        const dst = join(skillsDir, skillName)
        mkdirSync(dst, { recursive: true })

        // Merge: only copy files that don't exist in dest
        for (const f of readdirSync(src)) {
          if (f === "node_modules" || f === "__pycache__") continue
          const srcPath = join(src, f)
          const dstPath = join(dst, f)
          if (statSync(srcPath).isDirectory()) {
            mkdirSync(dstPath, { recursive: true })
            for (const sf of readdirSync(srcPath)) {
              if (sf === "node_modules" || sf === "__pycache__") continue
              const ssPath = join(srcPath, sf)
              const sdPath = join(dstPath, sf)
              if (statSync(ssPath).isDirectory()) continue
              if (!existsSync(sdPath)) {
                copyFileSync(ssPath, sdPath)
              }
            }
          } else {
            if (!existsSync(dstPath)) {
              copyFileSync(srcPath, dstPath)
            }
          }
        }
      }
    }
  }

  /**
   * Install core-pack resources (skills, agents, workflows) to ~/.octopus/resources/installed/
   * Uses ResourceManager.installOrUpgrade() to ensure latest versions.
   */
  private async installCorePackResources(): Promise<void> {
    if (!this.corePackPath) {
      console.log("  core-pack not found, skipping resource installation")
      return
    }

    if (this.dryRun) {
      console.log("  (dry-run) Will install core-pack resources to ~/.octopus/resources/installed/")
      return
    }

    const manager = new ResourceManager({
      corePackBase: this.corePackPath,
    })

    const builtinResources = manager.listBuiltin()
    let installed = 0
    let upgraded = 0

    for (const resource of builtinResources) {
      try {
        const result = await manager.installOrUpgrade({
          ref: `builtin:${resource.name}`,
          type: resource.type,
          caller: "cli",
        })
        if (result.status === "installed" || result.status === "installed_but_unverified") {
          // Check if this was an upgrade or fresh install by looking at the timestamp
          const isUpgrade = result.installedAt && new Date(result.installedAt).getTime() < Date.now() - 1000
          if (isUpgrade) {
            upgraded++
          } else {
            installed++
          }
        }
      } catch (err: any) {
        console.log(`  Warning: Failed to install ${resource.type}/${resource.name}: ${err.message}`)
      }
    }

    console.log(`  Installed ${installed} new, upgraded ${upgraded} core-pack resources`)

    // Copy workflow-schema.json to ~/.octopus/workflow-schema.json
    const schemaSrc = join(this.corePackPath, "workflows", "workflow-schema.json")
    if (existsSync(schemaSrc)) {
      const schemaDst = join(this.globalDir, "workflow-schema.json")
      copyFileSync(schemaSrc, schemaDst)
    }
  }

  private findPresetsPath(): string | null {
    if (this.corePackPath) {
      const presetsDir = join(this.corePackPath, "presets")
      if (existsSync(presetsDir)) return presetsDir
    }
    return null
  }
}

interface EnvConflict {
  section: string
  key: string
  userValue: string
  templateValue: string
}

interface ManifestLine {
  name: string
  gitUrl: string
  branch: string
  manualTags: string[]
}

interface ManifestEntries {
  [group: string]: ManifestLine[]
}

interface ManifestConflict {
  group: string
  name: string
  userBranch: string
  templateBranch: string
}