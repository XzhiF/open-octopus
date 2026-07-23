'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Trash2 } from 'lucide-react'

interface Agent {
  id: string
  displayName: string
  description: string
  handlesIntents: string[]
  isBuiltin: boolean
  deletable: boolean
}

export function AgentListPanel() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchAgents()
  }, [])

  async function fetchAgents() {
    try {
      const res = await fetch('/api/agent/agents')
      if (!res.ok) throw new Error('Failed to fetch agents')
      const data = await res.json()
      setAgents(data.items || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(agentId: string) {
    if (!confirm(`确定要删除 Agent "${agentId}" 吗？`)) return

    try {
      const res = await fetch(`/api/agent/agents/${agentId}`, { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.message || 'Delete failed')
      }
      setAgents(agents.filter(a => a.id !== agentId))
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  if (loading) {
    return <div className="p-4">Loading agents...</div>
  }

  if (error) {
    return <div className="p-4 text-red-500">Error: {error}</div>
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {agents.map(agent => (
        <Card key={agent.id}>
          <CardHeader>
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="text-lg">{agent.displayName}</CardTitle>
                <CardDescription className="mt-1">{agent.description}</CardDescription>
              </div>
              {agent.isBuiltin && (
                <Badge variant="secondary" className="ml-2">
                  系统内置
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="mb-3">
              <div className="text-sm text-muted-foreground mb-1">处理意图:</div>
              <div className="flex flex-wrap gap-1">
                {agent.handlesIntents.map(intent => (
                  <Badge key={intent} variant="outline" className="text-xs">
                    {intent}
                  </Badge>
                ))}
              </div>
            </div>
            <Button
              variant="destructive"
              size="sm"
              disabled={!agent.deletable}
              onClick={() => handleDelete(agent.id)}
              className="w-full"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {agent.deletable ? '删除' : '不可删除'}
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
