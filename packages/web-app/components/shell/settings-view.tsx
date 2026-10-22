'use client'

import dynamic from 'next/dynamic'

const SettingsLayout = dynamic(() => import('@/app/settings/layout'), { ssr: false })
const LogAnalysisPanel = dynamic(
  () => import('@/components/settings/log-analysis/log-analysis-panel').then((m) => m.LogAnalysisPanel),
  { ssr: false },
)

export function SettingsView() {
  return (
    <SettingsLayout>
      <LogAnalysisPanel />
    </SettingsLayout>
  )
}