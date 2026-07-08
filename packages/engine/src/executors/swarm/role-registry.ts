import { existsSync, readFileSync, readdirSync, openSync, readSync, closeSync } from "fs"
import { join } from "path"

/**
 * 角色定义 — 描述一个 Expert 角色的元数据
 */
export interface RoleDef {
  name: string
  description: string
  category: string
  capabilities?: string[]
  agent_file?: string  // .md 文件路径
  source: "agency-agents-zh" | "custom" | "org"
  body?: string  // 完整 markdown 内容（懒加载）
}

/**
 * 角色注册表 — 两阶段加载系统
 *
 * 阶段 1: loadIndex() — 扫描目录、解析 frontmatter、构建索引（不读取 body）
 * 阶段 2: resolve() — 按需读取完整 markdown 内容
 *
 * 优先级: custom (.claude/agents/) > org (~/.octopus/{org}/agents/) > agency-agents-zh
 */
export class RoleRegistry {
  private index: RoleDef[] = []
  private loaded = false

  /**
   * @param basePaths 扫描路径列表，按优先级从高到低排列
   *   [workspace_dir, org_dir, agency-agents-zh_dir]
   */
  constructor(private basePaths: string[] = []) {}

  /** 加载角色索引（幂等，重复调用不会重新扫描） */
  async loadIndex(): Promise<void> {
    if (this.loaded) return

    const roles: RoleDef[] = []

    // 按优先级顺序扫描路径
    for (const basePath of this.basePaths) {
      if (!existsSync(basePath)) continue
      const source = this.inferSource(basePath)
      const files = this.scanDirectory(basePath)

      for (const file of files) {
        try {
          const content = this.readFrontmatterOnly(file)
          const frontmatter = this.parseFrontmatter(content)

          if (!frontmatter.name || !frontmatter.description) {
            console.warn(`[RoleRegistry] Skipping ${file}: missing required frontmatter (name/description)`)
            continue
          }

          // Infer category from directory structure if not in frontmatter
          const category = frontmatter.category || this.inferCategory(file, basePath)

          // 高优先级源已有同名角色则跳过
          if (roles.some(r => r.name === frontmatter.name)) continue

          roles.push({
            name: frontmatter.name,
            description: frontmatter.description,
            category,
            capabilities: frontmatter.capabilities?.split(",").map((s: string) => s.trim()),
            agent_file: file,
            source,
          })
        } catch (e) {
          console.warn(`[RoleRegistry] Failed to parse ${file}:`, e)
        }
      }
    }

    this.index = roles
    this.loaded = true
  }

  /** 按名称解析角色（懒加载 body） */
  resolve(name: string): RoleDef | null {
    const role = this.index.find(r => r.name === name)
    if (!role || !role.agent_file) return null

    if (!role.body) {
      role.body = readFileSync(role.agent_file, "utf-8")
    }
    return { ...role }
  }

  /** 批量解析多个角色 */
  resolveMany(names: string[]): RoleDef[] {
    return names.map(n => this.resolve(n)).filter((r): r is RoleDef => r !== null)
  }

  /** 按关键字搜索角色（名称或描述，大小写不敏感） */
  search(query: string): RoleDef[] {
    const q = query.toLowerCase()
    return this.index.filter(r =>
      r.name.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q)
    )
  }

  /** 列出所有角色 */
  list(): RoleDef[] {
    return [...this.index]
  }

  /** 按 category 分组列出角色 */
  listByCategory(): Record<string, RoleDef[]> {
    const groups: Record<string, RoleDef[]> = {}
    for (const role of this.index) {
      const cat = role.category || "uncategorized"
      if (!groups[cat]) groups[cat] = []
      groups[cat].push(role)
    }
    return groups
  }

  private inferSource(basePath: string): RoleDef["source"] {
    if (basePath.includes(".claude/agents")) return "custom"
    if (basePath.includes("agency-agents-zh")) return "agency-agents-zh"
    return "org"
  }

  private inferCategory(filePath: string, basePath: string): string {
    // ponytail: derive category from parent directory name relative to basePath
    const rel = filePath.slice(basePath.length + 1) // strip basePath + /
    const parts = rel.split("/")
    if (parts.length > 1) return parts[0] // e.g. "engineering/engineering-xxx.md" → "engineering"
    return "uncategorized"
  }

  private scanDirectory(dir: string): string[] {
    const files: string[] = []
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          files.push(...this.scanDirectory(fullPath))
        } else if (entry.name.endsWith(".md")) {
          files.push(fullPath)
        }
      }
    } catch { /* ignore permission errors */ }
    return files
  }

  /** Read only the first 2KB of a file for frontmatter extraction. Avoids loading full .md body. */
  private readFrontmatterOnly(filePath: string): string {
    const fd = openSync(filePath, "r")
    try {
      const buf = Buffer.alloc(2048)
      const bytesRead = readSync(fd, buf, 0, 2048, 0)
      return buf.toString("utf-8", 0, bytesRead)
    } finally {
      closeSync(fd)
    }
  }

  private parseFrontmatter(content: string): Record<string, string> {
    const match = content.match(/^---\n([\s\S]*?)\n---/)
    if (!match) return {}

    const result: Record<string, string> = {}
    for (const line of match[1].split("\n")) {
      const colonIdx = line.indexOf(":")
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim()
        const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "")
        result[key] = value
      }
    }
    return result
  }
}
