/**
 * ShortNameResolver — 短名称解析器
 *
 * 将用户输入的简短名称（如 "brainstorming"）解析为完整的 scoped key
 * （如 "skill:npm:superpowers-zh:brainstorming"）。
 * 当多个资源共享同一短名称时，返回 ambiguous 状态并提供 hints。
 */
export interface ResolveResult {
  matches: string[]
  ambiguous: boolean
  notFound: boolean
}

export interface ResolveHints {
  source?: string
  type?: string
}

export class ShortNameResolver {
  private entries: [string, { type: string; source: string }][]

  constructor(registry: Record<string, { type: string; source: string }>) {
    this.entries = Object.entries(registry)
  }

  resolve(input: string, hints?: ResolveHints): ResolveResult {
    if (input.length > 128) {
      throw new Error("Input exceeds 128 character limit")
    }

    // Direct scoped key match
    if (input.includes(":") && this.entries.some(([k]) => k === input)) {
      return { matches: [input], ambiguous: false, notFound: false }
    }

    // Short name matching: match against the last segment of each key
    let matches = this.entries
      .filter(([key]) => {
        const parts = key.split(":")
        const name = parts[parts.length - 1]
        return name === input || key.endsWith(`:${input}`)
      })
      .map(([key]) => key)

    if (hints?.source) {
      matches = matches.filter(k => k.includes(`:${hints.source}:`))
    }
    if (hints?.type) {
      matches = matches.filter(k => k.startsWith(`${hints.type}:`))
    }

    return {
      matches,
      ambiguous: matches.length > 1,
      notFound: matches.length === 0,
    }
  }
}
