"use client"

import { ScrollArea } from "@/components/ui/scroll-area"
import { Bug, Wrench, DollarSign, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"

interface Lesson {
  id: string
  type: string
  title: string
  content: string
  relevance_score: number
}

interface LessonsPanelProps {
  lessons: string | null
  experiences: Lesson[]
}

const typeIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  bug: Bug,
  pattern: Wrench,
  cost: DollarSign,
  failure: AlertTriangle,
}

const typeColors: Record<string, string> = {
  bug: "text-memory-exp-bug",
  pattern: "text-memory-exp-pattern",
  cost: "text-memory-exp-cost",
  failure: "text-memory-exp-failure",
}

export function LessonsPanel({ lessons, experiences }: LessonsPanelProps) {
  const hasContent = lessons || (experiences && experiences.length > 0)

  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="text-sm font-medium mb-3">经验教训</h3>

      {!hasContent && (
        <p className="text-sm text-muted-foreground">
          暂无经验教训（经验提取可能仍在进行中）
        </p>
      )}

      {lessons && (
        <div className="mb-4 text-sm whitespace-pre-wrap leading-relaxed">
          {lessons}
        </div>
      )}

      {experiences && experiences.length > 0 && (
        <ScrollArea className="max-h-[300px]">
          <div className="space-y-2">
            {experiences.map((exp) => {
              const Icon = typeIcons[exp.type] ?? Wrench
              return (
                <div key={exp.id} className="rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <Icon
                      className={cn("h-4 w-4", typeColors[exp.type])}
                    />
                    <span className="text-sm font-medium">{exp.title}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {exp.content}
                  </p>
                </div>
              )
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
