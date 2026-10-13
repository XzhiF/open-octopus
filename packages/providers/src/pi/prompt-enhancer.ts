/** 知识段指针化目标技能（知识中心票 08 / llm-wiki-loop D2 裁决 #12）。 */
const OCTO_WIKI_SKILL_NAME = 'octo-wiki'

interface SkillOptions {
  skills: string[]
  skillContents: Record<string, string>
  /**
   * 知识中心票 08（D2 裁决 #12「保留 pi 兼容但只拼导航段指针，不拼知识正文」）：
   * 全局 wiki 根（票 03 global-paths 单源，由 server 消费方注入）。提供时，
   * octo-wiki 技能以一行指针入 prompt（根路径 + 查阅纪律，~50 token，零词条正文）；
   * 缺省 = 兼容既有 pi 调用面（照旧拼正文）。
   */
  wikiRoot?: string
}

export function enhancePromptWithSkills(
  prompt: string,
  opts: SkillOptions,
): string {
  if (!opts.skills || opts.skills.length === 0) return prompt

  const skillSections = opts.skills
    .map(name => {
      if (name === OCTO_WIKI_SKILL_NAME && opts.wikiRoot) {
        // 指针 ≠ 注入：任务书只指路，知识正文由 agent 按导航协议自读
        return `### ${name}\n- 知识指针: wiki=${opts.wikiRoot} 动手前按 octo-wiki 导航协议先读 INDEX，产出标 [ref:]、收尾写 wiki_refs（只指路不喂正文）`
      }
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
