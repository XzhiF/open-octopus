"use client"

import { useState, useMemo, useEffect } from "react"
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

interface AskUserQuestionCardProps {
  message: ChatMessage
  onAnswer: (content: string) => void
  disabled?: boolean
  /** 跨线程复用（舱主会话的作者提问卡）时关掉「先讨论」——它会把讨论请求
   *  转发到另一个线程，而回答正文不会回到当前对话，语义会断。
   *  2026-11-20 起有 `onChatAbout` 时不再需要它：讨论请求交给服务端
   *  （POST /decisions/discuss）送到提问所在会话，不走本卡的作答正文。 */
  hideChatAbout?: boolean
  /** 「还需讨论」：不回答，请提问的 agent 先把选项解释清楚（用户 #20）。
   *  summary = 当前已勾选/已填写的答案摘要（没填就是 undefined），
   *  由宿主带给服务端，补进讨论请求。 */
  onChatAbout?: (summary?: string) => void
  /** design 25 §5.3：决策队列的键盘导航。传 askId 后，本卡监听窗口级
   *  `octopus:ask-key` 事件（只处理 askId 匹配的），`1/2/3` 选选项、`↵` 提交。
   *  归属仍由提交体里的 askId 决定，键盘只影响「当前这张卡」的 UI。 */
  hotkeyId?: string
}

function parseQuestions(input: unknown): QuestionItem[] {
  if (!input || typeof input !== "object") return []
  const obj = input as Record<string, unknown>
  const questions = Array.isArray(obj.questions) ? obj.questions : []
  return questions as QuestionItem[]
}

// ── 「其他」是每题必带的输入型选项（2026-11-06，对齐 Claude Code CLI）──
// 单选：输入的文本就是答案；多选：可与任意选项同时勾选，答案 = 已选项 + 文本。
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

/** 「还需讨论」的摘要：只把用户已经勾选 / 填过的答案压成一行（没填返回 undefined）。 */
function formatChatAboutSummary(
  questions: QuestionItem[],
  answers: Record<number, string | string[]>,
  otherInputs: Record<string, string>,
): string | undefined {
  const parts: string[] = []
  questions.forEach((q, i) => {
    const value = answerFor(q, i, answers, otherInputs)
    if (value) parts.push(`${q.header}: ${value}`)
  })
  return parts.length > 0 ? `已勾选 ${parts.join("；")}` : undefined
}

export function AskUserQuestionCard({ message, onAnswer, disabled, hideChatAbout, onChatAbout, hotkeyId }: AskUserQuestionCardProps) {
  const questions = useMemo(() => parseQuestions(message.toolInput), [message.toolInput])
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({})
  const [otherInputs, setOtherInputs] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState(false)

  const allAnswered = questions.every((q, i) => answerFor(q, i, answers, otherInputs) !== null)

  const handleSingleSelect = (qIndex: number, optionLabel: string) => {
    if (submitted || disabled) return
    setAnswers(prev => ({ ...prev, [qIndex]: optionLabel }))
  }

  const handleMultiSelect = (qIndex: number, optionLabel: string) => {
    if (submitted || disabled) return
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
    if (submitted || disabled) return
    const label = otherLabelOf(q)
    if (q.multiSelect) {
      setAnswers(prev => {
        const current = Array.isArray(prev[qIndex]) ? prev[qIndex] as string[] : []
        return current.includes(label) ? prev : { ...prev, [qIndex]: [...current, label] }
      })
    } else {
      setAnswers(prev => ({ ...prev, [qIndex]: label }))
    }
  }

  const handleOtherInput = (qIndex: number, value: string) => {
    if (submitted || disabled) return
    setOtherInputs(prev => ({ ...prev, [otherInputKey(qIndex)]: value }))
  }

  const handleSubmit = () => {
    if (!allAnswered || submitted || disabled) return
    const content = formatAnswerContent(questions, answers, otherInputs)
    setSubmitted(true)
    onAnswer(content)
  }

  const canChatAbout = questions.some((q) => !q.multiSelect)
  const handleChatAbout = () => {
    if (submitted || disabled) return
    onAnswer(formatChatAboutContent(questions, answers, otherInputs))
  }

  // design 25 §5.3：1/2/3 选当前卡的选项，↵ 提交。只处理本卡（hotkeyId 匹配）；
  // 归属永远由提交体里的 askId 决定，键盘不参与「这条答案属于谁」。
  useEffect(() => {
    if (!hotkeyId) return
    const onKey = (event: Event) => {
      const detail = (event as CustomEvent<{ askId?: string; key?: string }>).detail
      if (!detail || detail.askId !== hotkeyId || submitted || disabled) return
      const first = questions[0]
      if (!first) return
      if (detail.key === "Enter") {
        if (allAnswered) handleSubmit()
        return
      }
      const index = Number(detail.key) - 1
      if (!Number.isInteger(index) || index < 0) return
      const opt = normalOptionsOf(first)[index]
      if (!opt) return
      if (first.multiSelect) handleMultiSelect(0, opt.label)
      else handleSingleSelect(0, opt.label)
    }
    window.addEventListener("octopus:ask-key", onKey)
    return () => window.removeEventListener("octopus:ask-key", onKey)
  })

  if (questions.length === 0) {
    return (
      <div className="mb-4">
        <div className="bg-pop-paper text-pop-ink rounded-[14px] border-[2.5px] border-pop-bd shadow-pop-sm px-4 py-3 text-sm text-muted-foreground max-w-[90%]">
          无法解析问题数据
        </div>
      </div>
    )
  }

  return (
    <div className="mb-4">
      <div className={cn(
        "rounded-[14px] border-[2.5px] border-pop-bd px-4 py-3 text-sm text-pop-ink max-w-[90%] shadow-pop",
        "transition-colors duration-300 ease-out",
        // 2026-11-06 用户：未作答时用原来的卡片底色（paper），不再铺琥珀底。
        submitted ? "bg-pop-green-soft" : "bg-pop-paper"
      )}>
        {/* Header */}
        <div className="flex items-center gap-2 mb-3">
          {submitted ? (
            <CheckCircle2 className="w-4 h-4 text-pop-green shrink-0" />
          ) : disabled ? (
            <Loader2 className="w-4 h-4 text-pop-cyan animate-spin shrink-0" />
          ) : (
            <HelpCircle className="w-4 h-4 text-pop-amber shrink-0" />
          )}
          <span className="font-medium text-sm">
            {submitted ? "已回答" : disabled ? "AI 正在工作中，完成后可提交答案" : "AI 想要确认以下问题"}
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
                  <span className="text-xs text-muted-foreground">
                    {q.multiSelect ? "（多选）" : ""}
                  </span>
                </div>
                <p className="text-sm">{q.question}</p>
                {q.multiSelect ? (
                  <div className="space-y-1.5 ml-1">
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
                      )
                    })}
                    {/* 其他（CLI 的 __other__）：可与任意选项同时勾选 */}
                    <label
                      htmlFor={`aq-${qIndex}-other`}
                      className={cn(
                        "flex items-start gap-2 px-2 py-1.5 rounded-md transition-colors",
                        submitted || disabled ? "cursor-default opacity-60 pointer-events-none" : "cursor-pointer hover:bg-accent/50",
                        otherSelected && "bg-accent"
                      )}
                    >
                      <Checkbox
                        id={`aq-${qIndex}-other`}
                        checked={otherSelected}
                        onCheckedChange={() => selectOther(qIndex, q)}
                        disabled={submitted || disabled}
                        className="mt-0.5 shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm">{otherLabel}</span>
                        <span className="text-xs text-muted-foreground ml-1.5">
                          — {otherDeclared?.description || "自己输入"}
                        </span>
                      </div>
                    </label>
                    {otherSelected && !submitted && (
                      <Input
                        className="ml-7 text-xs h-7"
                        placeholder="输入你的回答…"
                        value={otherText}
                        onChange={(e) => handleOtherInput(qIndex, e.target.value)}
                        onFocus={() => selectOther(qIndex, q)}
                        disabled={disabled}
                        data-testid={`aq-other-input-${qIndex}`}
                      />
                    )}
                    {submitted && !!otherText.trim() && (
                      <p className="ml-7 text-xs text-muted-foreground">其他：{otherText.trim()}</p>
                    )}
                  </div>
                ) : (
                  <>
                    <RadioGroup
                      value={(answers[qIndex] as string | undefined) ?? ""}
                      onValueChange={(val) => handleSingleSelect(qIndex, val)}
                      disabled={submitted || disabled}
                      className="space-y-1.5 ml-1"
                    >
                      {normalOptions.map((opt, optIndex) => {
                        const isSelected = answers[qIndex] === opt.label
                        return (
                          <label
                            key={optIndex}
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
                              {hotkeyId && !submitted && !disabled && optIndex < 9 && (
                                <span className="ml-1.5 rounded border border-pop-bd px-1 font-mono text-[9.5px] text-pop-dim">
                                  {optIndex + 1}
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
                          submitted || disabled ? "cursor-default opacity-60 pointer-events-none" : "cursor-pointer hover:bg-accent/50",
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
                    {otherSelected && !submitted && (
                      <Input
                        className="ml-7 text-xs h-7"
                        placeholder="输入你的回答…"
                        value={otherText}
                        onChange={(e) => handleOtherInput(qIndex, e.target.value)}
                        onFocus={() => selectOther(qIndex, q)}
                        disabled={disabled}
                        data-testid={`aq-other-input-${qIndex}`}
                      />
                    )}
                    {submitted && !!otherText.trim() && (
                      <p className="ml-7 text-xs text-muted-foreground">其他：{otherText.trim()}</p>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>

        {/* Submit */}
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
              <span className="text-xs text-pop-cyan flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                等待 AI 完成
              </span>
            ) : !allAnswered && (
              <span className="text-xs text-muted-foreground">请回答所有问题</span>
            )}
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2 text-xs text-pop-green">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>答案已提交</span>
          </div>
        )}

        {/* 还需讨论（用户 #20，Claude Code 的 Chat about this 同语义）：
            不回答，把问题交回 agent 先解释选项。宿主给了 onChatAbout 就走
            server 的讨论端点（提问仍待答）；否则退回「把讨论正文当作答发出去」。 */}
        {!submitted && !disabled && canChatAbout && (onChatAbout || !hideChatAbout) && (
          <div className="mt-2 border-t border-dashed border-white/10 pt-2">
            <button
              type="button"
              onClick={() => {
                if (onChatAbout) {
                  onChatAbout(formatChatAboutSummary(questions, answers, otherInputs))
                  return
                }
                handleChatAbout()
              }}
              data-testid="aq-chat-about"
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            >
              <PencilLine className="size-3 shrink-0 text-pop-purple" />
              还需讨论 —— 先让对方解释这几个选项
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
