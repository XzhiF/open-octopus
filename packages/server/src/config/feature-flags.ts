export interface ObservabilityFlags {
  agent_events_persist: boolean
  // llm_calls_persist 已退役（billing NEW-r2）：llm_calls 是 workflow 账的唯一事实源，
  // 落账不再可被 flag 关闭。旧配置键读到时按未知键忽略。
  timeline_tab: boolean
  cost_tab: boolean
  dag_cost_line: boolean
  dashboard_v2: boolean
  analytics_api: boolean
  command_palette: boolean
  suggestions: boolean
  alerting: boolean
  scheduler: boolean
  scheduler_nl_cron: boolean
  privacy: {
    level: 'minimal' | 'standard' | 'full'
    max_content_length: number
    max_tool_result_length: number
    redact_secrets: boolean
  }
}

const DEFAULT_FLAGS: ObservabilityFlags = {
  agent_events_persist: true,
  timeline_tab: true,
  cost_tab: true,
  dag_cost_line: true,
  dashboard_v2: false,
  analytics_api: false,
  command_palette: false,
  suggestions: false,
  alerting: false,
  scheduler: true,
  scheduler_nl_cron: true,
  privacy: {
    level: 'standard',
    max_content_length: 500,
    max_tool_result_length: 2000,
    redact_secrets: true,
  },
}

let _flags: ObservabilityFlags | null = null

export function loadFeatureFlags(configPath?: string): ObservabilityFlags {
  if (_flags) return _flags

  let flags = { ...DEFAULT_FLAGS }

  if (configPath) {
    try {
      const fs = require('fs')
      const path = require('path')
      const configStr = fs.readFileSync(configPath, 'utf-8')
      const yaml = parseSimpleYaml(configStr)
      if (yaml.observability) {
        flags = mergeFlags(flags, yaml.observability as Record<string, unknown>)
      }
    } catch {
      // config file not found or invalid — use defaults
    }
  }

  // Skip env override in test mode to prevent test pollution (B7 fix)
  if (process.env.NODE_ENV !== 'test') {
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('OCTOPUS_FF_')) {
        const flagKey = key.replace('OCTOPUS_FF_', '').toLowerCase()
        const typedKey = flagKey as keyof ObservabilityFlags
        if (flagKey === 'privacy') continue
        if (typeof (flags as Record<string, unknown>)[typedKey] !== 'boolean') continue
        // 动态写布尔槽位经 unknown 视图（privacy 为嵌套对象，直转 Record<string,boolean> 不重叠）
        if (value === 'true') (flags as Record<string, unknown>)[typedKey] = true
        else if (value === 'false') (flags as Record<string, unknown>)[typedKey] = false
      }
    }
  }

  _flags = flags
  return flags
}

export function getFlag<K extends keyof ObservabilityFlags>(key: K): ObservabilityFlags[K] {
  const flags = _flags ?? loadFeatureFlags()
  return flags[key]
}

export function resetFeatureFlags(): void {
  _flags = null
}

function mergeFlags(base: ObservabilityFlags, overrides: Record<string, unknown>): ObservabilityFlags {
  const result = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'privacy' && typeof value === 'object' && value) {
      result.privacy = { ...result.privacy, ...(value as Record<string, unknown>) } as ObservabilityFlags['privacy']
    } else if (typeof value === 'boolean') {
      // 同上：嵌套 privacy 使字面量直转不重叠，经 unknown 视图写槽位。
      (result as Record<string, unknown>)[key] = value
    }
  }
  return result
}

function parseSimpleYaml(input: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  let currentSection: string | null = null
  let currentSectionObj: Record<string, unknown> = {}

  for (const line of input.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      if (trimmed.endsWith(':')) {
        currentSection = trimmed.slice(0, -1)
        currentSectionObj = {}
        result[currentSection] = currentSectionObj
      } else {
        const [key, ...rest] = trimmed.split(':')
        result[key.trim()] = parseValue(rest.join(':').trim())
        currentSection = null
      }
    } else if (currentSection && currentSectionObj) {
      const [key, ...rest] = trimmed.split(':')
      currentSectionObj[key.trim()] = parseValue(rest.join(':').trim())
    }
  }

  return result
}

function parseValue(val: string): unknown {
  if (val === 'true') return true
  if (val === 'false') return false
  if (/^-?\d+$/.test(val)) return parseInt(val, 10)
  if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val)
  return val
}
