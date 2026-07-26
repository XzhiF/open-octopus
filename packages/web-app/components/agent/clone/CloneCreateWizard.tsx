'use client'

import { useState, useEffect, useCallback } from 'react'
import { Check, ChevronLeft, ChevronRight, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import * as api from '@/lib/agent/api'
import type { CreateCloneRequest, SkillInfo } from '@/lib/agent/types'

interface CloneCreateWizardProps {
  onClose: () => void
  onCreated: () => void
}

const STEPS = ['基本信息', '可选配置']

export function CloneCreateWizard({ onClose, onCreated }: CloneCreateWizardProps) {
  const [step, setStep] = useState(0)
  const [loading, setLoading] = useState(false)

  // Step 1: Required fields
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')

  // Step 2: Optional fields
  const [memoryScope, setMemoryScope] = useState<'shared' | 'isolated'>('isolated')

  // Load skills dynamically (kept for future use)
  // const loadSkills = useCallback(async () => {
  //   setSkillsLoading(true)
  //   try {
  //     const res = await api.listSkills()
  //     const skills = res.skills ?? res.items ?? []
  //     setAvailableSkills(skills)
  //   } catch {
  //     // Non-fatal — show empty list
  //   } finally {
  //     setSkillsLoading(false)
  //   }
  // }, [])

  // useEffect(() => {
  //   loadSkills()
  // }, [loadSkills])

  // Name validation
  const nameValid = /^[a-z0-9-]+$/.test(name) && name.length > 0 && name.length <= 50
  const canProceed = () => {
    if (step === 0) {
      return nameValid && displayName.trim().length > 0
    }
    return true
  }

  const handleCreate = async () => {
    setLoading(true)
    try {
      const req: CreateCloneRequest = {
        name: name.trim(),
        display_name: displayName.trim(),
        memory_scope: memoryScope,
      }
      await api.createClone(req)
      toast.success('分身创建成功！请在 Chat 中描述你希望这个分身具备的特质。')
      onCreated()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '创建失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>创建分身</DialogTitle>
        </DialogHeader>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-6">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center gap-2 flex-1">
              <div className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium transition-colors',
                i < step ? 'bg-agent-success text-agent-success-foreground' :
                i === step ? 'bg-agent-primary text-agent-primary-foreground' :
                'bg-muted text-muted-foreground'
              )}>
                {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </div>
              <span className={cn(
                'text-xs hidden sm:block',
                i === step ? 'font-medium text-foreground' : 'text-muted-foreground'
              )}>
                {label}
              </span>
              {i < STEPS.length - 1 && (
                <div className={cn('flex-1 h-px', i < step ? 'bg-agent-success' : 'bg-border')} />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="flex-1 overflow-auto space-y-4">
          {step === 0 && (
            <>
              <div>
                <Label htmlFor="clone-name">英文代号</Label>
                <Input
                  id="clone-name"
                  value={name}
                  onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  placeholder="例如: frontend-dev"
                  className="mt-1 bg-agent-surface-inset border-agent-divider font-mono"
                  maxLength={50}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {name.length}/50 字符，只允许小写字母、数字和横线
                  {name.length > 0 && !nameValid && (
                    <span className="text-agent-error ml-1">格式不正确</span>
                  )}
                </p>
              </div>
              <div>
                <Label htmlFor="clone-display-name">显示名称</Label>
                <Input
                  id="clone-display-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="例如: 前端开发助手"
                  className="mt-1 bg-agent-surface-inset border-agent-divider"
                  maxLength={64}
                />
                <p className="text-xs text-muted-foreground mt-1">支持中文，在 UI 和 @@补全中显示</p>
              </div>
              <div className="p-4 bg-agent-surface-inset rounded-md border border-agent-divider">
                <p className="text-sm text-muted-foreground">
                  💡 创建后，分身会自动生成空的 persona.md 文件。你可以在 Chat 中描述你希望这个分身具备的特质，Agent 会自动帮你完善人格设定。
                </p>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              {/* Memory scope */}
              <div>
                <Label>记忆范围</Label>
                <p className="text-xs text-muted-foreground mt-1 mb-3">
                  共享：可读取主 Agent 长期记忆；独立：完全隔离
                </p>
                <RadioGroup
                  value={memoryScope}
                  onValueChange={(v) => setMemoryScope(v as 'shared' | 'isolated')}
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="isolated" id="mem-isolated" />
                    <Label htmlFor="mem-isolated" className="text-sm font-normal cursor-pointer">
                      独立记忆（推荐）
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="shared" id="mem-shared" />
                    <Label htmlFor="mem-shared" className="text-sm font-normal cursor-pointer">
                      共享记忆
                    </Label>
                  </div>
                </RadioGroup>
              </div>

              <div className="p-4 bg-agent-surface-inset rounded-md border border-agent-divider">
                <p className="text-sm text-muted-foreground">
                  💡 技能管理：创建后，你可以在 Chat 中让 Agent 自主安装和管理技能，无需手动选择。
                </p>
              </div>
            </>
          )}
        </div>

        {/* Navigation buttons */}
        <div className="flex items-center justify-between pt-4 border-t border-agent-divider">
          <Button
            variant="ghost"
            onClick={() => step > 0 ? setStep(step - 1) : onClose()}
            className="gap-1"
          >
            {step > 0 ? <><ChevronLeft className="h-4 w-4" /> 上一步</> : <><X className="h-4 w-4" /> 取消</>}
          </Button>
          {step < STEPS.length - 1 ? (
            <Button
              onClick={() => setStep(step + 1)}
              disabled={!canProceed()}
              className="gap-1 bg-agent-primary hover:bg-agent-primary-hover text-agent-primary-foreground"
            >
              下一步 <ChevronRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              onClick={handleCreate}
              disabled={!canProceed() || loading}
              className="gap-1 bg-agent-primary hover:bg-agent-primary-hover text-agent-primary-foreground"
            >
              <Check className="h-4 w-4" />
              {loading ? '创建中...' : '创建'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
