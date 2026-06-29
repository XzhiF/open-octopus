"use client"

import { Bug, Lightbulb, DollarSign, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

interface Experience {
  id: string
  type: string
  title: string
  content: string
  status: string
  created_at: string
}

interface LessonsPanelProps {
  lessons: string | null
  experiences: Experience[]
}

function typeIcon(type: string) {
  switch (type) {
    case "bug":
      return <Bug className="h-3.5 w-3.5" />
    case "pattern":
      return <Lightbulb className="h-3.5 w-3.5" />
    case "cost":
      return <DollarSign className="h-3.5 w-3.5" />
    case "failure":
      return <AlertTriangle className="h-3.5 w-3.5" />
    default:
      return null
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "active":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
    case "archived":
      return "bg-muted text-muted-foreground"
    default:
      return "bg-muted text-muted-foreground"
  }
}

function formatRelativeDate(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))

  if (diffHours < 1) return "刚刚"
  if (diffHours < 24) return `${diffHours} 小时前`
  if (diffHours < 48) return "1 天前"
  if (diffHours < 24 * 30) return `${Math.floor(diffHours / 24)} 天前`

  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${month}-${day}`
}

export function LessonsPanel({ lessons, experiences }: LessonsPanelProps) {
  if (!lessons && experiences.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>经验教训</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-center text-sm">
            暂无经验教训
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>经验教训</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Lessons text */}
        {lessons && (
          <div className="max-h-[300px] overflow-y-auto rounded-md bg-muted/50 p-4">
            <p className="text-sm whitespace-pre-wrap">{lessons}</p>
          </div>
        )}

        {/* Experiences list */}
        {experiences.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-medium">相关经验</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {experiences.map((exp) => (
                <div
                  key={exp.id}
                  className="rounded-lg border p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="text-muted-foreground flex items-center gap-1.5">
                      {typeIcon(exp.type)}
                      <Badge variant="outline" className="text-xs">
                        {exp.type}
                      </Badge>
                    </div>
                    <Badge
                      variant="secondary"
                      className={cn("text-xs", statusColor(exp.status))}
                    >
                      {exp.status}
                    </Badge>
                  </div>
                  <p className="text-sm font-medium leading-tight">
                    {exp.title}
                  </p>
                  <p className="text-muted-foreground line-clamp-2 text-xs">
                    {exp.content}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {formatRelativeDate(exp.created_at)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
