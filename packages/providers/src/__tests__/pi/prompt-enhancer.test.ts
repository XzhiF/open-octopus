import { describe, it, expect } from 'vitest'
import { enhancePromptWithSkills, parseVarsUpdate } from '../../pi/prompt-enhancer'

describe('enhancePromptWithSkills (S14)', () => {
  it('appends skill content to prompt (TC-034)', () => {
    const result = enhancePromptWithSkills('Do something.', {
      skills: ['brainstorming'],
      skillContents: { brainstorming: '# Brainstorming\nExplore ideas first.' },
    })
    expect(result).toContain('## Available Skills')
    expect(result).toContain('Explore ideas first.')
  })

  it('empty skills list leaves prompt unchanged (TC-035)', () => {
    const original = 'Do something.'
    const result = enhancePromptWithSkills(original, { skills: [], skillContents: {} })
    expect(result).toBe(original)
  })

  it('multiple skills appended in order', () => {
    const result = enhancePromptWithSkills('Task.', {
      skills: ['brainstorming', 'tdd'],
      skillContents: { brainstorming: 'Skill A', tdd: 'Skill B' },
    })
    const aIdx = result.indexOf('Skill A')
    const bIdx = result.indexOf('Skill B')
    expect(aIdx).toBeLessThan(bIdx)
  })
})

// 知识中心票 08 / llm-wiki-loop D2 裁决 #12：pi 兼容保留，octo-wiki 知识段指针化
// —— 提供 wikiRoot 时只拼一行「全局 wiki 根 + 查阅纪律」，不拼 SKILL.md 正文。
describe('enhancePromptWithSkills — octo-wiki 知识段指针化（票08）', () => {
  const WIKI_BODY = [
    '# octo-wiki',
    '编译型知识库（wiki）只读查阅 —— 导航协议（INDEX→整读词条→search API 兜底）',
    'WIKI-BODY-MARKER 词条正文阅读指引',
  ].join('\n')

  it('提供 wikiRoot：octo-wiki 段是一行指针（根路径 + 查阅纪律），零知识正文', () => {
    const result = enhancePromptWithSkills('Task.', {
      skills: ['octo-wiki'],
      skillContents: { 'octo-wiki': WIKI_BODY },
      wikiRoot: '/home/user/.octopus/knowledge/wiki',
    })

    expect(result).toContain('## Available Skills')
    expect(result).toContain('### octo-wiki')
    expect(result).toContain('wiki=/home/user/.octopus/knowledge/wiki')
    expect(result).toContain('octo-wiki')
    expect(result).toContain('INDEX')
    expect(result).toContain('wiki_refs')
    // 指针 ≠ 注入：SKILL.md/词条正文一字不带
    expect(result).not.toContain('WIKI-BODY-MARKER')
    expect(result).not.toContain('导航协议（INDEX→整读词条→search API 兜底）')
    // ~50 token 级一行常量（200 字符上界 = 票11 指针行同口径纪律）
    const pointerLine = result.split(/\r?\n/).find((l) => l.includes('wiki='))!
    expect(pointerLine.length).toBeLessThanOrEqual(200)
  })

  it('未提供 wikiRoot = pi 兼容缺省：octo-wiki 正文照拼（既有调用面零变化）', () => {
    const result = enhancePromptWithSkills('Task.', {
      skills: ['octo-wiki'],
      skillContents: { 'octo-wiki': WIKI_BODY },
    })
    expect(result).toContain('WIKI-BODY-MARKER')
  })

  it('其它技能不受指针化影响（wikiRoot 在位也拼正文）', () => {
    const result = enhancePromptWithSkills('Task.', {
      skills: ['octo-wiki', 'tdd'],
      skillContents: { 'octo-wiki': WIKI_BODY, tdd: 'TDD-BODY-MARKER' },
      wikiRoot: '/home/user/.octopus/knowledge/wiki',
    })
    expect(result).toContain('TDD-BODY-MARKER')
    expect(result).not.toContain('WIKI-BODY-MARKER')
  })
})

describe('parseVarsUpdate (S15, B7)', () => {
  it('extracts valid vars_update JSON (TC-036 happy path)', () => {
    const text = 'Some output.\n{"vars_update": {"key": "value"}}\nMore text.'
    const result = parseVarsUpdate(text)
    expect(result).toEqual({ key: 'value' })
  })

  it('returns empty object when no vars_update present', () => {
    expect(parseVarsUpdate('Just regular text.')).toEqual({})
  })

  it('handles malformed JSON with warning (TC-036)', () => {
    const text = '{"vars_update": {broken json}'
    const result = parseVarsUpdate(text)
    expect(result).toEqual({})
  })

  it('extracts JSON embedded in markdown (TC-037)', () => {
    const text = 'Here is the result:\n```json\n{"vars_update": {"status": "done"}}\n```\nDone.'
    const result = parseVarsUpdate(text)
    expect(result).toEqual({ status: 'done' })
  })
})
