/**
 * LockManager — 读写 resources.lock 文件，并对比 config.json 声明检测漂移
 *
 * 从 commands/repo.ts `sync` 子命令中提取的独立模块。
 */
import { join } from "path"
import { existsSync, readFileSync } from "fs"
import type { ResourceType } from "@octopus/shared"

export interface LockEntry {
  name: string
  type: ResourceType
  [key: string]: unknown
}

export interface LockFile {
  version?: number
  resources?: LockEntry[]
}

export interface WorkspaceConfig {
  resources?: {
    skills?: string[]
    agents?: string[]
    workflows?: string[]
    sources?: string[]
  }
  [key: string]: unknown
}

export interface DriftItem {
  name: string
  type: ResourceType
  reason: string
}

export interface DriftReport {
  add: DriftItem[]
  remove: DriftItem[]
  update: DriftItem[]
  unchanged: number
}

/**
 * 读取 resources.lock 文件，不存在时返回空结构
 */
export function readLockFile(workspaceDir: string): LockFile {
  const lockPath = join(workspaceDir, ".octopus", "resources.lock")
  if (!existsSync(lockPath)) return { resources: [] }
  return JSON.parse(readFileSync(lockPath, "utf-8")) as LockFile
}

/**
 * 读取 config.json 文件
 */
export function readWorkspaceConfig(workspaceDir: string): WorkspaceConfig {
  const configPath = join(workspaceDir, "config.json")
  if (!existsSync(configPath)) {
    throw new Error("CONFIG_NOT_FOUND")
  }
  return JSON.parse(readFileSync(configPath, "utf-8")) as WorkspaceConfig
}

/**
 * 对比 config.json 声明与 resources.lock 已安装项，计算漂移
 */
export function computeDrift(config: WorkspaceConfig, installed: LockEntry[]): DriftReport {
  const declared = config.resources ?? { skills: [], agents: [], workflows: [], sources: [] }

  const add: DriftItem[] = []
  const remove: DriftItem[] = []

  // 声明但未安装 → add
  const typePlural = {
    skill: "skills" as const,
    agent: "agents" as const,
    workflow: "workflows" as const,
    source: "sources" as const,
  }

  for (const [type, plural] of Object.entries(typePlural) as Array<[ResourceType, keyof typeof declared]>) {
    const list = declared[plural] ?? []
    for (const name of list) {
      if (!installed.find((i) => i.name === name && i.type === type)) {
        add.push({ name, type, reason: "declared but not installed" })
      }
    }
  }

  // 已安装但未声明 → remove (drift)
  for (const inst of installed) {
    const plural = typePlural[inst.type]
    const list = declared[plural] ?? []
    if (!list.includes(inst.name)) {
      remove.push({ name: inst.name, type: inst.type, reason: "installed but not declared" })
    }
  }

  return {
    add,
    remove,
    update: [],
    unchanged: installed.length - remove.length,
  }
}
