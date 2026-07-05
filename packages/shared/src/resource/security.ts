import { join, resolve, relative } from 'path'

/**
 * SecurityContext — 路径遍历检测 + 信任校验
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
  constructor(private data: TrustData = { trusted: [], blocked: [] }) {}

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
  }

  untrust(source: TrustSource): void {
    this.data.trusted = this.data.trusted.filter(
      t => !(t.protocol === source.protocol && t.location === source.location),
    )
  }

  unblock(source: TrustSource): void {
    this.data.blocked = this.data.blocked.filter(
      b => !(b.protocol === source.protocol && b.location === source.location),
    )
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

    const { execSync } = await import('child_process')
    try {
      const stdout = execSync(command, {
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
