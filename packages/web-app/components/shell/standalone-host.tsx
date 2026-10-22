'use client'

import { Suspense } from 'react'
import type { StandaloneRoute } from '@/lib/routes'
import { STANDALONE_COMPONENTS } from '@/lib/route-components'
import { RouteErrorBoundary } from './route-error-boundary'

export function StandaloneHost({ route }: { route: StandaloneRoute }) {
  const Component = STANDALONE_COMPONENTS[route.componentKey]
  return (
    <div className="absolute inset-0 overflow-y-auto" data-testid="standalone-host">
      <RouteErrorBoundary>
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center font-mono text-[11px] text-pop-dim">
              加载视图…
            </div>
          }
        >
          {Component ? <Component /> : null}
        </Suspense>
      </RouteErrorBoundary>
    </div>
  )
}
