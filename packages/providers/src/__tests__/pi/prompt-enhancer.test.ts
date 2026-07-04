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
