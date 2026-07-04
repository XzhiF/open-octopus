import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

describe('Interface purification (S06, TC-014)', () => {
  it('types.ts has no @anthropic-ai imports', () => {
    const content = fs.readFileSync(path.resolve(__dirname, '../types.ts'), 'utf-8')
    expect(content).not.toContain('@anthropic-ai')
  })
})
