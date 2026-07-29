'use client'

import { useState, useEffect } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { fetchModelConfig } from '@/lib/model-config-api'

interface ModelSelectorProps {
  value: string // format: "engine/alias" e.g. "claude/pro"
  onChange: (value: string) => void
}

interface ProviderMap {
  [engine: string]: {
    [alias: string]: string
  }
}

function parseProvidersFromYaml(yamlContent: string): ProviderMap {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jsYaml = require('js-yaml') as { load: (s: string) => unknown }
    const parsed = jsYaml.load(yamlContent) as { providers?: ProviderMap } | null
    return parsed?.providers ?? {}
  } catch {
    return {}
  }
}

export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const [providers, setProviders] = useState<ProviderMap>({})
  const [loadError, setLoadError] = useState<string | null>(null)

  // Parse current value into engine + alias
  const [engine, alias] = value.includes('/')
    ? value.split('/')
    : ['claude', 'pro']

  // Fetch models.yaml on mount
  useEffect(() => {
    fetchModelConfig()
      .then((res) => {
        const parsed = parseProvidersFromYaml(res.content)
        setProviders(parsed)
        setLoadError(null)
      })
      .catch((err: Error) => {
        setLoadError(err.message)
      })
  }, [])

  const engines = Object.keys(providers)
  const models = engine && providers[engine] ? Object.keys(providers[engine]) : []

  const handleEngineChange = (newEngine: string) => {
    const firstAlias = providers[newEngine] ? Object.keys(providers[newEngine])[0] : ''
    onChange(`${newEngine}/${firstAlias}`)
  }

  const handleAliasChange = (newAlias: string) => {
    onChange(`${engine}/${newAlias}`)
  }

  if (loadError) {
    return (
      <div>
        <Label>模型</Label>
        <p className="text-xs text-agent-error mt-1">加载模型列表失败: {loadError}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div>
        <Label>Engine (Provider)</Label>
        <Select value={engine} onValueChange={handleEngineChange}>
          <SelectTrigger className="mt-1 bg-agent-surface-inset border-agent-divider">
            <SelectValue placeholder="选择引擎" />
          </SelectTrigger>
          <SelectContent>
            {engines.map((e) => (
              <SelectItem key={e} value={e}>{e}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label>Model (Alias)</Label>
        <Select value={alias} onValueChange={handleAliasChange}>
          <SelectTrigger className="mt-1 bg-agent-surface-inset border-agent-divider">
            <SelectValue placeholder="选择模型" />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
