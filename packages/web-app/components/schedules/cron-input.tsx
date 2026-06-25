"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CronPreview } from "./cron-preview"

interface Props {
  value: string
  onChange: (value: string) => void
  timezone: string
}

export function CronInput({ value, onChange, timezone }: Props) {
  return (
    <div className="space-y-2">
      <Label htmlFor="cron-expression">Cron Expression</Label>
      <Input
        id="cron-expression"
        placeholder="*/30 * * * *"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <CronPreview expression={value} timezone={timezone} />
    </div>
  )
}
