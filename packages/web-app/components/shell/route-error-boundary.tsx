'use client'

import React, { type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class RouteErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[shell] route render failed', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-sm font-black text-pop-ink">这个视图加载失败了</div>
        <pre className="max-w-xl overflow-x-auto rounded-lg border-[1.5px] border-pop-bd bg-pop-inset p-3 text-left font-mono text-[11px] text-pop-dim">
          {this.state.error.message}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg border-[1.5px] border-pop-bd bg-pop-yellow px-3 py-1.5 text-xs font-black text-pop-bg"
        >
          重新加载
        </button>
      </div>
    )
  }
}
