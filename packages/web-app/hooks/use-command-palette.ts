import { useState, useEffect } from "react"
import { getServerUrl } from "@/lib/server-config"

export function useCommandPaletteData(workspaceId: string) {
  const [workflows, setWorkflows] = useState<Array<{ ref: string; name: string }>>([])
  const [executions, setExecutions] = useState<Array<{ id: string; workflowName: string; status: string }>>([])

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false

    fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/workflows`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setWorkflows(d.workflows ?? d ?? []) })
      .catch(() => {})

    fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions`)
      .then(r => r.json())
      .then(d => {
        if (!cancelled) {
          const list = d.executions ?? d ?? []
          setExecutions(list.map((e: any) => ({
            id: e.id,
            workflowName: e.workflow_name || e.workflow_ref || '',
            status: e.status,
          })))
        }
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [workspaceId])

  return { workflows, executions }
}
