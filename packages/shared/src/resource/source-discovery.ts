import fs from "fs"
import path from "path"
import { z } from "zod"
import type { ResourceType } from "./types"

/**
 * SourceDiscovery — discover resources in a git repository.
 * Two-layer strategy:
 *   Layer 1: octopus-resource.json manifest (explicit)
 *   Layer 2: Convention scan (file patterns)
 */

export interface DiscoveredResource {
  name: string
  type: ResourceType
  /** Relative path from repo root */
  path: string
}

const ManifestResourceSchema = z.object({
  name: z.string(),
  type: z.enum(["skill", "agent", "workflow"]),
  path: z.string(),
})

const ManifestSchema = z.object({
  name: z.string().optional(),
  version: z.union([z.string(), z.number()]).optional(),
  resources: z.array(ManifestResourceSchema).optional(),
  skills: z.array(z.string()).optional(),
  agents: z.array(z.string()).optional(),
  workflows: z.array(z.string()).optional(),
})

/** Meta files to skip during convention scan */
const META_FILES = new Set([
  "README.MD", "README.RST", "README.TXT", "README",
  "CATALOG.MD", "AGENT-LIST.MD", "AGENTS.MD",
  "INDEX.MD", "CHANGELOG.MD", "CHANGES.MD",
  "LICENSE.MD", "LICENSE.TXT", "LICENSE",
  "CONTRIBUTING.MD", "CONTRIBUTORS.MD",
  "UPSTREAM.MD", "PACKAGE.JSON",
])

export class SourceDiscovery {
  /** Discover all resources in a directory */
  discover(dir: string): DiscoveredResource[] {
    // Layer 1: Manifest
    const manifest = this.discoverFromManifest(dir)
    if (manifest.length > 0) return manifest

    // Layer 2: Convention scan
    return this.discoverFromConventions(dir)
  }

  /** Layer 1: Parse octopus-resource.json */
  private discoverFromManifest(dir: string): DiscoveredResource[] {
    const manifestPath = path.join(dir, "octopus-resource.json")
    if (!fs.existsSync(manifestPath)) return []

    try {
      const raw = fs.readFileSync(manifestPath, "utf-8")
      const parsed = ManifestSchema.parse(JSON.parse(raw))
      const resources: DiscoveredResource[] = []

      // Direct resources array
      if (parsed.resources) {
        for (const r of parsed.resources) {
          resources.push({ name: r.name, type: r.type, path: r.path })
        }
      }

      // Typed arrays (skills: ["skills/brainstorming"], agents: ["agents/foo.md"])
      if (parsed.skills) {
        for (const p of parsed.skills) {
          resources.push({ name: path.basename(p), type: "skill", path: p })
        }
      }
      if (parsed.agents) {
        for (const p of parsed.agents) {
          resources.push({ name: path.basename(p).replace(/\.md$/, ""), type: "agent", path: p })
        }
      }
      if (parsed.workflows) {
        for (const p of parsed.workflows) {
          resources.push({ name: path.basename(p).replace(/\.(yaml|yml)$/, ""), type: "workflow", path: p })
        }
      }

      return resources
    } catch {
      return []
    }
  }

  /** Layer 3: Convention-based scanning */
  private discoverFromConventions(dir: string): DiscoveredResource[] {
    const resources: DiscoveredResource[] = []

    this.scanSkills(dir, resources)
    this.scanAgents(dir, resources)
    this.scanWorkflows(dir, resources)

    // Fallback: if no agents found under agents/, scan root-level category dirs
    // (repos like agency-agents-zh put agents in engineering/, design/, etc.)
    if (resources.filter((r) => r.type === "agent").length === 0) {
      this.scanRootCategories(dir, resources)
    }

    // Disambiguate name collisions
    this.disambiguateNames(resources)

    return resources
  }

  private scanSkills(dir: string, resources: DiscoveredResource[]): void {
    const skillsDir = path.join(dir, "skills")
    if (!fs.existsSync(skillsDir)) return

    for (const item of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!item.isDirectory() || item.isSymbolicLink()) continue
      const skillMd = path.join(skillsDir, item.name, "SKILL.md")
      if (fs.existsSync(skillMd)) {
        resources.push({ name: item.name, type: "skill", path: `skills/${item.name}` })
      }
    }
  }

  private scanAgents(dir: string, resources: DiscoveredResource[]): void {
    // Check both "agents" directory (agency-agents-zh uses category subdirs)
    // and direct .md files in root (some repos put agents at top level)
    const agentsDir = path.join(dir, "agents")
    if (!fs.existsSync(agentsDir)) return

    for (const item of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue

      if (item.isDirectory()) {
        // Category directory — scan recursively
        this.scanAgentCategory(agentsDir, item.name, resources, dir)
      } else if (item.name.endsWith(".md") && !this.isMetaFile(item.name)) {
        resources.push({
          name: item.name.replace(/\.md$/, ""),
          type: "agent",
          path: `agents/${item.name}`,
        })
      }
    }
  }

  /** Scan a category directory recursively (handles nested dirs like game-development/engine-unity/) */
  private scanAgentCategory(
    baseDir: string,
    category: string,
    resources: DiscoveredResource[],
    repoRoot?: string,
  ): void {
    const categoryPath = path.join(baseDir, category)
    if (!fs.existsSync(categoryPath)) return

    const root = repoRoot ?? path.dirname(baseDir)
    const entries = fs.readdirSync(categoryPath, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        // Nested subdirectory — recurse
        this.scanAgentCategory(categoryPath, entry.name, resources, root)
      } else if (entry.name.endsWith(".md") && !this.isMetaFile(entry.name)) {
        const fullPath = path.join(categoryPath, entry.name)
        const relativeFromRepo = path.relative(root, fullPath).replace(/\\/g, "/")

        resources.push({
          name: entry.name.replace(/\.md$/, ""),
          type: "agent",
          path: relativeFromRepo,
        })
      }
    }
  }

  /** Check if a directory tree contains any .md agent files (recursive) */
  private hasAgentFiles(dirPath: string): boolean {
    if (!fs.existsSync(dirPath)) return false
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isFile() && entry.name.endsWith(".md") && !this.isMetaFile(entry.name)) {
        return true
      }
      if (entry.isDirectory() && this.hasAgentFiles(path.join(dirPath, entry.name))) {
        return true
      }
    }
    return false
  }

  /**
   * Fallback: scan root-level category directories for .md agent files.
   * Handles repos like agency-agents-zh where agents are in engineering/, design/, etc.
   * at the repo root (not under an agents/ subdirectory).
   */
  private scanRootCategories(dir: string, resources: DiscoveredResource[]): void {
    // Directories to skip at root level (not agent categories)
    const skipDirs = new Set([
      "skills", "agents", "workflows", "examples", "integrations",
      "scripts", "assets", "strategy", "node_modules", ".git",
      "test", "tests", "__tests__", "docs",
    ])

    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!item.isDirectory() || item.isSymbolicLink()) continue
      if (skipDirs.has(item.name) || item.name.startsWith(".") || item.name.startsWith("_")) continue

      // Check if this directory tree contains .md files (agent definitions)
      const categoryPath = path.join(dir, item.name)
      if (this.hasAgentFiles(categoryPath)) {
        // Treat as agent category — scan recursively
        this.scanAgentCategory(dir, item.name, resources, dir)
      }
    }
  }

  private scanWorkflows(dir: string, resources: DiscoveredResource[]): void {
    const workflowsDir = path.join(dir, "workflows")
    if (!fs.existsSync(workflowsDir)) return

    for (const file of fs.readdirSync(workflowsDir)) {
      if (file.endsWith(".yaml") || file.endsWith(".yml")) {
        resources.push({
          name: file.replace(/\.(yaml|yml)$/, ""),
          type: "workflow",
          path: `workflows/${file}`,
        })
      }
    }
  }

  private isMetaFile(name: string): boolean {
    return META_FILES.has(name.toUpperCase())
  }

  /** Disambiguate name collisions by appending parent directory name */
  private disambiguateNames(resources: DiscoveredResource[]): void {
    const nameCounts = new Map<string, number>()
    for (const r of resources) {
      nameCounts.set(r.name, (nameCounts.get(r.name) ?? 0) + 1)
    }

    for (const r of resources) {
      if ((nameCounts.get(r.name) ?? 0) > 1) {
        const parts = r.path.split("/")
        if (parts.length >= 2) {
          // e.g. engineering/architect.md → architect-engineering
          // e.g. agents/engineering/architect.md → architect-engineering
          r.name = `${r.name}-${parts[parts.length - 2]}`
        }
      }
    }
  }
}
