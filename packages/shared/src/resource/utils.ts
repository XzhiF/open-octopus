import path from "path"
import crypto from "crypto"
import fs from "fs"
import type { SourceRef } from "./types"

export function isPathWithinBase(targetPath: string, basePath: string): boolean {
  const resolved = path.resolve(targetPath)
  const base = path.resolve(basePath)
  return resolved.startsWith(base + path.sep) || resolved === base
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatSourceRef(ref: SourceRef): string {
  switch (ref.type) {
    case "builtin": return `builtin:${ref.name}`
    case "local": return `local:${ref.path}`
    default: { const _exhaustive: never = ref; throw new Error(`Unknown source type: ${_exhaustive}`) }
  }
}

// ponytail: directory hash for multi-file skills
export function computeContentHash(dirPath: string): string {
  const hash = crypto.createHash("sha256")
  const files = fs.readdirSync(dirPath, { recursive: true }).sort() as string[]
  for (const file of files) {
    const full = path.join(dirPath, String(file))
    if (fs.statSync(full).isFile()) {
      hash.update(String(file))
      hash.update(fs.readFileSync(full))
    }
  }
  return hash.digest("hex")
}

export function parseRef(ref: string): { type: "builtin" | "local"; resourceType?: string; value: string } {
  const match = ref.match(/^(builtin|local):(.+)$/)
  if (!match) {
    throw new Error(`Invalid ref format: '${ref}'. Expected 'builtin:<name>' or 'local:<path>'`)
  }
  const rawValue = match[2]
  // Value may include a resource type prefix: "skill/octo-workflow-dev" → extract both
  const typeMatch = rawValue.match(/^(skill|agent|workflow)\/(.+)$/)
  if (typeMatch) {
    return { type: match[1] as "builtin" | "local", resourceType: typeMatch[1] as "skill" | "agent" | "workflow", value: typeMatch[2] }
  }
  return { type: match[1] as "builtin" | "local", value: rawValue }
}
