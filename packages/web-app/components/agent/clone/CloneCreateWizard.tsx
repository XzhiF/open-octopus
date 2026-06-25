'use client'

import { useState } from 'react'
import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import * as api from '@/lib/agent/api'
import type { CreateCloneRequest } from '@/lib/agent/types'

interface CloneCreateWizardProps {
  onClose: () => void
  onCreated: () => void
}

const STEPS = ['人格设定', '技能选择', '工作空间', '记忆范围']

export function CloneCreateWizard({ onClose, onCreated }: CloneCreateWizardProps) {
  const [step, setStep] = useState(0)
  const [loading, setLoading] = useState(false)

  // Step 1: Persona
  const [name, setName] = useState('')
  const [persona, setPersona] = useState('')

  // Step 2: Skills
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])

  // Step 3: Workspace
  const [workspaceName, setWorkspaceName] = useState('')
  const [projects, setProjects] = useState('')

  // Step 4: Memory scope
  const [memoryScopes, setMemoryScopes] = useState<string[]>(['经验教训', '常用工作流'])

  const canProceed = () => {
    switch (step) {
      case 0: return name.trim().length > 0 && persona.trim().length > 0
      case 1: return selectedSkills.length > 0
      case 2: return true
      case 3: return true
      default: return false
    }
  }

  const handleCreate = async () => {
    setLoading(true)
    try {
      const req: CreateCloneRequest = {
        name: name.trim(),
        persona: persona.trim(),
        skills: selectedSkills,
        workspace_config: {
          name: workspaceName || undefined,
          projects: projects.split(',').map(p => p.trim()).filter(Boolean),
        },
        memory_scope: memoryScopes,
      }
      await api.createClone(req)
      toast.success('分身创建成功')
      onCreated()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '创建失败，已回滚')
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
                <Label htmlFor="clone-name">分身名称</Label>
                <Input
                  id="clone-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如: frontend-dev"
                  className="mt-1 bg-agent-surface-inset border-agent-divider"
                  maxLength={64}
                />
                <p className="text-xs text-muted-foreground mt-1">1-64 字符，只允许小写字母、数字和横线</p>
              </div>
              <div>
                <Label htmlFor="clone-persona">人格设定</Label>
                <Textarea
                  id="clone-persona"
                  value={persona}
                  onChange={(e) => setPersona(e.target.value)}
                  placeholder="描述这个分身的性格、专长和工作方式..."
                  className="mt-1 min-h-[120px] bg-agent-surface-inset border-agent-divider"
                  maxLength={2000}
                />
                <p className="text-xs text-muted-foreground mt-1">{persona.length} / 2000 字符</p>
              </div>
            </>
          )}

          {step === 1 && (
            <div>
              <Label>选择技能（至少 1 个）</Label>
              <p className="text-xs text-muted-foreground mt-1 mb-3">从主 Agent SKILL 中选择分身可用的技能</p>
              <div className="space-y-2">
                {['octo-agent-orchestrator', 'octo-agent-memory', 'octo-agent-clone', 'octo-agent-scheduler', 'octo-agent-workspace', 'octo-agent-evolution'].map((skill) => (
                  <div key={skill} className="flex items-center gap-2">
                    <Checkbox
                      id={skill}
                      checked={selectedSkills.includes(skill)}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setSelectedSkills(prev => [...prev, skill])
                        } else {
                          setSelectedSkills(prev => prev.filter(s => s !== skill))
                        }
                      }}
                    />
                    <label htmlFor={skill} className="text-sm font-mono cursor-pointer">{skill}</label>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <>
              <div>
                <Label htmlFor="ws-name">工作空间名称（可选）</Label>
                <Input
                  id="ws-name"
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  placeholder="留空则自动创建"
                  className="mt-1 bg-agent-surface-inset border-agent-divider"
                />
              </div>
              <div>
                <Label htmlFor="ws-projects">关联项目</Label>
                <Input
                  id="ws-projects"
                  value={projects}
                  onChange={(e) => setProjects(e.target.value)}
                  placeholder="逗号分隔，例如: xzf-octopus, web-app"
                  className="mt-1 bg-agent-surface-inset border-agent-divider"
                />
              </div>
            </>
          )}

          {step === 3 && (
            <div>
              <Label>记忆范围</Label>
              <p className="text-xs text-muted-foreground mt-1 mb-3">从主 Agent 长期记忆中提取哪些分节</p>
              <div className="space-y-2">
                {['经验教训', '常用工作流', '项目索引', '偏好', '人格'].map((scope) => (
                  <div key={scope} className="flex items-center gap-2">
                    <Checkbox
                      id={`scope-${scope}`}
                      checked={memoryScopes.includes(scope)}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setMemoryScopes(prev => [...prev, scope])
                        } else {
                          setMemoryScopes(prev => prev.filter(s => s !== scope))
                        }
                      }}
                    />
                    <label htmlFor={`scope-${scope}`} className="text-sm cursor-pointer">{scope}</label>
                  </div>
                ))}
              </div>
            </div>
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
