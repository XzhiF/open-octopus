import { join, resolve, relative } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'

/**
 * SecurityContext — 路径遍历检测 + 目标安全校验
 */
export class SecurityContext {
  /**
   * 验证目标路径不存在路径遍历攻击
   * @throws Error if path traversal detected
   */
  static assertSafePath(target: string, baseDir: string): string {
    // Check raw path for .. segments before resolution
    const segments = target.split(/[/\\]/)
    if (segments.includes('..')) {
      throw new Error(`PATH_TRAVERSAL_DETECTED: "${target}" escapes base directory "${baseDir}"`)
    }

    const resolved = resolve(baseDir, target)
    const rel = relative(baseDir, resolved)

    // Double-check after resolution
    if (rel.startsWith('..') || rel.includes('/..') || rel.includes('\\..')) {
      throw new Error(`PATH_TRAVERSAL_DETECTED: "${target}" escapes base directory "${baseDir}"`)
    }

    return resolved
  }

  /**
   * 验证 install.target 不含危险字符
   */
  static assertSafeTarget(target: string): void {
    const dangerous = ['..', '~', '$', '`', ';', '|', '&', '>', '<', '(', ')']
    for (const ch of dangerous) {
      if (target.includes(ch)) {
        throw new Error(`PATH_TRAVERSAL_DETECTED: install.target contains dangerous character "${ch}"`)
      }
    }
  }
}

/**
 * CallerContext — 调用者身份识别 + Agent 门控
 *
 * 通过 OCTOPUS_CALLER 环境变量区分 human/agent 调用者，
 * agent 调用者需要显式 --confirmed 才能执行破坏性操作。
 */
export class CallerContext {
  readonly caller: 'human' | 'agent'

  constructor(private env: Record<string, string | undefined> = process.env) {
    this.caller = env.OCTOPUS_CALLER === 'agent' ? 'agent' : 'human'
  }

  isAgent(): boolean { return this.caller === 'agent' }

  requireConfirmation(confirmed: boolean): boolean {
    if (!this.isAgent()) return true
    return confirmed
  }
}

/**
 * TrustStore — 管理信任/阻止列表
 */
export interface TrustSource {
  protocol: string
  location: string
}

export interface TrustData {
  trusted: Array<TrustSource & { trusted_at: string }>
  blocked: Array<TrustSource & { blocked_at: string; reason?: string }>
}

export class TrustStore {
  private filePath?: string

  /**
   * B-14 fix: Optional filePath enables disk persistence.
   * When provided, the store loads on construction and saves on every mutation.
   */
  constructor(data: TrustData = { trusted: [], blocked: [] }, filePath?: string) {
    this.data = data
    this.filePath = filePath
    if (filePath) this.loadFromDisk()
  }

  private data: TrustData

  private loadFromDisk(): void {
    if (!this.filePath || !existsSync(this.filePath)) return
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.trusted) && Array.isArray(parsed.blocked)) {
        this.data = parsed
      }
    } catch {
      // Corrupted file — start fresh
    }
  }

  private saveToDisk(): void {
    if (!this.filePath) return
    try {
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'))
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch {
      // Best-effort persistence
    }
  }

  isTrusted(source: TrustSource): boolean {
    return this.data.trusted.some(
      t => t.protocol === source.protocol && t.location === source.location,
    )
  }

  isBlocked(source: TrustSource): boolean {
    return this.data.blocked.some(
      b => b.protocol === source.protocol && b.location === source.location,
    )
  }

  trust(source: TrustSource): void {
    if (this.isTrusted(source)) return
    // Remove from blocked if present
    this.data.blocked = this.data.blocked.filter(
      b => !(b.protocol === source.protocol && b.location === source.location),
    )
    this.data.trusted.push({ ...source, trusted_at: new Date().toISOString() })
    this.saveToDisk()
  }

  block(source: TrustSource, reason?: string): void {
    if (this.isBlocked(source)) return
    // Remove from trusted if present
    this.data.trusted = this.data.trusted.filter(
      t => !(t.protocol === source.protocol && t.location === source.location),
    )
    this.data.blocked.push({
      ...source,
      blocked_at: new Date().toISOString(),
      reason,
    })
    this.saveToDisk()
  }

  untrust(source: TrustSource): void {
    this.data.trusted = this.data.trusted.filter(
      t => !(t.protocol === source.protocol && t.location === source.location),
    )
    this.saveToDisk()
  }

  unblock(source: TrustSource): void {
    this.data.blocked = this.data.blocked.filter(
      b => !(b.protocol === source.protocol && b.location === source.location),
    )
    this.saveToDisk()
  }

  getData(): TrustData {
    return { ...this.data }
  }

  /**
   * 验证 source 是否允许安装
   * builtin 和 local 协议始终信任
   */
  assertAllowed(source: TrustSource): void {
    if (source.protocol === 'builtin' || source.protocol === 'local') return
    if (this.isBlocked(source)) {
      throw new Error(`SOURCE_BLOCKED: ${source.protocol}:${source.location} is blocked`)
    }
    if (!this.isTrusted(source)) {
      throw new Error(`SOURCE_NOT_TRUSTED: ${source.protocol}:${source.location} is not trusted. Use --trust to add it.`)
    }
  }
}

/**
 * HookExecutor — 安全执行 post_install hooks
 */
export class HookExecutor {
  constructor(
    private allowlist: string[] = [],
    private dryRun = false,
  ) {}

  async execute(command: string, cwd: string): Promise<{ stdout: string; exitCode: number }> {
    // Validate command against allowlist
    const baseCmd = command.split(/\s+/)[0]
    if (this.allowlist.length > 0 && !this.allowlist.includes(baseCmd)) {
      throw new Error(`AGENT_CONFIRMATION_REQUIRED: post_install command "${baseCmd}" is not in the allowlist`)
    }

    if (this.dryRun) {
      return { stdout: `[dry-run] would execute: ${command}`, exitCode: 0 }
    }

    const { execFileSync } = await import('child_process')
    // B-01 fix: split command into argv and pass via execFileSync — no shell interpolation.
    // The allowlist check above validates the base command before we run it.
    const argv = command.split(/\s+/).filter(Boolean)
    const cmd = argv[0]
    const args = argv.slice(1)
    if (!cmd) {
      return { stdout: '', exitCode: 1 }
    }
    try {
      const stdout = execFileSync(cmd, args, {
        cwd,
        encoding: 'utf-8',
        timeout: 60_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return { stdout: stdout || '', exitCode: 0 }
    } catch (err: any) {
      return { stdout: err.stdout || err.message, exitCode: err.status ?? 1 }
    }
  }
}
