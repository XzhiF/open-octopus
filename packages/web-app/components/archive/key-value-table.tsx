"use client"

interface KeyValueTableProps {
  data: Record<string, unknown>
}

export function KeyValueTable({ data }: KeyValueTableProps) {
  const entries = Object.entries(data ?? {})

  if (entries.length === 0) return null

  return (
    <div className="rounded-lg border bg-card h-full">
      <div className="p-4 border-b">
        <h3 className="text-sm font-medium">关键变量</h3>
      </div>
      <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card">
            <tr className="border-b bg-muted/50">
              <th className="text-left font-medium p-3">键</th>
              <th className="text-left font-medium p-3">值</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key} className="border-b last:border-b-0">
                <td className="p-3 font-mono text-xs whitespace-nowrap">
                  {key}
                </td>
                <td className="p-3 text-xs break-all max-w-md">
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
