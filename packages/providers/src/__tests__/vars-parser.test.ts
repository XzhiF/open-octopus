import { describe, it, expect, vi } from 'vitest'
import { parseVarsUpdate } from '../pi/vars-parser'

describe('parseVarsUpdate', () => {
  it('extracts from plain JSON', () => {
    expect(parseVarsUpdate('{"vars_update":{"key":"value"}}')).toEqual({ key: 'value' })
  })

  it('extracts from markdown code block', () => {
    expect(parseVarsUpdate('text\n```json\n{"vars_update":{"a":1}}\n```\nmore')).toEqual({ a: 1 })
  })

  it('returns empty object when no vars_update', () => {
    expect(parseVarsUpdate('hello world')).toEqual({})
  })

  it('returns empty object for empty string', () => {
    expect(parseVarsUpdate('')).toEqual({})
  })

  it('handles incomplete JSON with warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = parseVarsUpdate('text with "vars_update": {"key": "val" and more')
    expect(typeof result).toBe('object')
    warnSpy.mockRestore()
  })
})
