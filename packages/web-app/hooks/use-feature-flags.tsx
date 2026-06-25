"use client"

import { createContext, useContext, useState, useEffect, type ReactNode } from "react"
import { getServerUrl } from "@/lib/server-config"

interface FeatureFlags {
  agent_events_persist: boolean
  llm_calls_persist: boolean
  timeline_tab: boolean
  cost_tab: boolean
  dag_cost_line: boolean
  dashboard_v2: boolean
  analytics_api: boolean
  command_palette: boolean
  suggestions: boolean
  alerting: boolean
}

interface FeatureFlagsContextType {
  flags: FeatureFlags
  loading: boolean
  isEnabled: (key: keyof FeatureFlags) => boolean
}

const FeatureFlagsContext = createContext<FeatureFlagsContextType>({
  flags: {} as FeatureFlags,
  loading: true,
  isEnabled: () => false,
})

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const [flags, setFlags] = useState<FeatureFlags>({} as FeatureFlags)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch(`${getServerUrl()}/api/feature-flags`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setFlags(d.data ?? {}) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const isEnabled = (key: keyof FeatureFlags) => flags[key] ?? false

  return (
    <FeatureFlagsContext.Provider value={{ flags, loading, isEnabled }}>
      {children}
    </FeatureFlagsContext.Provider>
  )
}

export function useFeatureFlags() {
  return useContext(FeatureFlagsContext)
}
