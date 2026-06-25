// ponytail: regex key-name matching — zero deps, predictable, matches Vault/AWS strategy

const DEFAULT_SENSITIVE_PATTERNS: RegExp[] = [
  /(?:^|[_-])(?:key|secret|token|password|credential|api[_-]?key|auth|private|dsn|connection[_-]?string|database[_-]?url|access[_-]?key|session[_-]?id|encryption|signing|jwt|cookie)(?:[_-]|$)/i,
]

const DEFAULT_TRUNCATE_KEYS = ['PATH', 'NODE_PATH', 'MANPATH']
const DEFAULT_TRUNCATE_LENGTH = 80

export class SecretMasker {
  private sensitivePatterns: RegExp[]
  private truncateKeys: string[]
  private truncateLength: number

  constructor(options?: {
    sensitivePatterns?: RegExp[]
    truncateKeys?: string[]
    truncateLength?: number
  }) {
    this.sensitivePatterns = options?.sensitivePatterns ?? DEFAULT_SENSITIVE_PATTERNS
    this.truncateKeys = options?.truncateKeys ?? DEFAULT_TRUNCATE_KEYS
    this.truncateLength = options?.truncateLength ?? DEFAULT_TRUNCATE_LENGTH
  }

  isSensitive(key: string): boolean {
    return this.sensitivePatterns.some(p => p.test(key))
  }

  maskValue(key: string, value: string): string {
    // Truncate long non-sensitive values (PATH etc.)
    if (this.truncateKeys.includes(key) && value.length > this.truncateLength) {
      return value.slice(0, this.truncateLength) + '...(truncated)'
    }

    if (!this.isSensitive(key)) return value

    // Sensitive key — mask by length tiers
    if (value.length <= 4) return '***'
    if (value.length <= 8) return value[0] + '***'
    return value.slice(0, 3) + '***...' + value.slice(-3)
  }

  maskObject(obj: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.maskValue(key, value)
    }
    return result
  }
}
