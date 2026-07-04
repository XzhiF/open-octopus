/**
 * 资源管理工具函数 — 哈希、文件操作、格式化
 */
import { createHash } from "crypto"
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  copyFileSync,
  rmSync,
} from "fs"
import { join, resolve, relative, sep } from "path"

/**
 * 计算文件/目录的内容哈希（SHA-256，返回 12 位十六进制）
 */
export function computeContentHash(targetPath: string): string {
  const hash = createHash("sha256")

  if (!existsSync(targetPath)) {
    return "000000000000"
  }

  const stat = statSync(targetPath)
  if (stat.isFile()) {
    hash.update(readFileSync(targetPath))
  } else if (stat.isDirectory()) {
    const files = collectFiles(targetPath).sort()
    for (const file of files) {
      const rel = relative(targetPath, file)
      hash.update(rel)
      hash.update(readFileSync(file))
    }
  }

  return hash.digest("hex").substring(0, 12)
}

/**
 * 递归收集目录下所有文件路径
 */
export function collectFiles(dir: string): string[] {
  const result: string[] = []
  if (!existsSync(dir)) return result

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...collectFiles(fullPath))
    } else if (entry.isFile()) {
      result.push(fullPath)
    }
  }
  return result
}

/**
 * 递归复制目录
 */
export function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })

  const entries = readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else if (entry.isFile()) {
      copyFileSync(srcPath, destPath)
    }
  }
}

/**
 * 计算目录大小（字节）
 */
export function computeDirSize(dir: string): number {
  let total = 0
  if (!existsSync(dir)) return total

  const files = collectFiles(dir)
  for (const file of files) {
    total += statSync(file).size
  }
  return total
}

/**
 * 路径遍历防护: 确保 resolved path 在 base 目录内
 */
export function isPathWithinBase(targetPath: string, baseDir: string): boolean {
  const resolved = resolve(baseDir, targetPath)
  const base = resolve(baseDir)
  return resolved.startsWith(base + sep) || resolved === base
}

/**
 * 安全删除目录/文件（忽略不存在的情况）
 */
export function safeRemove(targetPath: string): void {
  if (existsSync(targetPath)) {
    rmSync(targetPath, { recursive: true, force: true })
  }
}

/**
 * 格式化字节数为人类可读格式
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i > 0 ? 1 : 0)}${units[i]}`
}

/**
 * 格式化 SourceRef 为可读字符串
 */
export function formatSourceRef(ref: { protocol: string; [key: string]: unknown }): string {
  switch (ref.protocol) {
    case "npm": return `npm:${ref.package}${ref.version ? `@${ref.version}` : ""}`
    case "github": return `github:${ref.repo}${ref.ref ? `#${ref.ref}` : ""}${ref.path ? `/${ref.path}` : ""}`
    case "local": return `local:${ref.path}`
    case "builtin": return `builtin:${ref.id}`
    default: return `${ref.protocol}:unknown`
  }
}

/**
 * 生成当前时间戳 ISO 格式
 */
export function nowISO(): string {
  return new Date().toISOString()
}
