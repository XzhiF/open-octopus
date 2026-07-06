import fs from "fs"
import path from "path"
import type { SourceProvider } from "./types"
import type { ResourceManifest, ResourceType } from "../types"
import { isPathWithinBase } from "../utils"
import { ResourceError } from "../errors"

const RESOURCE_DIRS: Record<ResourceType, string> = {
  skill: "skills",
  agent: "agents",
  workflow: "workflows",
}

const RESOURCE_EXTENSIONS: Record<ResourceType, string> = {
  skill: "",      // directory with SKILL.md
  agent: ".md",
  workflow: ".yaml",
}

// B5: reject names that could traverse directories
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export class BuiltinProvider implements SourceProvider {
  readonly type = "builtin" as const
  private readonly corePackPath: string

  constructor(corePackPath: string) {
    this.corePackPath = corePackPath
  }

  async resolve(ref: string, resourceType: ResourceType): Promise<ResourceManifest> {
    // B5 fix: validate ref doesn't contain path separators or traversal sequences
    if (!SAFE_NAME_RE.test(ref)) {
      throw new ResourceError("INVALID_REF", `Invalid builtin resource name: '${ref}'`)
    }

    const baseDir = path.join(this.corePackPath, RESOURCE_DIRS[resourceType])

    switch (resourceType) {
      case "skill": {
        const skillMd = path.join(baseDir, ref, "SKILL.md")
        if (!fs.existsSync(skillMd)) {
          throw new Error(`Builtin skill not found: ${ref} (expected ${skillMd})`)
        }
        return {
          name: ref,
          type: "skill",
          version: "0.0.0",
          source: { type: "builtin", name: ref },
          dependencies: [],
          tags: [],
        }
      }

      case "agent": {
        const agentFile = path.join(baseDir, `${ref}.md`)
        if (!fs.existsSync(agentFile)) {
          throw new Error(`Builtin agent not found: ${ref} (expected ${agentFile})`)
        }
        return {
          name: ref,
          type: "agent",
          version: "0.0.0",
          source: { type: "builtin", name: ref },
          dependencies: [],
          tags: [],
        }
      }

      case "workflow": {
        const workflowFile = path.join(baseDir, `${ref}.yaml`)
        if (!fs.existsSync(workflowFile)) {
          throw new Error(`Builtin workflow not found: ${ref} (expected ${workflowFile})`)
        }
        return {
          name: ref,
          type: "workflow",
          version: "0.0.0",
          source: { type: "builtin", name: ref },
          dependencies: [],
          tags: [],
        }
      }

      default: {
        const _exhaustive: never = resourceType
        throw new Error(`Unknown resource type: ${_exhaustive}`)
      }
    }
  }

  async fetch(manifest: ResourceManifest, targetDir: string): Promise<void> {
    if (manifest.source.type !== "builtin") {
      throw new Error(`BuiltinProvider cannot fetch non-builtin source: ${manifest.source.type}`)
    }

    const dirName = RESOURCE_DIRS[manifest.type]
    const ext = RESOURCE_EXTENSIONS[manifest.type]

    let sourcePath: string
    if (manifest.type === "skill") {
      // Skills are directories: {corePackPath}/skills/{name}/
      sourcePath = path.join(this.corePackPath, dirName, manifest.source.name)
    } else {
      // Agents and workflows are single files: {corePackPath}/{dir}/{name}{ext}
      sourcePath = path.join(this.corePackPath, dirName, `${manifest.source.name}${ext}`)
    }

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source path does not exist: ${sourcePath}`)
    }

    // B5 fix: verify resolved path is within corePackPath
    if (!isPathWithinBase(sourcePath, this.corePackPath)) {
      throw new ResourceError("PATH_TRAVERSAL", `Builtin source path escapes core-pack directory: ${sourcePath}`)
    }

    const stat = fs.statSync(sourcePath)
    if (stat.isDirectory()) {
      fs.cpSync(sourcePath, targetDir, { recursive: true })
    } else {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true })
      fs.copyFileSync(sourcePath, targetDir)
    }
  }

  async list(resourceType?: ResourceType): Promise<ResourceManifest[]> {
    const manifests: ResourceManifest[] = []
    const types: ResourceType[] = resourceType
      ? [resourceType]
      : ["skill", "agent", "workflow"]

    for (const type of types) {
      const dir = path.join(this.corePackPath, RESOURCE_DIRS[type])
      if (!fs.existsSync(dir)) continue

      const entries = fs.readdirSync(dir)

      for (const entry of entries) {
        const entryPath = path.join(dir, entry)
        const stat = fs.statSync(entryPath)

        switch (type) {
          case "skill": {
            // Skills are directories containing SKILL.md
            if (stat.isDirectory()) {
              const skillMd = path.join(entryPath, "SKILL.md")
              if (fs.existsSync(skillMd)) {
                manifests.push({
                  name: entry,
                  type: "skill",
                  version: "0.0.0",
                  source: { type: "builtin", name: entry },
                  dependencies: [],
                  tags: [],
                })
              }
            }
            break
          }

          case "agent": {
            // Agents are .md files
            if (stat.isFile() && entry.endsWith(".md")) {
              const name = entry.replace(/\.md$/, "")
              manifests.push({
                name,
                type: "agent",
                version: "0.0.0",
                source: { type: "builtin", name },
                dependencies: [],
                tags: [],
              })
            }
            break
          }

          case "workflow": {
            // Workflows are .yaml files
            if (stat.isFile() && entry.endsWith(".yaml")) {
              const name = entry.replace(/\.yaml$/, "")
              manifests.push({
                name,
                type: "workflow",
                version: "0.0.0",
                source: { type: "builtin", name },
                dependencies: [],
                tags: [],
              })
            }
            break
          }
        }
      }
    }

    return manifests
  }
}
