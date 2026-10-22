// packages/server/src/routes/agent/composer-options.ts
//
// Composer 模型选项解析：Claude Agent SDK 的 effort 直接透传；1M 上下文通过
// 模型 ID 的 `[1m]` 变体启用（官方文档：append the suffix to the model ID）。

import path from 'path'
import { loadModelAliasConfig, resolveModelAlias, type EffortLevel } from '@octopus/shared'

const COMPOSER_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type ComposerContext = '200k' | '1m'

export function parseComposerEffort(value: unknown): EffortLevel | undefined {
  return typeof value === 'string' && COMPOSER_EFFORTS.includes(value)
    ? value as EffortLevel
    : undefined
}

export function parseComposerContext(value: unknown): ComposerContext | undefined {
  return value === '200k' || value === '1m' ? value : undefined
}

/** context 缺省 → 原样保留（兼容配置里已带 `[1m]` 的模型）。 */
export function applyContextVariant(
  model: string | undefined,
  context: ComposerContext | undefined,
): string | undefined {
  if (!model || context === undefined) return model
  const base = model.replace(/\[\d+[mk]\]$/i, '')
  return context === '1m' ? `${base}[1m]` : base
}

/**
 * UI 的 pro-max / pro / se 是别名，Claude SDK/网关只认真实模型 ID。
 * 先按 models.yaml（org 覆盖 → 全局）解析别名，再拼上下文变体。
 */
export function resolveChatModel(
  model: string | undefined,
  context: ComposerContext | undefined,
  org?: string,
): string | undefined {
  if (!model) return model
  try {
    const orgDir = org
      ? path.join(process.env.HOME ?? '~', '.octopus', 'orgs', org)
      : undefined
    const cfg = loadModelAliasConfig(orgDir ? { orgDir } : undefined)
    const resolved = resolveModelAlias(model, 'claude', cfg) ?? model
    return applyContextVariant(resolved, context)
  } catch {
    return applyContextVariant(model, context)
  }
}
