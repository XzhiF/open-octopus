import { existsSync, mkdirSync, mkdtempSync, rmSync, cpSync } from "fs"
import path from "path"
import os from "os"
import type { ResourceType, SourceRef, RegistryEntry } from "@octopus/shared"
import { RepoError, computeContentHash, shortHash, DEFAULT_TARGETS } from "@octopus/shared"
import { SourceProviderRegistry } from "./providers"
import { RegistryStore } from "./registry"

export class RepositoryManager {
  private repoDir: string
  private registry: RegistryStore
  private providers: SourceProviderRegistry

  constructor(repoDir?: string) {
    this.repoDir = repoDir ?? path.join(os.homedir(), ".octopus", "repository")
    this.registry = new RegistryStore(this.repoDir)
    this.providers = new SourceProviderRegistry()
  }

  getRepoDir(): string {
    return this.repoDir
  }

  getRegistry(): RegistryStore {
    return this.registry
  }

  initRepo(force = false): void {
    if (existsSync(path.join(this.repoDir, "registry.json")) && !force) {
      throw new RepoError(
        "Already initialized",
        "ALREADY_INITIALIZED",
        "Use --force to reinitialize",
        1
      )
    }
    mkdirSync(path.join(this.repoDir, "manifests"), { recursive: true })
    mkdirSync(path.join(this.repoDir, "cache"), { recursive: true })
    // Ensure registry.json exists with empty entries
    this.registry.getEntries() // triggers load + creation
  }

  async register(
    ref: SourceRef,
    type: ResourceType,
    opts?: { name?: string; tags?: string[]; force?: boolean }
  ): Promise<RegistryEntry> {
    const provider = this.providers.get(ref)
    const validation = await provider.validate(ref)
    if (!validation.valid) {
      throw new RepoError(
        `Invalid source: ${validation.reason}`,
        "MANIFEST_PARSE_ERROR",
        "Check the source reference format",
        2
      )
    }

    const tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-fetch-"))
    try {
      const result = await provider.fetch(ref, tempDir)
      const hash = shortHash(computeContentHash(result.path))
      const name = opts?.name ?? this.inferName(result.path, ref)

      // Check for duplicates
      const existing = this.registry.lookup(name, type)
      if (existing && !opts?.force) {
        throw new RepoError(
          `Already registered: ${name} [${type}]`,
          "LOCK_CONFLICT",
          "Use --force to re-register",
          1
        )
      }

      // Copy to cache
      const cacheDir = path.join(this.repoDir, "cache", type, `${name}@${hash}`)
      mkdirSync(path.dirname(cacheDir), { recursive: true })
      if (existsSync(cacheDir)) {
        rmSync(cacheDir, { recursive: true, force: true })
      }
      cpSync(result.path, cacheDir, { recursive: true })

      const entry: RegistryEntry = {
        name,
        type,
        version: result.version,
        source: ref,
        hash,
        description: "",
        tags: opts?.tags ?? [],
        dependencies: [],
        size: result.size,
        manifest_path: `manifests/${type}/${name}.yaml`,
        cache_path: `cache/${type}/${name}@${hash}/`,
        registered_at: new Date().toISOString(),
      }

      this.registry.add(entry)
      return entry
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }

  unregister(name: string, type: ResourceType): boolean {
    return this.registry.remove(name, type)
  }

  lookup(name: string, type?: ResourceType) {
    return this.registry.lookup(name, type)
  }

  list(type?: ResourceType) {
    return this.registry.list(type)
  }

  private inferName(fetchPath: string, ref: SourceRef): string {
    if (ref.protocol === "builtin") return ref.id
    if (ref.protocol === "npm") return ref.package.replace(/^@[^/]+\//, "")
    if (ref.protocol === "github") return ref.repo.split("/").pop() ?? "unknown"
    return path.basename(fetchPath)
  }
}
