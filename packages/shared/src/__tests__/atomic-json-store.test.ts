import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AtomicJsonStore } from '../resource/fs-store'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('AtomicJsonStore', () => {
  let dir: string
  let store: AtomicJsonStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atomic-test-'))
    store = new AtomicJsonStore(dir)
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes and reads JSON atomically', async () => {
    const data = { version: 1, entries: { a: 1 } }
    await store.write('registry.json', data)
    const result = await store.read('registry.json')
    expect(result).toEqual(data)
  })

  it('creates .bak on second write', async () => {
    await store.write('registry.json', { v: 1 })
    await store.write('registry.json', { v: 2 })
    const bak = readFileSync(join(dir, 'registry.json.bak'), 'utf-8')
    expect(JSON.parse(bak)).toEqual({ v: 1 })
  })

  it('falls back to .bak when main file is corrupted', async () => {
    await store.write('registry.json', { v: 1 })
    await store.write('registry.json', { v: 2 })
    // Corrupt main file
    writeFileSync(join(dir, 'registry.json'), '{invalid json')
    const result = await store.read('registry.json')
    expect(result).toEqual({ v: 1 }) // Falls back to .bak
  })

  it('returns null when neither file exists', async () => {
    const result = await store.read('nonexistent.json')
    expect(result).toBeNull()
  })
})
