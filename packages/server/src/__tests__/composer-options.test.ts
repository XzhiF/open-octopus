import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  applyContextVariant,
  parseComposerContext,
  parseComposerEffort,
  resolveChatModel,
} from '../routes/agent/composer-options'

const TEST_HOME = path.join(os.tmpdir(), `composer-options-${Date.now()}`)
let previousHome: string | undefined

beforeAll(() => {
  previousHome = process.env.HOME
  process.env.HOME = TEST_HOME
  fs.mkdirSync(path.join(TEST_HOME, '.octopus'), { recursive: true })
  fs.writeFileSync(
    path.join(TEST_HOME, '.octopus', 'models.yaml'),
    [
      'default: pro',
      'providers:',
      '  claude:',
      '    pro-max: E2E_TEST_max',
      '    pro: E2E_TEST_pro',
      '    se: E2E_TEST_se',
      '',
    ].join('\n'),
  )
})

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* non-fatal */ }
})

describe('composer options', () => {
  it('effort 只接受 SDK 支持的五档', () => {
    expect(parseComposerEffort('low')).toBe('low')
    expect(parseComposerEffort('xhigh')).toBe('xhigh')
    expect(parseComposerEffort('max')).toBe('max')
    expect(parseComposerEffort('ultra')).toBeUndefined()
    expect(parseComposerEffort(42)).toBeUndefined()
  })

  it('maxContext 只接受 200k / 1m', () => {
    expect(parseComposerContext('200k')).toBe('200k')
    expect(parseComposerContext('1m')).toBe('1m')
    expect(parseComposerContext('400k')).toBeUndefined()
  })

  it('1M 通过模型名 [1m] 变体启用；200k 回到基础模型', () => {
    expect(applyContextVariant('pro', '1m')).toBe('pro[1m]')
    expect(applyContextVariant('pro[1m]', '200k')).toBe('pro')
    expect(applyContextVariant('qwen3.8-flash[32k]', '1m')).toBe('qwen3.8-flash[1m]')
    expect(applyContextVariant('pro', '200k')).toBe('pro')
    expect(applyContextVariant('pro[1m]', undefined)).toBe('pro[1m]')
    expect(applyContextVariant(undefined, '1m')).toBeUndefined()
  })

  it('聊天模型先按 models.yaml 解析别名，再拼上下文变体', () => {
    expect(resolveChatModel('pro-max', '1m')).toBe('E2E_TEST_max[1m]')
    expect(resolveChatModel('pro', '200k')).toBe('E2E_TEST_pro')
    expect(resolveChatModel('qwen3.8-flash', '1m')).toBe('qwen3.8-flash[1m]')
    expect(resolveChatModel(undefined, '1m')).toBeUndefined()
  })
})
