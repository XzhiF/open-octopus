import fs from 'fs'
import path from 'path'
import { getPersonaPath as _getGlobalPersonaPath } from './paths'

const MAX_PERSONA_CHARS = 2000

export interface PersonaContent {
  content: string
  token_count: number
}

export class PersonaTooLongError extends Error {
  code = 'PERSONA_TOO_LONG'
  currentLength: number
  maxLength: number

  constructor(currentLength: number) {
    super(`Persona content exceeds ${MAX_PERSONA_CHARS} characters (current: ${currentLength})`)
    this.name = 'PersonaTooLongError'
    this.currentLength = currentLength
    this.maxLength = MAX_PERSONA_CHARS
  }
}

export class PersonaEmptyError extends Error {
  code = 'INVALID_PARAM'

  constructor() {
    super('Persona content must not be empty')
    this.name = 'PersonaEmptyError'
  }
}

export class PersonaService {
  /**
   * Read persona.md content for an org.
   * Strips YAML frontmatter if present.
   * Returns empty string if file doesn't exist.
   */
  readPersona(org: string): PersonaContent {
    const personaPath = this.getPersonaPath(org)

    if (!fs.existsSync(personaPath)) {
      return { content: '', token_count: 0 }
    }

    let content = fs.readFileSync(personaPath, 'utf-8')

    // Strip YAML frontmatter (--- ... ---)
    content = this.stripFrontmatter(content)

    const tokenCount = this.estimateTokens(content)

    return { content: content.trim(), token_count: tokenCount }
  }

  /**
   * Write persona content to persona.md.
   * Validates non-empty and <=2000 characters.
   */
  writePersona(org: string, content: string): PersonaContent {
    // Validate
    const trimmed = content.trim()
    if (!trimmed) {
      throw new PersonaEmptyError()
    }
    if (trimmed.length > MAX_PERSONA_CHARS) {
      throw new PersonaTooLongError(trimmed.length)
    }

    const personaPath = this.getPersonaPath(org)
    const dir = path.dirname(personaPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(personaPath, trimmed + '\n', 'utf-8')

    return {
      content: trimmed,
      token_count: this.estimateTokens(trimmed),
    }
  }

  /**
   * Get the filesystem path for persona.md (global, shared across orgs).
   */
  getPersonaPath(_org?: string): string {
    return _getGlobalPersonaPath()
  }

  /**
   * Strip YAML frontmatter (--- ... ---) from content.
   */
  private stripFrontmatter(content: string): string {
    if (!content.startsWith('---')) return content

    const endIndex = content.indexOf('---', 3)
    if (endIndex === -1) return content

    return content.slice(endIndex + 3).trim()
  }

  /**
   * Rough token estimation: ~4 characters per token for mixed content.
   * For CJK text, ~1.5 characters per token.
   */
  private estimateTokens(text: string): number {
    // Count CJK characters (they use fewer chars per token)
    const cjkChars = (text.match(/[一-鿿㐀-䶿]/g) || []).length
    const nonCjkChars = text.length - cjkChars

    const cjkTokens = Math.ceil(cjkChars / 1.5)
    const nonCjkTokens = Math.ceil(nonCjkChars / 4)

    return cjkTokens + nonCjkTokens
  }
}

// Singleton
let personaServiceInstance: PersonaService | null = null

export function getPersonaService(): PersonaService {
  if (!personaServiceInstance) {
    personaServiceInstance = new PersonaService()
  }
  return personaServiceInstance
}
