'use client'

import { lazy, Suspense } from 'react'

function ViewLoading() {
  return (
    <div className="flex h-full items-center justify-center font-mono text-[11px] text-pop-dim">
      加载视图…
    </div>
  )
}

const SettingsLayout = lazy(() => import('@/app/settings/layout'))
const AppearancePanel = lazy(() =>
  import('@/components/settings/appearance-panel').then((m) => ({
    default: m.AppearancePanel,
  })),
)
const LogAnalysisPanel = lazy(() =>
  import('@/components/settings/log-analysis/log-analysis-panel').then((m) => ({
    default: m.LogAnalysisPanel,
  })),
)

export function SettingsView() {
  return (
    <Suspense fallback={<ViewLoading />}>
      <SettingsLayout
        panels={{
          appearance: (
            <Suspense fallback={<ViewLoading />}>
              <AppearancePanel />
            </Suspense>
          ),
          'log-analysis': (
            <Suspense fallback={<ViewLoading />}>
              <LogAnalysisPanel />
            </Suspense>
          ),
        }}
      />
    </Suspense>
  )
}
