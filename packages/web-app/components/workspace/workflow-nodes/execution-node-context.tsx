"use client"

import { createContext, useContext } from "react"

interface TreeCallbacks {
  onDetail?: (nodeId: string) => void
  onExecute?: (nodeId: string) => void
  onRetry?: (nodeId: string) => void
  onSkip?: (nodeId: string) => void
  onTerminate?: (nodeId: string) => void
  onDelete?: (nodeId: string) => void
  onApprove?: (nodeId: string) => void
  onPause?: (nodeId: string) => void
  onResume?: (nodeId: string) => void
  isPausing?: (nodeId: string) => boolean
}

const ExecutionNodeContext = createContext<TreeCallbacks | null>(null)

export function ExecutionNodeProvider({ callbacks, children }: {
  callbacks: TreeCallbacks
  children: React.ReactNode
}) {
  return (
    <ExecutionNodeContext.Provider value={callbacks}>
      {children}
    </ExecutionNodeContext.Provider>
  )
}

export function useExecutionNodeCallbacks(): TreeCallbacks {
  const ctx = useContext(ExecutionNodeContext)
  if (!ctx) throw new Error("useExecutionNodeCallbacks must be used within ExecutionNodeProvider")
  return ctx
}