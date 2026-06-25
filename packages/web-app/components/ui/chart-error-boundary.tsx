"use client"

import { Component, type ReactNode } from "react"
import { AlertTriangle } from "lucide-react"

interface Props {
  children: ReactNode
  fallback?: ReactNode
  componentName?: string
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ChartErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
          <AlertTriangle className="h-6 w-6 text-amber-500" />
          <p className="text-sm font-medium">图表渲染失败</p>
          <p className="text-xs text-muted-foreground">{this.state.error?.message}</p>
        </div>
      )
    }

    return this.props.children
  }
}
