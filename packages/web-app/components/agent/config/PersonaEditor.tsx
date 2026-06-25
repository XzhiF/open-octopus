'use client'

import { useState, useEffect } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import * as api from '@/lib/agent/api'
import { ConfigSection } from './ConfigSection'

interface PersonaEditorProps {
  onSave: (content: string) => Promise<boolean>
  saving: boolean
}

export function PersonaEditor({ onSave, saving }: PersonaEditorProps) {
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    api.getPersona().then((res) => {
      setContent(res.content)
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [])

  const handleSave = async () => {
    const ok = await onSave(content)
    if (ok) toast.success('人格设定已更新')
  }

  return (
    <ConfigSection
      title="人格设定"
      description="定义 Agent 的性格和行为方式。建议 2000 字符以内。"
      saving={saving}
      onSave={handleSave}
    >
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="min-h-[200px] font-mono text-sm bg-agent-surface-inset border-agent-divider focus-visible:ring-agent-primary"
        placeholder="你是一个专业的开发助手..."
      />
      <p className="text-xs text-muted-foreground">
        字符: {content.length} / 2000
        {content.length > 2000 && (
          <span className="text-agent-error ml-2">超预算，注入时会被截取</span>
        )}
      </p>
    </ConfigSection>
  )
}
