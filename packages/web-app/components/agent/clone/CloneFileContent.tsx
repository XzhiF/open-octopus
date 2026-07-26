'use client'

import { useState, useEffect } from 'react'
import { Lock, Save, Eye, Edit } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getCloneFile, updateCloneFile } from '@/lib/agent/api'
import type { FileInfo } from '@/lib/agent/types'

interface CloneFileContentProps {
  cloneName: string
  file: FileInfo | null
  onSaved?: () => void
}

export function CloneFileContent({ cloneName, file, onSaved }: CloneFileContentProps) {
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [saveMessage, setSaveMessage] = useState('')

  useEffect(() => {
    if (!file) {
      setContent('')
      setOriginalContent('')
      return
    }

    setLoading(true)
    getCloneFile(cloneName, file.path)
      .then((res) => {
        setContent(res.content)
        setOriginalContent(res.content)
      })
      .catch(() => {
        setContent('')
        setOriginalContent('')
      })
      .finally(() => setLoading(false))
  }, [cloneName, file])

  const isDirty = content !== originalContent
  const isMarkdown = file?.name.endsWith('.md')
  const isJson = file?.name.endsWith('.json')

  const handleSave = async () => {
    if (!file || file.readonly) return

    setSaving(true)
    try {
      await updateCloneFile(cloneName, file.path, { content })
      setOriginalContent(content)
      setSaveMessage('已保存')
      setTimeout(() => setSaveMessage(''), 2000)
      onSaved?.()
    } catch {
      setSaveMessage('保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (!file) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        选择文件以查看内容
      </div>
    )
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        加载中...
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-agent-divider bg-agent-surface-raised">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{file.path}</span>
          {file.readonly && (
            <span className="flex items-center gap-1 px-2 py-0.5 text-xs bg-agent-warning-light text-agent-warning rounded">
              <Lock className="h-3 w-3" />
              只读
            </span>
          )}
          {saveMessage && (
            <span className="text-xs text-agent-success">{saveMessage}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isMarkdown && !file.readonly && (
            <div className="flex border border-agent-divider rounded overflow-hidden">
              <button
                className={`px-2 py-1 text-xs ${mode === 'edit' ? 'bg-agent-primary text-white' : 'hover:bg-agent-hover'}`}
                onClick={() => setMode('edit')}
              >
                <Edit className="h-3 w-3" />
              </button>
              <button
                className={`px-2 py-1 text-xs ${mode === 'preview' ? 'bg-agent-primary text-white' : 'hover:bg-agent-hover'}`}
                onClick={() => setMode('preview')}
              >
                <Eye className="h-3 w-3" />
              </button>
            </div>
          )}
          <Button
            size="sm"
            disabled={!isDirty || file.readonly || saving}
            onClick={handleSave}
          >
            <Save className="h-3 w-3 mr-1" />
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {isMarkdown && mode === 'preview' ? (
          <div
            className="p-4 prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
          />
        ) : (
          <textarea
            className={`w-full h-full p-4 font-mono text-sm bg-transparent resize-none focus:outline-none ${
              isJson ? 'text-yellow-500' : ''
            } ${file.readonly ? 'opacity-60' : ''}`}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            readOnly={file.readonly}
          />
        )}
      </div>
    </div>
  )
}

// Simple markdown renderer (replace with proper library if needed)
function renderMarkdown(md: string): string {
  return md
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>')
}
