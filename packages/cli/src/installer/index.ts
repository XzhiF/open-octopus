import {
  copyFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from "fs"
import { join, basename } from "path"
import { VERSION } from "@octopus/shared"
import {
  resolveGlobalDir,
  resolveOrgDir,
  getOrgPrefix,
} from "@octopus/shared"

export const CORE_SKILLS = [
  "octo-skill-creator",
  "octo-skill-evolution",
  "octo-guide",
  "octo-dev-copilot",
]

export const CORE_AGENTS = [
  "mcp-discoverer",
  "skill-searcher",
  "skill-evaluator",
  "repo-knowledge",
  "env-discoverer",
]

const EXCLUDE_NAMES = new Set(["__pycache__", "node_modules"])

export class Installer {
  private targetDir: string
  private org: string
  private force: boolean
  private corePackPath: string

  constructor(targetDir: string, org: string, force = false) {
    this.targetDir = targetDir
    this.org = org
    this.force = force

    this.corePackPath = this.findCorePackPath() || ""
  }

  run(): void {
    if (!this.corePackPath) {
      throw new Error("core_pack directory not found")
    }
    this.checkTarget()
    this.initGlobalDir()
    this.installSkills()
    this.installAgents()
    this.registerMcp()
    this.installScripts()
    this.createManifest()
    this.createConfig()
  }

  private checkTarget(): void {
    mkdirSync(this.targetDir, { recursive: true })
    const octopusDir = join(this.targetDir, ".octopus")
    if (existsSync(octopusDir) && !this.force) {
      throw new Error(
        `.octopus/ exists at ${octopusDir}. Use --force to overwrite.`,
      )
    }
  }

  private initGlobalDir(): void {
    if (!this.org) {
      throw new Error("org required for init. Use: octopus init --org <org>")
    }

    const globalDir = resolveGlobalDir()
    const orgDir = resolveOrgDir(this.org)

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
      mkdirSync(join(orgDir, subdir), { recursive: true })
    }

    const globalConfigPath = join(globalDir, "global_config.yaml")
    if (!existsSync(globalConfigPath)) {
      mkdirSync(globalDir, { recursive: true })
      writeFileSync(
        globalConfigPath,
        `default_org: ${this.org}\n`,
        "utf-8",
      )
    }

    const prefPath = join(globalDir, "user_preference.md")
    if (!existsSync(prefPath)) {
      const tplPath = join(this.corePackPath, "config", "user_preference.md.tpl")
      if (existsSync(tplPath)) {
        copyFileSync(tplPath, prefPath)
      }
    }
  }

  private installSkills(): void {
    const skillsDir = join(this.targetDir, ".claude", "skills")
    mkdirSync(skillsDir, { recursive: true })

    const sourceSkillsDir = join(this.corePackPath, "skills")
    if (!existsSync(sourceSkillsDir)) return

    for (const skillName of CORE_SKILLS) {
      const src = join(sourceSkillsDir, skillName)
      if (!existsSync(src) || !statSync(src).isDirectory()) continue

      const dst = join(skillsDir, skillName)
      if (this.force && existsSync(dst)) {
        rmSync(dst, { recursive: true, force: true })
      }
      // Merge: copy only files that don't exist in dest (user edits preserved)
      this.mergeDirRecursive(src, dst)
    }
  }

  private installAgents(): void {
    const agentsDir = join(this.targetDir, ".claude", "agents")
    mkdirSync(agentsDir, { recursive: true })

    const sourceAgentsDir = join(this.corePackPath, "agents")
    if (!existsSync(sourceAgentsDir)) return

    const tplFiles = readdirSync(sourceAgentsDir).filter(
      (f) => f.endsWith(".md.tpl"),
    )

    if (tplFiles.length > 0) {
      const prefix = getOrgPrefix(this.org, this.targetDir)
      const orgDir = resolveOrgDir(this.org)

      for (const tpl of tplFiles) {
        const agentName = basename(tpl, ".tpl")
        const dst = join(agentsDir, agentName)

        if (existsSync(dst) && !this.force) continue

        let content = readFileSync(join(sourceAgentsDir, tpl), "utf-8")
        if (this.org) {
          content = content.replace(/\{org\}/g, this.org)
          content = content.replace(/\{prefix\}/g, prefix)
          content = content.replace(/\{org_dir\}/g, orgDir)
        }
        writeFileSync(dst, content, "utf-8")
      }
    } else {
      const mdFiles = readdirSync(sourceAgentsDir).filter(
        (f) => f.endsWith(".md"),
      )
      for (const mdFile of mdFiles) {
        const dst = join(agentsDir, mdFile)
        if (existsSync(dst) && !this.force) continue
        copyFileSync(join(sourceAgentsDir, mdFile), dst)
      }
    }
  }

  private registerMcp(): void {
    const orgDir = resolveOrgDir(this.org)
    const mcpDir = join(orgDir, "mcp")
    mkdirSync(mcpDir, { recursive: true })

    const presetsDir = join(this.corePackPath, "presets")
    if (!existsSync(presetsDir)) return

    let presetMcpDir = join(presetsDir, "orgs", this.org, "mcp")
    if (!existsSync(presetMcpDir)) {
      presetMcpDir = join(presetsDir, "orgs", "standard", "mcp")
    }

    if (!existsSync(presetMcpDir)) return

    const yamlFiles = readdirSync(presetMcpDir).filter((f) =>
      f.endsWith(".yaml"),
    )
    for (const yamlFile of yamlFiles) {
      const dst = join(mcpDir, yamlFile)
      if (existsSync(dst) && !this.force) continue
      copyFileSync(join(presetMcpDir, yamlFile), dst)
    }
  }

  private installScripts(): void {
    const scriptsDir = join(this.targetDir, ".octopus", "scripts")
    mkdirSync(scriptsDir, { recursive: true })

    const sourceScriptsDir = join(this.corePackPath, "scripts")
    if (!existsSync(sourceScriptsDir)) return

    const entries = readdirSync(sourceScriptsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || EXCLUDE_NAMES.has(entry.name)) continue

      const dst = join(scriptsDir, entry.name)
      if (existsSync(dst)) {
        if (this.force) {
          rmSync(dst, { recursive: true, force: true })
        } else {
          continue
        }
      }
      this.copyDirRecursive(join(sourceScriptsDir, entry.name), dst)
    }
  }

  private createManifest(): void {
    const octopusDir = join(this.targetDir, ".octopus")
    mkdirSync(octopusDir, { recursive: true })

    const manifest: Record<string, unknown> = {
      version: VERSION,
      installed_at: new Date().toISOString(),
      skills: {},
      agents: {},
    }

    const skillsDir = join(this.targetDir, ".claude", "skills")
    for (const skillName of CORE_SKILLS) {
      const skillDir = join(skillsDir, skillName)
      if (existsSync(skillDir)) {
        manifest.skills = {
          ...(manifest.skills as Record<string, unknown>),
          [skillName]: { source: "core_pack", version: VERSION },
        }
      }
    }

    const agentsDir = join(this.targetDir, ".claude", "agents")
    for (const agentName of CORE_AGENTS) {
      const agentFile = join(agentsDir, `${agentName}.md`)
      if (existsSync(agentFile)) {
        manifest.agents = {
          ...(manifest.agents as Record<string, unknown>),
          [agentName]: {},
        }
      }
    }

    writeFileSync(
      join(octopusDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    )
  }

  private createConfig(): void {
    const configPath = join(this.targetDir, ".octopus", "config.yaml")
    if (existsSync(configPath) && !this.force) return

    const tplPath = join(
      this.corePackPath,
      "config",
      "project_config.yaml.tpl",
    )
    mkdirSync(join(this.targetDir, ".octopus"), { recursive: true })

    if (existsSync(tplPath)) {
      let content = readFileSync(tplPath, "utf-8")
      if (this.org) {
        content = content.replace(/\{org\}/g, this.org)
      }
      const commentedFields = this.generateCommentedGlobalFields()
      content = content.replace(/\{commented_global_fields\}/g, commentedFields)
      writeFileSync(configPath, content, "utf-8")
    } else {
      writeFileSync(
        configPath,
        `# .octopus/config.yaml — project config\norg: ${this.org || "xzf"}\nskill_dir: .claude/skills\nshared_scripts: .octopus/scripts\n`,
        "utf-8",
      )
    }
  }

  private generateCommentedGlobalFields(): string {
    if (!this.org) return ""

    const orgConfigPath = join(
      resolveOrgDir(this.org),
      "config",
      "org_config.yaml",
    )
    if (!existsSync(orgConfigPath)) return ""

    try {
      const content = readFileSync(orgConfigPath, "utf-8")
      const lines: string[] = []
      const fieldOrder = ["name", "prefix", "description", "platform"]
      for (const field of fieldOrder) {
        const match = content.match(
          new RegExp(`^${field}:\\s*(.+)$`, "m"),
        )
        if (match) lines.push(`# ${field}: ${match[1]}`)
      }
      return lines.join("\n")
    } catch {
      return ""
    }
  }

  private copyDirRecursive(src: string, dst: string): void {
    mkdirSync(dst, { recursive: true })
    const entries = readdirSync(src, { withFileTypes: true })
    for (const entry of entries) {
      if (EXCLUDE_NAMES.has(entry.name)) continue
      const srcPath = join(src, entry.name)
      const dstPath = join(dst, entry.name)
      if (entry.isDirectory()) {
        this.copyDirRecursive(srcPath, dstPath)
      } else {
        copyFileSync(srcPath, dstPath)
      }
    }
  }

  /** Merge src into dst — only copy files that don't exist in dst (preserve user edits) */
  private mergeDirRecursive(src: string, dst: string): void {
    mkdirSync(dst, { recursive: true })
    const entries = readdirSync(src, { withFileTypes: true })
    for (const entry of entries) {
      if (EXCLUDE_NAMES.has(entry.name)) continue
      const srcPath = join(src, entry.name)
      const dstPath = join(dst, entry.name)
      if (entry.isDirectory()) {
        this.mergeDirRecursive(srcPath, dstPath)
      } else {
        // Only copy if dest file doesn't exist (user's local edits preserved)
        if (!existsSync(dstPath)) {
          copyFileSync(srcPath, dstPath)
        }
      }
    }
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
}