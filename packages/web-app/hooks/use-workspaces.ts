"use client"

import { useState, useEffect } from "react"
import { listWorkspaces } from "@/lib/api-client"

interface WorkspaceOption {
  id: string
  name: string
}

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([])
  const [selectedId, setSelectedId] = useState<string>("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listWorkspaces()
      .then((ws: WorkspaceOption[]) => {
        setWorkspaces(ws)
        if (ws.length > 0 && !selectedId) {
          setSelectedId(ws[0].id)
        }
      })
      .catch(() => setWorkspaces([]))
      .finally(() => setLoading(false))
  }, [selectedId])

  return { workspaces, selectedId, setSelectedId, loading }
}
