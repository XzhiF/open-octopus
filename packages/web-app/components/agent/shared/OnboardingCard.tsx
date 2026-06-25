'use client'

import { useState } from 'react'
import { Bot, MessageSquare, Bell, CheckCircle2, ArrowRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import * as api from '@/lib/agent/api'

interface OnboardingCardProps {
  onComplete: () => void
}

const STEPS = [
  {
    icon: Bot,
    title: '欢迎使用 Octopus Agent',
    description: 'Agent 是你的智能编排助手，能自动分析任务、匹配工作流、管理分身，帮你高效完成复杂开发工作。',
  },
  {
    icon: MessageSquare,
    title: '示例指令',
    description: '试试这些指令：\n• "给 octopus 加黑色主题" — 自动编排开发工作流\n• "每天上午10点总结PR" — 创建定时任务\n• "创建一个分身处理前端" — 分身管理',
  },
  {
    icon: Bell,
    title: '通知配置',
    description: 'Agent 可以通过 Hermes、Telegram 或 Slack 发送任务完成通知。你可以在配置 Tab 中设置通知渠道和时区。',
  },
  {
    icon: CheckCircle2,
    title: '准备就绪',
    description: '一切就绪！你可以开始在对话 Tab 中与 Agent 交流，或直接使用 CLI 命令。Agent 会自动学习你的偏好并持续进化。',
  },
]

export function OnboardingCard({ onComplete }: OnboardingCardProps) {
  const [step, setStep] = useState(0)
  const [completing, setCompleting] = useState(false)

  const isLastStep = step === STEPS.length - 1
  const currentStep = STEPS[step]

  const handleNext = async () => {
    if (isLastStep) {
      setCompleting(true)
      try {
        await api.updateConfig({ onboarding_completed: true } as Record<string, unknown>)
        onComplete()
      } catch {
        // Fallback: just dismiss
        onComplete()
      }
    } else {
      setStep(step + 1)
    }
  }

  const handleSkip = async () => {
    setCompleting(true)
    try {
      await api.updateConfig({ onboarding_completed: true } as Record<string, unknown>)
    } catch { /* proceed */ }
    onComplete()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-xl border border-agent-divider bg-agent-surface-raised shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-agent-divider bg-agent-surface-inset">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-agent-primary">M-ONBOARD</span>
            <span className="text-xs text-muted-foreground">
              {step + 1} / {STEPS.length}
            </span>
          </div>
          <button
            onClick={handleSkip}
            className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            aria-label="跳过引导"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-agent-primary/10">
              {currentStep.icon && <currentStep.icon className="h-5 w-5 text-agent-primary" />}
            </div>
            <h2 className="text-lg font-semibold">{currentStep.title}</h2>
          </div>

          <p className="text-sm text-muted-foreground whitespace-pre-line leading-relaxed">
            {currentStep.description}
          </p>

          {/* Step indicators */}
          <div className="flex gap-1.5 pt-2">
            {STEPS.map((_, idx) => (
              <div
                key={idx}
                className={cn(
                  'h-1.5 flex-1 rounded-full transition-colors',
                  idx <= step ? 'bg-agent-primary' : 'bg-agent-divider',
                )}
              />
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-agent-divider">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSkip}
            disabled={completing}
          >
            跳过
          </Button>
          <Button
            onClick={handleNext}
            disabled={completing}
            className="gap-1.5 bg-agent-primary hover:bg-agent-primary-hover text-agent-primary-foreground"
          >
            {isLastStep ? '开始使用' : '下一步'}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
