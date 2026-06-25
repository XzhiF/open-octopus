'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'
import type { AgentConfig } from '@/lib/agent/types'
import { ConfigSection } from './ConfigSection'

interface NotificationConfigProps {
  config: (AgentConfig & { config_degraded: boolean }) | null
  onSave: (data: Partial<AgentConfig>) => Promise<boolean>
  saving: boolean
}

const TIMEZONES = [
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'America/New_York',
  'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'UTC',
]

export function NotificationConfig({ config, onSave, saving }: NotificationConfigProps) {
  const [provider, setProvider] = useState(config?.notification?.provider ?? 'hermes-cli')
  const [target, setTarget] = useState(config?.notification?.target ?? '')
  const [timezone, setTimezone] = useState(config?.notification?.timezone ?? 'Asia/Shanghai')

  const handleSave = async () => {
    const ok = await onSave({
      notification: { provider, target, timezone },
    })
    if (ok) toast.success('通知配置已保存')
  }

  return (
    <ConfigSection
      title="通知渠道"
      description="配置 Agent 通过 hermes 发送通知的渠道。"
      saving={saving}
      onSave={handleSave}
    >
      <div className="space-y-3">
        <div>
          <Label>Provider</Label>
          <Input
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="mt-1 bg-agent-surface-inset border-agent-divider"
          />
        </div>
        <div>
          <Label>通知目标</Label>
          <Input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="telegram:your_chat_id"
            className="mt-1 bg-agent-surface-inset border-agent-divider"
          />
        </div>
        <div>
          <Label>时区</Label>
          <Select value={timezone} onValueChange={setTimezone}>
            <SelectTrigger className="mt-1 bg-agent-surface-inset border-agent-divider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIMEZONES.map((tz) => (
                <SelectItem key={tz} value={tz}>{tz}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </ConfigSection>
  )
}
