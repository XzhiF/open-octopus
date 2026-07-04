import { createHash } from "crypto"
import { readFileSync, readdirSync, statSync } from "fs"
import path from "path"

export function computeContentHash(filePath: string): string {
  const hash = createHash("sha256")
  const stat = statSync(filePath)

  if (stat.isFile()) {
    hash.update(readFileSync(filePath))
  } else if (stat.isDirectory()) {
    const entries = readdirSync(filePath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue
      hash.update(entry.name)
      hash.update(computeContentHash(path.join(filePath, entry.name)))
    }
  }

  return hash.digest("hex")
}

export function shortHash(fullHash: string): string {
  return fullHash.substring(0, 12)
}
