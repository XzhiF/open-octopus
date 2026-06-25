"use client"

import { useState, useMemo } from "react"
import type { ChatMessage } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Checkbox } from "@/components/ui/checkbox"
import { HelpCircle, CheckCircle2, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

interface QuestionItem {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string }[]
}

interface AskUserQuestionCardProps {
  message: ChatMessage
  onAnswer: (content: string) => void
  disabled?: boolean
}

function parseQuestions(input: unknown): QuestionItem[] {
  if (!input || typeof input !== "object") return []
  const obj = input as Record<string, unknown>
  const questions = Array.isArray(obj.questions) ? obj.questions : []
  return questions as QuestionItem[]
}

function formatAnswerContent(questions: QuestionItem[], answers: Record<number, string | string[]>): string {
  const lines: string[] = ["用户回答了以下问题：", ""]
  questions.forEach((q, i) => {
    const answer = answers[i]
    if (!answer || (Array.isArray(answer) && answer.length === 0)) return
    const header = q.header
    const question = q.question
    const value = Array.isArray(answer) ? answer.join(", ") : answer
    lines.push(`${i + 1}. [${header}] ${question}`)
    lines.push(`   → ${value}`)
    lines.push("")
  })
  return lines.join("\n")
}

export function AskUserQuestionCard({ message, onAnswer, disabled }: AskUserQuestionCardProps) {
  const questions = useMemo(() => parseQuestions(message.toolInput), [message.toolInput])
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({})
  const [otherInputs, setOtherInputs] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState(false)

  if (questions.length === 0) {
    return (
      <div className="mb-4">
        <div className="bg-secondary rounded-xl px-4 py-3 text-sm text-muted-foreground max-w-[90%]">
          无法解析问题数据
        </div>
      </div>
    )
  }

  const allAnswered = questions.every((_, i) => {
    const ans = answers[i]
    if (!ans) return false
    if (Array.isArray(ans)) return ans.length > 0
    return ans.length > 0
  })

  const handleSingleSelect = (qIndex: number, optionLabel: string) => {
    if (submitted || disabled) return
    setAnswers(prev => ({ ...prev, [qIndex]: optionLabel }))
  }

  const handleMultiSelect = (qIndex: number, optionLabel: string) => {
    if (submitted || disabled) return
    setAnswers(prev => {
      const current = (prev[qIndex] as string[]) ?? []
      const next = current.includes(optionLabel)
        ? current.filter(v => v !== optionLabel)
        : [...current, optionLabel]
      return { ...prev, [qIndex]: next }
    })
  }

  const handleOtherInput = (qIndex: number, optionLabel: string, value: string) => {
    if (submitted || disabled) return
    const key = `${qIndex}-${optionLabel}`
    setOtherInputs(prev => ({ ...prev, [key]: value }))
    setAnswers(prev => {
      const current = (prev[qIndex] as string[]) ?? []
      const cleaned = current.filter(v => !v.startsWith(optionLabel + ": "))
      if (value.trim()) {
        return { ...prev, [qIndex]: [...cleaned, `${optionLabel}: ${value.trim()}`] }
      }
      return { ...prev, [qIndex]: cleaned }
    })
  }

  const handleSubmit = () => {
    if (!allAnswered || submitted || disabled) return
    const content = formatAnswerContent(questions, answers)
    setSubmitted(true)
    onAnswer(content)
  }

  const getOtherKey = (qIndex: number, optionLabel: string) => `${qIndex}-${optionLabel}`

  return (
    <div className="mb-4">
      <div className={cn(
        "bg-secondary rounded-xl px-4 py-3 text-sm max-w-[90%] border-l-3",
        submitted ? "border-l-emerald-400" : "border-l-amber-400"
      )}>
        {/* Header */}
        <div className="flex items-center gap-2 mb-3">
          {submitted ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : disabled ? (
            <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
          ) : (
            <HelpCircle className="w-4 h-4 text-amber-400 shrink-0" />
          )}
          <span className="font-medium text-sm">
            {submitted ? "已回答" : disabled ? "AI 正在工作中，完成后可提交答案" : "AI 想要确认以下问题"}
          </span>
        </div>

        {/* Questions */}
        <div className="space-y-4">
          {questions.map((q, qIndex) => (
            <div key={qIndex} className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs px-1.5 py-0">
                  {q.header}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {q.multiSelect ? "（多选）" : ""}
                </span>
              </div>
              <p className="text-sm">{q.question}</p>
              {q.multiSelect ? (
                <div className="space-y-1.5 ml-1">
                  {q.options.map((opt, optIndex) => {
                    const isSelected = Array.isArray(answers[qIndex]) && (answers[qIndex] as string[]).some(
                      v => v === opt.label || v.startsWith(opt.label + ": ")
                    )
                    const otherKey = getOtherKey(qIndex, opt.label)
                    const isOther = opt.label === "其他"

                    return (
                      <div key={optIndex} className="space-y-1">
                        <label
                          htmlFor={`aq-${qIndex}-${optIndex}`}
                          className={cn(
                            "flex items-start gap-2 px-2 py-1.5 rounded-md transition-colors",
                            submitted || disabled ? "cursor-default opacity-60 pointer-events-none" : "cursor-pointer hover:bg-accent/50",
                            isSelected && "bg-accent"
                          )}
                        >
                          <Checkbox
                            id={`aq-${qIndex}-${optIndex}`}
                            checked={isSelected}
                            onCheckedChange={() => handleMultiSelect(qIndex, opt.label)}
                            disabled={submitted || disabled}
                            className="mt-0.5 shrink-0"
                          />
                          <div className="flex-1 min-w-0">
                            <span className="text-sm">{opt.label}</span>
                            {opt.description && (
                              <span className="text-xs text-muted-foreground ml-1.5">
                                — {opt.description}
                              </span>
                            )}
                          </div>
                        </label>
                        {isOther && isSelected && (
                          <Input
                            className="ml-7 text-xs h-7"
                            placeholder="请输入..."
                            value={otherInputs[otherKey] ?? ""}
                            onChange={(e) => handleOtherInput(qIndex, opt.label, e.target.value)}
                            disabled={submitted}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <RadioGroup
                  value={answers[qIndex] as string | undefined}
                  onValueChange={(val) => handleSingleSelect(qIndex, val)}
                  disabled={submitted || disabled}
                  className="space-y-1.5 ml-1"
                >
                  {q.options.map((opt, optIndex) => {
                    const isSelected = answers[qIndex] === opt.label
                    const otherKey = getOtherKey(qIndex, opt.label)
                    const isOther = opt.label === "其他"

                    return (
                      <div key={optIndex} className="space-y-1">
                        <label
                          htmlFor={`aq-${qIndex}-${optIndex}`}
                          className={cn(
                            "flex items-start gap-2 px-2 py-1.5 rounded-md transition-colors",
                            submitted || disabled ? "cursor-default opacity-60 pointer-events-none" : "cursor-pointer hover:bg-accent/50",
                            isSelected && "bg-accent"
                          )}
                        >
                          <RadioGroupItem
                            id={`aq-${qIndex}-${optIndex}`}
                            value={opt.label}
                            className="mt-0.5 shrink-0"
                          />
                          <div className="flex-1 min-w-0">
                            <span className="text-sm">{opt.label}</span>
                            {opt.description && (
                              <span className="text-xs text-muted-foreground ml-1.5">
                                — {opt.description}
                              </span>
                            )}
                          </div>
                        </label>
                        {isOther && isSelected && (
                          <Input
                            className="ml-7 text-xs h-7"
                            placeholder="请输入..."
                            value={otherInputs[otherKey] ?? ""}
                            onChange={(e) => handleOtherInput(qIndex, opt.label, e.target.value)}
                            disabled={submitted}
                          />
                        )}
                      </div>
                    )
                  })}
                </RadioGroup>
              )}
            </div>
          ))}
        </div>

        {/* Submit button */}
        {!submitted ? (
          <div className="mt-4 flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!allAnswered || disabled}
              className="text-xs"
            >
              提交答案
            </Button>
            {disabled ? (
              <span className="text-xs text-blue-400 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                等待 AI 完成
              </span>
            ) : !allAnswered && (
              <span className="text-xs text-muted-foreground">请回答所有问题</span>
            )}
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2 text-xs text-emerald-500">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>答案已提交</span>
          </div>
        )}
      </div>
    </div>
  )
}