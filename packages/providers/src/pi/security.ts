const ALLOWED_ENV_PREFIXES = [
  'ANTHROPIC_', 'OPENAI_', 'GOOGLE_', 'DASHSCOPE_', 'DEEPSEEK_',
  'MISTRAL_', 'XAI_', 'GROQ_', 'TOGETHER_', 'FIREWORKS_', 'AWS_',
  'PATH', 'HOME', 'LANG', 'LC_', 'TMPDIR',
]

const ALLOWED_ENV_EXACT = ['NODE_ENV', 'TZ', 'TERM']

function isEnvKeyAllowed(key: string): boolean {
  return ALLOWED_ENV_PREFIXES.some(prefix => key.startsWith(prefix))
    || ALLOWED_ENV_EXACT.includes(key)
}

export function buildSessionEnv(options?: { env?: Record<string, string> }): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (value && isEnvKeyAllowed(key)) {
      env[key] = value
    }
  }

  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (isEnvKeyAllowed(key)) {
        env[key] = value
      }
    }
  }

  return env
}

export const COMMAND_BLACKLIST: RegExp[] = [
  /^rm\s+-rf\s+\//,
  /^sudo\s+/,
  /^chmod\s+777\s+/,
  /curl\s+.*\|\s*bash/,
  /wget\s+.*\|\s*sh/,
  /^mkfs\./,
  /^dd\s+.*of=\/dev\//,
  /\bbash\s+-c\b/,
  /\bsh\s+-c\b/,
  /^eval\s+/,
  /\$\(/,
  /\bpython[23]?\s+-c\b/,
  /\bnode\s+-e\b/,
  /\bperl\s+-e\b/,
  /\bruby\s+-e\b/,
  /\/(bin|usr|sbin)\/(rm|dd|mkfs|chmod)/,
  /<<\s*['"]?(EOF|BASH|SH)['"]?/,
  /`[^`]*`/,
]

export function isCommandBlocked(command: string): boolean {
  return COMMAND_BLACKLIST.some(pattern => pattern.test(command))
}
