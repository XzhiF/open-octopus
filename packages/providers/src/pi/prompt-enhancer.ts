interface SkillOptions {
  skills: string[]
  skillContents: Record<string, string>
}

export function enhancePromptWithSkills(
  prompt: string,
  opts: SkillOptions,
): string {
  if (!opts.skills || opts.skills.length === 0) return prompt

  const skillSections = opts.skills
    .map(name => {
      const content = opts.skillContents[name]
      return content ? `### ${name}\n${content}` : null
    })
    .filter(Boolean)
    .join('\n\n')

  if (!skillSections) return prompt

  return `${prompt}\n\n## Available Skills\n${skillSections}`
}

export function parseVarsUpdate(text: string): Record<string, unknown> {
  // Strategy 1: Direct JSON match
  const directMatch = text.match(/\{"vars_update"\s*:\s*(\{[^}]*\})\}/)
  if (directMatch) {
    try {
      const parsed = JSON.parse(`{"vars_update": ${directMatch[1]}}`)
      return parsed.vars_update ?? {}
    } catch { /* fall through */ }
  }

  // Strategy 2: Look for vars_update in any JSON block
  const jsonBlocks = text.match(/\{[^{}]*"vars_update"[^{}]*\}/g) ?? []
  for (const block of jsonBlocks) {
    try {
      const parsed = JSON.parse(block)
      if (parsed.vars_update && typeof parsed.vars_update === 'object') {
        return parsed.vars_update
      }
    } catch { /* continue */ }
  }

  return {}
}
