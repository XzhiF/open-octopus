"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Archive, TrendingUp, DollarSign, Clock, CheckCircle2, FileText, Package } from "lucide-react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { toast } from "sonner"

interface ArchiveDetail {
  workspace_id: string
  org: string
  name: string
  description: string | null
  execution_count: number
  total_cost: number
  total_duration_ms: number
  archived_at: string
  extracted_experiences: number
  extracted_skills: number
  analysis_report: string | null
  file_deleted: number
}

export default function ArchiveDetailPage() {
  const params = useParams()
  const workspaceId = params.id as string
  const [archive, setArchive] = useState<ArchiveDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchArchive() {
      try {
        const res = await fetch(`/api/archive/workspaces/${workspaceId}`)
        if (!res.ok) throw new Error("Failed to fetch archive details")
        const data = await res.json()
        setArchive(data)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load archive details")
      } finally {
        setLoading(false)
      }
    }
    fetchArchive()
  }, [workspaceId])

  if (loading) {
    return (
      <div className="container mx-auto py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-muted rounded w-1/3"></div>
          <div className="h-4 bg-muted rounded w-2/3"></div>
          <div className="grid grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-32 bg-muted rounded"></div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (!archive) {
    return (
      <div className="container mx-auto py-8">
        <div className="text-center">
          <h2 className="text-2xl font-bold">Archive Not Found</h2>
          <p className="text-muted-foreground mt-2">The archived workspace you're looking for doesn't exist.</p>
          <Button asChild className="mt-4">
            <Link href="/workspaces">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Workspaces
            </Link>
          </Button>
        </div>
      </div>
    )
  }

  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    if (hours > 0) return `${hours}h ${minutes % 60}m`
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`
    return `${seconds}s`
  }

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  let analysisReport = null
  if (archive.analysis_report) {
    try {
      analysisReport = JSON.parse(archive.analysis_report)
    } catch (err) {
      console.warn("Failed to parse analysis report:", err)
    }
  }

  return (
    <div className="container mx-auto py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/workspaces?view=archived">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Link>
            </Button>
            <Badge variant="secondary">
              <Archive className="mr-1 h-3 w-3" />
              Archived
            </Badge>
            {archive.file_deleted === 1 && (
              <Badge variant="outline">Files Deleted</Badge>
            )}
          </div>
          <h1 className="text-3xl font-bold">{archive.name}</h1>
          {archive.description && (
            <p className="text-muted-foreground mt-1">{archive.description}</p>
          )}
          <p className="text-sm text-muted-foreground mt-2">
            Archived on {formatDate(archive.archived_at)}
          </p>
        </div>
      </div>

      {/* Statistics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Executions</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{archive.execution_count}</div>
            <p className="text-xs text-muted-foreground">Total executions</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Cost</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${archive.total_cost.toFixed(2)}</div>
            <p className="text-xs text-muted-foreground">
              Avg ${(archive.total_cost / Math.max(archive.execution_count, 1)).toFixed(2)}/exec
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Duration</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatDuration(archive.total_duration_ms)}</div>
            <p className="text-xs text-muted-foreground">
              Avg {formatDuration(archive.total_duration_ms / Math.max(archive.execution_count, 1))}/exec
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Knowledge Extracted</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {archive.extracted_experiences + archive.extracted_skills}
            </div>
            <p className="text-xs text-muted-foreground">
              {archive.extracted_experiences} experiences, {archive.extracted_skills} skills
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Analysis Report */}
      {analysisReport && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Analysis Report
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {analysisReport.summary && (
              <div>
                <h3 className="font-semibold mb-2">Summary</h3>
                <p className="text-sm text-muted-foreground">{analysisReport.summary}</p>
              </div>
            )}

            {analysisReport.execution_patterns && analysisReport.execution_patterns.length > 0 && (
              <div>
                <h3 className="font-semibold mb-2">Execution Patterns</h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                  {analysisReport.execution_patterns.map((pattern: string, i: number) => (
                    <li key={i}>{pattern}</li>
                  ))}
                </ul>
              </div>
            )}

            {analysisReport.cost_efficiency && (
              <div>
                <h3 className="font-semibold mb-2">Cost Efficiency</h3>
                <p className="text-sm text-muted-foreground">{analysisReport.cost_efficiency}</p>
              </div>
            )}

            {analysisReport.error_patterns && analysisReport.error_patterns.length > 0 && (
              <div>
                <h3 className="font-semibold mb-2">Error Patterns</h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                  {analysisReport.error_patterns.map((pattern: string, i: number) => (
                    <li key={i}>{pattern}</li>
                  ))}
                </ul>
              </div>
            )}

            {analysisReport.recommendations && analysisReport.recommendations.length > 0 && (
              <div>
                <h3 className="font-semibold mb-2">Recommendations</h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
                  {analysisReport.recommendations.map((rec: string, i: number) => (
                    <li key={i}>{rec}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Extracted Knowledge */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Extracted Experiences
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold mb-2">{archive.extracted_experiences}</div>
            <p className="text-sm text-muted-foreground mb-4">
              Lessons learned from execution failures and patterns
            </p>
            {archive.extracted_experiences > 0 && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/knowledge?source=workspace:${workspaceId}`}>
                  View in Knowledge Base
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              Installed Skills
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold mb-2">{archive.extracted_skills}</div>
            <p className="text-sm text-muted-foreground mb-4">
              Reusable skills extracted from workspace workflows
            </p>
            {archive.extracted_skills > 0 && (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/resources?source=workspace:${workspaceId}`}>
                  View in Resources
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
