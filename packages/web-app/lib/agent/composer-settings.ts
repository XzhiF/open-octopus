import type { EffortLevel } from '@octopus/shared'

/** Composer 可调的思考强度（Claude Agent SDK effort；xhigh 暂不进 UI）。 */
export type ComposerEffort = Extract<EffortLevel, 'low' | 'medium' | 'high' | 'max'>

/** 最大上下文两档：默认窗口 / 1M 模型变体（模型名后缀 `[1m]`）。 */
export type ComposerContext = '200k' | '1m'

export interface ModelPreset {
  effort: ComposerEffort
  context: ComposerContext
}

export const COMPOSER_EFFORT_OPTIONS: Array<{ id: ComposerEffort; label: string }> = [
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'max', label: '最大' },
]

export const COMPOSER_CONTEXT_OPTIONS: Array<{ id: ComposerContext; label: string; hint: string }> = [
  { id: '200k', label: '200K', hint: '默认窗口' },
  { id: '1m', label: '1M', hint: '模型变体 [1m]' },
]

/** 每个模型自己的默认预设（可在弹层里逐模型改动并本机记忆）。 */
export const DEFAULT_MODEL_PRESETS: Record<string, ModelPreset> = {
  'pro-max': { effort: 'high', context: '1m' },
  pro: { effort: 'high', context: '200k' },
  se: { effort: 'low', context: '200k' },
}

export const FALLBACK_MODEL_PRESET: ModelPreset = { effort: 'high', context: '200k' }

export function modelPreset(
  model: string,
  presets: Record<string, ModelPreset> | undefined,
): ModelPreset {
  return presets?.[model] ?? DEFAULT_MODEL_PRESETS[model] ?? FALLBACK_MODEL_PRESET
}

export function effortLabel(effort: ComposerEffort): string {
  return COMPOSER_EFFORT_OPTIONS.find((option) => option.id === effort)?.label ?? effort
}

export function contextLabel(context: ComposerContext): string {
  return context === '1m' ? '1M' : '200K'
}
