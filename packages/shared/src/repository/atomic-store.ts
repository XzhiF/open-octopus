/**
 * AtomicJsonStore — write-to-temp + rename 原子写入模式
 *
 * POSIX 保证 rename(2) 是原子操作。写入流程:
 *   1. 备份现有文件到 .bak
 *   2. 写入临时文件 .tmp.{pid}
 *   3. rename 临时文件到目标路径
 *
 * 读取流程:
 *   1. 尝试读取主文件
 *   2. 主文件损坏/不存在时回退到 .bak
 */
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync } from "fs"
import { dirname } from "path"

export class AtomicJsonStore<T> {
  private readonly path: string
  private readonly backupPath: string

  constructor(path: string) {
    this.path = path
    this.backupPath = `${path}.bak`
  }

  /** 原子写入 JSON 数据 */
  write(data: T): void {
    // 确保目录存在
    mkdirSync(dirname(this.path), { recursive: true })

    // 备份已有文件
    if (existsSync(this.path)) {
      copyFileSync(this.path, this.backupPath)
    }

    // 写入临时文件 + rename
    const tmpPath = `${this.path}.tmp.${process.pid}`
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8")
    renameSync(tmpPath, this.path)
  }

  /** 读取 JSON 数据（主文件失败时回退到备份） */
  read(defaultValue?: T): T {
    try {
      const content = readFileSync(this.path, "utf-8")
      return JSON.parse(content) as T
    } catch {
      // 尝试备份文件
      try {
        const content = readFileSync(this.backupPath, "utf-8")
        return JSON.parse(content) as T
      } catch {
        if (defaultValue !== undefined) return defaultValue
        throw new Error(`AtomicJsonStore: Cannot read ${this.path} or ${this.backupPath}`)
      }
    }
  }

  /** 安全读取，如果文件不存在返回默认值 */
  readOrDefault(defaultValue: T): T {
    if (!existsSync(this.path) && !existsSync(this.backupPath)) {
      return defaultValue
    }
    return this.read(defaultValue)
  }

  /** 文件是否存在 */
  exists(): boolean {
    return existsSync(this.path)
  }

  /** 获取文件路径 */
  getPath(): string {
    return this.path
  }
}
