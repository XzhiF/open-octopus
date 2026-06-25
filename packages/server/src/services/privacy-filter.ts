const SECRET_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  { name: 'aws_access_key',    regex: /AKIA[0-9A-Z]{16}/g,                                               replacement: '[AWS_KEY_REDACTED]' },
  { name: 'aws_secret_key',    regex: /(?<=aws_secret_access_key[=: ]+)[A-Za-z0-9/+=]{40}/g,             replacement: '[AWS_SECRET_REDACTED]' },
  { name: 'anthropic_key',     regex: /sk-ant-[a-zA-Z0-9\-]{20,}/g,                                      replacement: '[ANTHROPIC_KEY_REDACTED]' },
  { name: 'openai_key',        regex: /sk-(?!ant-)[a-zA-Z0-9]{20,}/g,                                    replacement: '[OPENAI_KEY_REDACTED]' },
  { name: 'github_pat',        regex: /ghp_[0-9a-zA-Z]{36}/g,                                            replacement: '[GITHUB_PAT_REDACTED]' },
  { name: 'github_oauth',      regex: /gho_[0-9a-zA-Z]{36}/g,                                            replacement: '[GITHUB_OAUTH_REDACTED]' },
  { name: 'slack_token',       regex: /xox[bpas]-[0-9a-zA-Z\-]{10,}/g,                                   replacement: '[SLACK_TOKEN_REDACTED]' },
  { name: 'stripe_key',        regex: /sk_(live|test)_[0-9a-zA-Z]{20,}/g,                                replacement: '[STRIPE_KEY_REDACTED]' },
  { name: 'bearer_token',      regex: /Bearer [A-Za-z0-9\-._~+/]+=*/g,                                   replacement: 'Bearer [TOKEN_REDACTED]' },
  { name: 'jwt',               regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: '[JWT_REDACTED]' },
  { name: 'private_key',       regex: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, replacement: '[PRIVATE_KEY_REDACTED]' },
  { name: 'connection_string', regex: /(mysql|postgres|postgresql|mongodb|redis|amqp):\/\/[^\s"']+/g,    replacement: '$1://[CONN_STRING_REDACTED]' },
]

export interface PrivacyFilterOptions {
  maxContentLength?: number
  maxToolResultLength?: number
  maxToolInputLength?: number
  redactSecrets?: boolean
}

export class PrivacyFilter {
  private maxContentLength: number
  private maxToolResultLength: number
  private maxToolInputLength: number
  private redactSecrets: boolean

  constructor(options: PrivacyFilterOptions = {}) {
    this.maxContentLength = options.maxContentLength ?? 500
    this.maxToolResultLength = options.maxToolResultLength ?? 2000
    this.maxToolInputLength = options.maxToolInputLength ?? 2000
    this.redactSecrets = options.redactSecrets ?? true
  }

  filterContent(content: string): { content: string; contentLength: number } {
    const originalLength = content.length
    const truncated = content.length > this.maxContentLength
      ? content.slice(0, this.maxContentLength)
      : content
    return {
      content: this.redactSecrets ? this.redactSecretsFromString(truncated) : truncated,
      contentLength: originalLength,
    }
  }

  filterToolResult(result: string): string {
    const truncated = result.length > this.maxToolResultLength
      ? result.slice(0, this.maxToolResultLength)
      : result
    return this.redactSecrets ? this.redactSecretsFromString(truncated) : truncated
  }

  filterToolInput(input: string): string {
    const truncated = input.length > this.maxToolInputLength
      ? input.slice(0, this.maxToolInputLength)
      : input
    return this.redactSecrets ? this.redactSecretsFromString(truncated) : truncated
  }

  private redactSecretsFromString(input: string): string {
    let result = input
    for (const pattern of SECRET_PATTERNS) {
      result = result.replace(pattern.regex, pattern.replacement)
    }
    return result
  }
}
