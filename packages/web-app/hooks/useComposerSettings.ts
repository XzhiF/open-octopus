'use client'

// Composer 模型/思考强度/上下文的本地记忆。
// v2：每个模型各自一套 preset（effort + context），切换模型不会串味。
// localStorage 只在客户端 effect 里读，避免 SSR/水合不一致。

import { useEffect, useState } from 'react'
import {
  COMPOSER_CONTEXT_OPTIONS,
  COMPOSER_EFFORT_OPTIONS,
  DEFAULT_MODEL_PRESETS,
  FALLBACK_MODEL_PRESET,
  modelPreset,
  type ComposerContext,
  type ComposerEffort,
  type ModelPreset,
} from '@/lib/agent/composer-settings'

const STORAGE_KEY = 'octopus.composer.settings.v2'
const LEGACY_KEY = 'octopus.composer.settings.v1'

interface SettingsState {
  model: string
  presets: Record<string, ModelPreset>
}

const DEFAULT_STATE: SettingsState = {
  model: 'pro',
  presets: { ...DEFAULT_MODEL_PRESETS },
}

function isEffort(value: unknown): value is ComposerEffort {
  return COMPOSER_EFFORT_OPTIONS.some((option) => option.id === value)
}

function isContext(value: unknown): value is ComposerContext {
  return COMPOSER_CONTEXT_OPTIONS.some((option) => option.id === value)
}

function normalizePreset(raw: unknown, fallback: ModelPreset): ModelPreset {
  const candidate = raw && typeof raw === 'object' ? raw as Partial<ModelPreset> : {}
  return {
    effort: isEffort(candidate.effort) ? candidate.effort : fallback.effort,
    context: isContext(candidate.context) ? candidate.context : fallback.context,
  }
}

function readState(): SettingsState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SettingsState>
      const presets: Record<string, ModelPreset> = { ...DEFAULT_MODEL_PRESETS }
      if (parsed.presets && typeof parsed.presets === 'object') {
        for (const [model, preset] of Object.entries(parsed.presets)) {
          presets[model] = normalizePreset(preset, modelPreset(model, presets))
        }
      }
      return {
        model: typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULT_STATE.model,
        presets,
      }
    }

    // v1 单套设置 → 迁移到当前模型名下；其他模型用各自默认。
    const legacyRaw = window.localStorage.getItem(LEGACY_KEY)
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as { model?: unknown; effort?: unknown; context?: unknown }
      const model = typeof legacy.model === 'string' && legacy.model ? legacy.model : DEFAULT_STATE.model
      const fallback = modelPreset(model, DEFAULT_MODEL_PRESETS)
      return {
        model,
        presets: {
          ...DEFAULT_MODEL_PRESETS,
          [model]: {
            effort: isEffort(legacy.effort) ? legacy.effort : fallback.effort,
            context: isContext(legacy.context) ? legacy.context : fallback.context,
          },
        },
      }
    }
  } catch {
    /* storage unavailable / corrupt → defaults */
  }
  return DEFAULT_STATE
}

export function useComposerSettings() {
  const [state, setState] = useState<SettingsState>(DEFAULT_STATE)

  useEffect(() => {
    setState(readState())
  }, [])

  const commit = (next: SettingsState) => {
    setState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* storage unavailable */
    }
  }

  const current = modelPreset(state.model, state.presets)

  return {
    model: state.model,
    effort: current.effort,
    context: current.context,
    presets: state.presets,
    setModel: (model: string) => commit({ ...state, model }),
    setEffort: (effort: ComposerEffort) => commit({
      ...state,
      presets: { ...state.presets, [state.model]: { ...current, effort } },
    }),
    setContext: (context: ComposerContext) => commit({
      ...state,
      presets: { ...state.presets, [state.model]: { ...current, context } },
    }),
  }
}
