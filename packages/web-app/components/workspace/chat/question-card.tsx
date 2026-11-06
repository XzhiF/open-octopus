"use client"

import { useState, useMemo, useEffect, useRef } from "react"
import type { ChatMessage } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Checkbox } from "@/components/ui/checkbox"
import { HelpCircle, CheckCircle2, Loader2, PencilLine } from "lucide-react"
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

// ── 「其他」是每题必带的输入型选项（2026-11-06，对齐 Claude Code CLI）──
// CLI 里每条 question 都会追加 { value:"__other__", label:"Other", placeholder:"Type something" }：
//   · 单选：选「其他」→ 输入的文本就是答案
//   · 多选：可与任意选项同时勾选，答案 = 已选项 + 文本
// 模型自己给了「其他 / Other」时复用那一行，不再补第二行。
const OTHER_LABELS = new Set(["其他", "其它", "other", "自定义"])

function isOtherLabel(label: string): boolean {
  return OTHER_LABELS.has(label.trim().toLowerCase())
}

function otherLabelOf(q: QuestionItem): string {
  return q.options.find((o) => isOtherLabel(o.label))?.label ?? "其他"
}

function normalOptionsOf(q: QuestionItem) {
  return q.options.filter((o) => !isOtherLabel(o.label))
}

function otherInputKey(qIndex: number): string {
  return `${qIndex}-__other__`
}

/** 单题的实际答案；null = 未答（多选一个没勾且没填其他 / 单选没选 / 其他为空）。 */
function answerFor(
  q: QuestionItem,
  qIndex: number,
  answers: Record<number, string | string[]>,
  otherInputs: Record<string, string>,
): string | null {
  const answer = answers[qIndex]
  const otherText = (otherInputs[otherInputKey(qIndex)] ?? "").trim()
  const otherLabel = otherLabelOf(q)
  if (q.multiSelect) {
    const labels = Array.isArray(answer) ? answer.filter((v) => v !== otherLabel) : []
    const parts = [...labels, ...(otherText ? [otherText] : [])]
    return parts.length > 0 ? parts.join(", ") : null
  }
  if (answer === otherLabel) return otherText || null
  return typeof answer === "string" && answer.length > 0 ? answer : null
}

function formatAnswerContent(
  questions: QuestionItem[],
  answers: Record<number, string | string[]>,
  otherInputs: Record<string, string>,
): string {
  const lines: string[] = ["用户回答了以下问题：", ""]
  questions.forEach((q, i) => {
    const value = answerFor(q, i, answers, otherInputs)
    if (value === null) return
    lines.push(`${i + 1}. [${q.header}] ${q.question}`)
    lines.push(`   → ${value}`)
    lines.push("")
  })
  return lines.join("\n")
}

/** 「Chat about this」= 不回答，把问题与当前填写情况交回 Agent 澄清（CLI 同款语义）。 */
function formatChatAboutContent(
  questions: QuestionItem[],
  answers: Record<number, string | string[]>,
  otherInputs: Record<string, string>,
): string {
  const lines: string[] = [
    "用户想先讨论这些问题，而不是直接作答。",
    "用户可能有额外的信息、上下文或问题要问你。",
    "请结合用户的说明，必要时重新提问；先问用户想澄清什么。",
    "",
    "已问的问题：",
  ]
  questions.forEach((q, i) => {
    const value = answerFor(q, i, answers, otherInputs)
    lines.push(`- “${q.question}”`)
    lines.push(`  当前答案：${value ?? "（未回答）"}`)
    const otherText = (otherInputs[otherInputKey(i)] ?? "").trim()
    if (otherText) lines.push(`  用户补充：${otherText}`)
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
        <div className="bg-secondary rounded-xl px-4 py-3 text-sm text-muted-foreground max-w-[90%] border-l-3 border-l-pop-amber">
          无法解析问题数据
        </div>
      </div>
    )
  }

  if (!hasQuestions) {
    return (
      <div className="mb-4">
        <div className="bg-secondary rounded-xl px-4 py-3 text-sm max-w-[90%] border-l-3 border-l-pop-amber">
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-pop-amber animate-spin shrink-0" />
            <span className="font-medium">正在准备问题…</span>
          </div>
        </div>
      </div>
    )
  }

  const allAnswered = questions.every((q, i) => answerFor(q, i, answers, otherInputs) !== null)

  const handleSingleSelect = (qIndex: number, optionLabel: string) => {
    if (phase !== "ready") return
    setAnswers(prev => ({ ...prev, [qIndex]: optionLabel }))
  }

  const handleMultiSelect = (qIndex: number, optionLabel: string) => {
    if (phase !== "ready") return
    setAnswers(prev => {
      const raw = prev[qIndex]
      const current = Array.isArray(raw) ? raw : []
      const next = current.includes(optionLabel)
        ? current.filter(v => v !== optionLabel)
        : [...current, optionLabel]
      return { ...prev, [qIndex]: next }
    })
  }

  const selectOther = (qIndex: number, q: QuestionItem) => {
    if (phase !== "ready") return
    const label = otherLabelOf(q)
    if (q.multiSelect) {
      setAnswers(prev => {
        const current = Array.isArray(prev[qIndex]) ? prev[qIndex] as string[] : []
        return current.includes(label)
          ? prev
          : { ...prev, [qIndex]: [...current, label] }
      })
    } else {
      setAnswers(prev => ({ ...prev, [qIndex]: label }))
    }
  }

  const handleOtherInput = (qIndex: number, value: string) => {
    if (phase !== "ready") return
    setOtherInputs(prev => ({ ...prev, [otherInputKey(qIndex)]: value }))
  }

  const handleSubmit = () => {
    if (!allAnswered || phase !== "ready") return
    const content = formatAnswerContent(questions, answers, otherInputs)
    setSubmitted(true)
    onAnswer(content)
  }

  const canChatAbout = questions.some((q) => !q.multiSelect)
  const handleChatAbout = () => {
    if (phase !== "ready") return
    onAnswer(formatChatAboutContent(questions, answers, otherInputs))
  }

  return (
    <div className="mb-4">
      <div
        className={cn(
          "rounded-[14px] border-[2.5px] border-pop-bd px-4 py-3 text-sm text-pop-ink max-w-[90%] shadow-pop",
          "transition-colors duration-300 ease-out",
          // 2026-11-06 用户：未作答时用原来的卡片底色（paper），不再铺琥珀底。
          phase === "answered" ? "bg-pop-green-soft" : "bg-pop-paper"
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-3">
          {phase === "answered" ? (
            <CheckCircle2 className="w-4 h-4 text-pop-green shrink-0" />
          ) : phase === "preparing" ? (
            <Loader2 className="w-4 h-4 text-pop-amber animate-spin shrink-0" />
          ) : (
            <HelpCircle className="w-4 h-4 text-pop-amber shrink-0" />
          )}
          <span className="font-black text-sm">
            {phase === "answered"
              ? "已回答"
              : phase === "preparing"
                ? "正在准备问题…"
                : "AI 想要确认以下问题"}
          </span>
        </div>

        {/* Questions */}
        <div className="space-y-4">
          {questions.map((q, qIndex) => {
            const normalOptions = normalOptionsOf(q)
            const otherLabel = otherLabelOf(q)
            const otherDeclared = q.options.find((o) => isOtherLabel(o.label))
            const otherText = otherInputs[otherInputKey(qIndex)] ?? ""
            const otherSelected = Array.isArray(answers[qIndex])
              ? (answers[qIndex] as string[]).includes(otherLabel)
              : answers[qIndex] === otherLabel
            return (
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
                    {normalOptions.map((opt, optIndex) => {
                      const isSelected =
                        Array.isArray(answers[qIndex]) &&
                        (answers[qIndex] as string[]).includes(opt.label)
                      return (
                        <label
                          key={optIndex}
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
                      )
                    })}
                    {/* 其他（CLI 的 __other__）：可与任意选项同时勾选 */}
                    <label
                      htmlFor={`aq-${qIndex}-other`}
                      className={cn(
                        "flex items-start gap-2 px-2 py-1.5 rounded-md transition-colors",
                        phase === "answered"
                          ? "cursor-default opacity-60 pointer-events-none"
                          : "cursor-pointer hover:bg-accent/50",
                        otherSelected && "bg-accent"
                      )}
                    >
                      <Checkbox
                        id={`aq-${qIndex}-other`}
                        checked={otherSelected}
                        onCheckedChange={() => selectOther(qIndex, q)}
                        disabled={phase !== "ready"}
                        className="mt-0.5 shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm">{otherLabel}</span>
                        <span className="text-xs text-muted-foreground ml-1.5">
                          — {otherDeclared?.description || "自己输入"}
                        </span>
                      </div>
                    </label>
                    {otherSelected && phase === "ready" && (
                      <Input
                        className="ml-7 text-xs h-7"
                        placeholder="输入你的回答…"
                        value={otherText}
                        onChange={(e) => handleOtherInput(qIndex, e.target.value)}
                        onFocus={() => selectOther(qIndex, q)}
                        data-testid={`aq-other-input-${qIndex}`}
                      />
                    )}
                    {phase === "answered" && !!otherText.trim() && (
                      <p className="ml-7 text-xs text-muted-foreground">其他：{otherText.trim()}</p>
                    )}
                  </div>
                )}

                {phase !== "preparing" && !q.multiSelect && (
                  <RadioGroup
                    value={(answers[qIndex] as string) ?? ""}
                    onValueChange={(val) => handleSingleSelect(qIndex, val)}
                    disabled={phase !== "ready"}
                    className="space-y-1.5 ml-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
                  >
                    {normalOptions.map((opt, optIndex) => {
                      const isSelected = answers[qIndex] === opt.label
                      return (
                        <label
                          key={optIndex}
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
                      )
                    })}
                    {/* 其他（CLI 的 __other__）：输入的文本就是答案 */}
                    <label
                      htmlFor={`aq-${qIndex}-other`}
                      className={cn(
                        "flex items-start gap-2 px-2 py-1.5 rounded-md transition-colors",
                        phase === "answered"
                          ? "cursor-default opacity-60 pointer-events-none"
                          : "cursor-pointer hover:bg-accent/50",
                        otherSelected && "bg-accent"
                      )}
                    >
                      <RadioGroupItem
                        id={`aq-${qIndex}-other`}
                        value={otherLabel}
                        className="mt-0.5 shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm">{otherLabel}</span>
                        <span className="text-xs text-muted-foreground ml-1.5">
                          — {otherDeclared?.description || "自己输入"}
                        </span>
                      </div>
                    </label>
                  </RadioGroup>
                )}

                {!q.multiSelect && otherSelected && phase === "ready" && (
                  <Input
                    className="ml-7 text-xs h-7"
                    placeholder="输入你的回答…"
                    value={otherText}
                    onChange={(e) => handleOtherInput(qIndex, e.target.value)}
                    onFocus={() => selectOther(qIndex, q)}
                    data-testid={`aq-other-input-${qIndex}`}
                  />
                )}
                {!q.multiSelect && phase === "answered" && !!otherText.trim() && (
                  <p className="ml-7 text-xs text-muted-foreground">其他：{otherText.trim()}</p>
                )}
              </div>
            )
          })}
        </div>

        {/* Submit */}
        {phase === "ready" && (
          <div className="mt-4 flex items-center gap-2 animate-in fade-in duration-200">
            <Button
              variant="pop"
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

        {/* Chat about this（CLI 同款，仅单选出现）：不回答，交回 Agent 澄清 */}
        {phase === "ready" && canChatAbout && (
          <div className="mt-2 border-t border-dashed border-white/10 pt-2">
            <button
              type="button"
              onClick={handleChatAbout}
              data-testid="aq-chat-about"
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            >
              <PencilLine className="size-3 shrink-0 text-pop-purple" />
              先和 Claude 聊聊这些问题
            </button>
          </div>
        )}

        {phase === "answered" && (
          <div className="mt-3 flex items-center gap-2 text-xs text-pop-green">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>答案已提交</span>
          </div>
        )}
      </div>
    </div>
  )
}
