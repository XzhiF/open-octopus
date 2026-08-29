import { describe, it, expect } from 'vitest'
import { TokenUsageSchema, ModelUsageSchema, totalTokens, addTokenUsage, emptyTokenUsage, mergeModelUsages } from '@octopus/shared'
import { usageFromRow, usageFromLegacyJson, normalizeUsageJson } from '../db/dao/usage-mapping'

/**
 * C1 wire/形状契约测试 —— 钉死「snake↔规范」单点转换与规范 JSON 字段名，
 * 防止未来某出口又平铺 totalInputTokens / 把 cache 折进 input（node_end/steps/
 * observability/execution_metrics 四类异端的回归护栏）。
 */
describe('TokenUsage 规范形状契约 (C1)', () => {
  it('规范 JSON 恰为四字段 camelCase，无 total/input/平铺名', () => {
    const keys = Object.keys(emptyTokenUsage()).sort()
    expect(keys).toEqual(['cacheCreationTokens', 'cacheReadTokens', 'inputTokens', 'outputTokens'])
    expect(() => TokenUsageSchema.parse({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1 })).not.toThrow()
  })

  it('ModelUsage = 规范四字段 + model (+ 可选 costUsd)', () => {
    const mu = ModelUsageSchema.parse({ model: 'm', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 })
    expect(mu).toEqual({ model: 'm', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 })
    expect(mu.costUsd).toBeUndefined()
  })

  it('input 是纯值口径：totalTokens 才含 cache，input≠input+cache', () => {
    const u = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheCreationTokens: 5 }
    expect(u.inputTokens).toBe(100) // 未被 cache 污染
    expect(totalTokens(u)).toBe(1015)
  })
})

describe('DAO 行 → 规范转换 (D4)', () => {
  it('snake 列名只在此处出现，产出 camel 规范', () => {
    expect(usageFromRow({
      input_tokens: 5, output_tokens: 6, cache_read_tokens: 7, cache_creation_tokens: 8,
    })).toEqual({ inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheCreationTokens: 8 })
  })

  it('NULL/缺列 → 0，绝不 NaN', () => {
    expect(usageFromRow({ input_tokens: null, output_tokens: undefined } as never))
      .toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })
  })
})

describe('历史 JSON blob 读侧归一 (存量不回填)', () => {
  it('legacy {input,output} 合并口径 → 映射（cache 缺失按 0，不臆测拆分）', () => {
    expect(usageFromLegacyJson({ input: 50, output: 20 }))
      .toEqual({ inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 })
  })

  it('新规范 JSON 原样过 schema', () => {
    const canon = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 }
    expect(usageFromLegacyJson(canon)).toEqual(canon)
  })

  it('normalizeUsageJson 把旧行 JSON 转成规范 JSON', () => {
    const out = normalizeUsageJson(JSON.stringify({ input: 9, output: 1, cacheRead: 2 }))
    expect(JSON.parse(out!)).toEqual({ inputTokens: 9, outputTokens: 1, cacheReadTokens: 2, cacheCreationTokens: 0 })
  })

  it('null/坏 JSON 透传不崩', () => {
    expect(normalizeUsageJson(null)).toBeNull()
    expect(normalizeUsageJson('{bad')).toBe('{bad')
  })
})

describe('累计/合并工具（节点卡不跳变的实现底座）', () => {
  it('addTokenUsage 缺失字段视为未测得不累加', () => {
    expect(addTokenUsage(emptyTokenUsage(), { outputTokens: 42 }))
      .toEqual({ inputTokens: 0, outputTokens: 42, cacheReadTokens: 0, cacheCreationTokens: 0 })
  })

  it('mergeModelUsages 跨模型求和（修复只取 [0]）', () => {
    const merged = mergeModelUsages([
      { model: 'a', inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1 },
      { model: 'b', inputTokens: 10, outputTokens: 10, cacheReadTokens: 10, cacheCreationTokens: 10 },
    ])
    expect(merged).toEqual({ inputTokens: 11, outputTokens: 11, cacheReadTokens: 11, cacheCreationTokens: 11 })
  })
})
