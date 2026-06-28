"use client"

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"

interface KeyValueTableProps {
  vars: Record<string, unknown>
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "-"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean")
    return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function KeyValueTable({ vars }: KeyValueTableProps) {
  const entries = Object.entries(vars)

  if (entries.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>变量快照</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {entries.map(([key, value]) => {
            const formatted = formatValue(value)
            const isLong = formatted.length > 60
            return (
              <div
                key={key}
                className="grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-1 py-1.5 text-sm [&:not(:last-child)]:border-b"
              >
                <span className="font-mono text-xs text-muted-foreground truncate max-w-[200px]">
                  {key}
                </span>
                <span
                  className={
                    isLong
                      ? "font-mono text-xs whitespace-pre-wrap break-all"
                      : "font-mono text-xs truncate"
                  }
                >
                  {formatted}
                </span>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
