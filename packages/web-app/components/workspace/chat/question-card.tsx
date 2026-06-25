"use client"

import { useState, useMemo, useEffect, useRef } from "react"
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

interface QuestionCardProps {
  message: ChatMessage
  onAnswer: (content: string) => void
  disabled?: boolean
}

type Phase = "preparing" | "ready" | "answered"

function parseQuestions(input: unknown): QuestionItem[] {
  if (!input || typeof input !== "object") return []
  const obj = input as Record<string, unknown>
  const questions = Array.isArray(obj.questions) ? obj.questions : []
  return questions as QuestionItem[]
}

function formatAnswerContent(
  questions: QuestionItem[],
  answers: Record<number, string | string[]>
): string {
  const lines: string[] = ["用户回答了以下问题：", ""]
  questions.forEach((q, i) => {
    const answer = answers[i]
    if (!answer || (Array.isArray(answer) && answer.length === 0)) return
    const value = Array.isArray(answer) ? answer.join(", ") : answer
    lines.push(`${i + 1}. [${q.header}] ${q.question}`)
    lines.push(`   → ${value}`)
    lines.push("")
  })
  return lines.join("\n")
}

export function QuestionCard({ message, onAnswer, disabled }: QuestionCardProps) {
  const questions = useMemo(() => parseQuestions(message.toolInput), [message.toolInput])
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({})
  const [otherInputs, setOtherInputs] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState(false)

  // Phase: stay "preparing" until stream ends + green status visible, then expand
  const rawPhase: Phase = submitted ? "answered" : disabled ? "preparing" : "ready"
  const [phase, setPhase] = useState<Phase>(rawPhase)
  const wasStreamingRef = useRef(disabled)

  useEffect(() => {
    if (!disabled && wasStreamingRef.current) {
      // Stream just ended — keep "preparing" briefly so green "完成" status
      // is visible before the card expands
      wasStreamingRef.current = false
      const timer = setTimeout(() => setPhase("ready"), 300)
      return () => clearTimeout(timer)
    }
    wasStreamingRef.current = disabled
    setPhase(rawPhase)
  }, [rawPhase, disabled])

  const hasQuestions = questions.length > 0

  if (!hasQuestions && phase === "ready") {
    return (
      <div className="mb-4">
        <div className="bg-secondary rounded-xl px-4 py-3 text-sm text-muted-foreground max-w-[90%] border-l-3 border-l-amber-400">
          无法解析问题数据
        </div>
      </div>
    )
  }

  if (!hasQuestions) {
    return (
      <div className="mb-4">
        <div className="bg-secondary rounded-xl px-4 py-3 text-sm max-w-[90%] border-l-3 border-l-amber-400">
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-amber-400 animate-spin shrink-0" />
            <span className="font-medium">正在准备问题…</span>
          </div>
        </div>
      </div>
    )
  }

  const allAnswered = questions.every((_, i) => {
    const ans = answers[i]
    if (!ans) return false
    if (Array.isArray(ans)) return ans.length > 0
    return true
  })

  const handleSingleSelect = (qIndex: number, optionLabel: string) => {
    if (phase !== "ready") return
    setAnswers(prev => ({ ...prev, [qIndex]: optionLabel }))
  }

  const handleMultiSelect = (qIndex: number, optionLabel: string) => {
    if (phase !== "ready") return
    setAnswers(prev => {
      const current = (prev[qIndex] as string[]) ?? []
      const next = current.includes(optionLabel)
        ? current.filter(v => v !== optionLabel)
        : [...current, optionLabel]
      return { ...prev, [qIndex]: next }
    })
  }

  const handleOtherInput = (qIndex: number, optionLabel: string, value: string) => {
    if (phase !== "ready") return
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
    if (!allAnswered || phase !== "ready") return
    const content = formatAnswerContent(questions, answers)
    setSubmitted(true)
    onAnswer(content)
  }

  const getOtherKey = (qIndex: number, optionLabel: string) => `${qIndex}-${optionLabel}`

  return (
    <div className="mb-4">
      <div
        className={cn(
          "bg-secondary rounded-xl px-4 py-3 text-sm max-w-[90%] border-l-3",
          "transition-[border-color] duration-300 ease-out",
          phase === "answered" ? "border-l-emerald-400" : "border-l-amber-400"
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-3">
          {phase === "answered" ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : phase === "preparing" ? (
            <Loader2 className="w-4 h-4 text-amber-400 animate-spin shrink-0" />
          ) : (
            <HelpCircle className="w-4 h-4 text-amber-400 shrink-0" />
          )}
          <span className="font-medium text-sm">
            {phase === "answered"
              ? "已回答"
              : phase === "preparing"
                ? "正在准备问题…"
                : "AI 想要确认以下问题"}
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
                {q.multiSelect && (
                  <span className="text-xs text-muted-foreground">（多选）</span>
                )}
              </div>
              <p className="text-sm">{q.question}</p>

              {/* Preparing: show preview hint, options NOT in DOM */}
              {phase === "preparing" && (
                <div className="text-xs text-muted-foreground/60 animate-pulse">
                  ··· 即将展开
                </div>
              )}

              {/* Ready/answered: options rendered with entrance animation */}
              {phase !== "preparing" && q.multiSelect && (
                <div className="space-y-1.5 ml-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  {q.options.map((opt, optIndex) => {
                    const isSelected =
                      Array.isArray(answers[qIndex]) &&
                      (answers[qIndex] as string[]).some(
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
                            phase === "answered"
                              ? "cursor-default opacity-60 pointer-events-none"
                              : "cursor-pointer hover:bg-accent/50",
                            isSelected && "bg-accent"
                          )}
                        >
                          <Checkbox
                            id={`aq-${qIndex}-${optIndex}`}
                            checked={isSelected}
                            onCheckedChange={() => handleMultiSelect(qIndex, opt.label)}
                            disabled={phase !== "ready"}
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
                        {isOther && isSelected && phase === "ready" && (
                          <Input
                            className="ml-7 text-xs h-7"
                            placeholder="请输入..."
                            value={otherInputs[otherKey] ?? ""}
                            onChange={(e) =>
                              handleOtherInput(qIndex, opt.label, e.target.value)
                            }
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {phase !== "preparing" && !q.multiSelect && (
                <RadioGroup
                  value={(answers[qIndex] as string) ?? ""}
                  onValueChange={(val) => handleSingleSelect(qIndex, val)}
                  disabled={phase !== "ready"}
                  className="space-y-1.5 ml-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
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
                            phase === "answered"
                              ? "cursor-default opacity-60 pointer-events-none"
                              : "cursor-pointer hover:bg-accent/50",
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
                        {isOther && isSelected && phase === "ready" && (
                          <Input
                            className="ml-7 text-xs h-7"
                            placeholder="请输入..."
                            value={otherInputs[otherKey] ?? ""}
                            onChange={(e) =>
                              handleOtherInput(qIndex, opt.label, e.target.value)
                            }
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

        {/* Submit */}
        {phase === "ready" && (
          <div className="mt-4 flex items-center gap-2 animate-in fade-in duration-200">
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={!allAnswered}
              className="text-xs"
            >
              提交答案
            </Button>
            {!allAnswered && (
              <span className="text-xs text-muted-foreground">请回答所有问题</span>
            )}
          </div>
        )}

        {phase === "answered" && (
          <div className="mt-3 flex items-center gap-2 text-xs text-emerald-500">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>答案已提交</span>
          </div>
        )}
      </div>
    </div>
  )
}