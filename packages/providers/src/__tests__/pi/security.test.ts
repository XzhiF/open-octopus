import { describe, it, expect } from 'vitest'
import { buildSessionEnv, isCommandBlocked, COMMAND_BLACKLIST } from '../../pi/security'

describe('buildSessionEnv (F-3, SEC-01)', () => {
  it('whitelists API key env vars', () => {
    const original = { ...process.env }
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    process.env.DASHSCOPE_API_KEY = 'sk-test'
    process.env.OPENAI_API_KEY = 'sk-openai'
    process.env.PATH = '/usr/bin'
    process.env.HOME = '/home/user'
    process.env.SECRET_INTERNAL = 'should-be-filtered'

    const env = buildSessionEnv()
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test')
    expect(env.DASHSCOPE_API_KEY).toBe('sk-test')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.SECRET_INTERNAL).toBeUndefined()

    // Restore
    delete process.env.SECRET_INTERNAL
    if (original.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = original.ANTHROPIC_API_KEY
    else delete process.env.ANTHROPIC_API_KEY
    if (original.DASHSCOPE_API_KEY) process.env.DASHSCOPE_API_KEY = original.DASHSCOPE_API_KEY
    else delete process.env.DASHSCOPE_API_KEY
    if (original.OPENAI_API_KEY) process.env.OPENAI_API_KEY = original.OPENAI_API_KEY
    else delete process.env.OPENAI_API_KEY
  })

  it('merges options.env with higher priority', () => {
    const env = buildSessionEnv({ env: { ANTHROPIC_API_KEY: 'val' } })
    expect(env.ANTHROPIC_API_KEY).toBe('val')
  })

  it('P0-3: filters options.env through whitelist (CRITICAL)', () => {
    const env = buildSessionEnv({ env: {
      ANTHROPIC_API_KEY: 'ok-key',
      DATABASE_URL: 'postgresql://secret',
      AWS_SECRET_KEY: 'should-pass',
      INTERNAL_TOKEN: 'should-block',
    }})
    expect(env.ANTHROPIC_API_KEY).toBe('ok-key')
    expect(env.AWS_SECRET_KEY).toBe('should-pass')
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.INTERNAL_TOKEN).toBeUndefined()
  })

  it('P0-3: NODE_ narrowed to NODE_ENV only', () => {
    const env = buildSessionEnv({ env: { NODE_OPTIONS: '--inspect', NODE_ENV: 'production' } })
    expect(env.NODE_ENV).toBe('production')
    expect(env.NODE_OPTIONS).toBeUndefined()
  })
})

describe('isCommandBlocked (F-4, SEC-09)', () => {
  it('blocks rm -rf /', () => {
    expect(isCommandBlocked('rm -rf /')).toBe(true)
  })

  it('blocks sudo', () => {
    expect(isCommandBlocked('sudo apt install')).toBe(true)
  })

  it('blocks bash -c', () => {
    expect(isCommandBlocked('bash -c "rm -rf /"')).toBe(true)
  })

  it('blocks eval', () => {
    expect(isCommandBlocked('eval dangerous_cmd')).toBe(true)
  })

  it('blocks $() subshell', () => {
    expect(isCommandBlocked('echo $(rm -rf /)')).toBe(true)
  })

  it('blocks node -e (P1-6)', () => {
    expect(isCommandBlocked('node -e "require(\\"fs\\").rmSync(\\"/\\", {recursive: true})"')).toBe(true)
  })

  it('blocks absolute path bypass (P1-6)', () => {
    expect(isCommandBlocked('/bin/rm -rf /')).toBe(true)
  })

  it('blocks backtick subshell (P1-6)', () => {
    expect(isCommandBlocked('echo `rm -rf /`')).toBe(true)
  })

  it('allows normal commands (TC-030)', () => {
    expect(isCommandBlocked('ls -la')).toBe(false)
    expect(isCommandBlocked('cat file.txt')).toBe(false)
    expect(isCommandBlocked('git status')).toBe(false)
  })

  it('blacklist has 18 entries (P1-6 extended)', () => {
    expect(COMMAND_BLACKLIST.length).toBe(18)
  })
})
