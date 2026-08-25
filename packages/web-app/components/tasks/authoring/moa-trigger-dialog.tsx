// packages/web-app/components/tasks/authoring/moa-trigger-dialog.tsx
//
// MoA / Debate trigger dialog — lets the user:
//   1. Pick a mode: MoA (parallel + aggregate) or Debate (multi-round argue)
//   2. Configure expert rows: each row = { engine, model, role }
//      - MoA: roles can repeat (compare same role across engines/models)
//      - Debate: roles must be unique (each debater has distinct perspective)
//   3. (MoA only) Configure aggregator engine + model
//   4. (Debate only) Configure rounds + consensus threshold
//   5. Add supplementary context / questions
//
// On submit → passes MoATriggerInput to parent's onTrigger callback.

"use client"

import { useState, useEffect, useMemo } from "react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Brain, Loader2, Plus, X } from "lucide-react"
import type { Task } from "@octopus/shared"

// ── Constants ──────────────────────────────────────────────────────

export const AVAILABLE_ROLES = [
  { id: "product-manager", label: "📦 产品经理", desc: "需求完整性、用户价值、优先级" },
  { id: "engineering-software-architect", label: "🏛️ 软件架构师", desc: "系统设计、DDD、技术决策" },
  { id: "engineering-code-reviewer", label: "👀 代码审查员", desc: "正确性、可维护性、性能" },
  { id: "engineering-security-engineer", label: "🔒 安全工程师", desc: "威胁建模、漏洞评估" },
  { id: "engineering-sre", label: "🛠️ SRE", desc: "可靠性、SLO、可观测性" },
  { id: "engineering-rapid-prototyper", label: "⚡ 快速原型师", desc: "快速验证想法、MVP 创建" },
  { id: "engineering-frontend-developer", label: "💻 前端开发者", desc: "UI 实现、性能优化" },
  { id: "engineering-codebase-onboarding-engineer", label: "🧭 代码库引导工程师", desc: "快速上手陌生代码库" },
  { id: "prompt-engineer", label: "🧠 提示词工程师", desc: "提示词设计、输出质量优化" },
  { id: "agents-orchestrator", label: "🎭 智能体编排者", desc: "编排多智能体工作流" },
] as const

export const AVAILABLE_ENGINES = [
  { id: "claude", label: "Claude" },
  { id: "pi", label: "Pi" },
] as const

export const AVAILABLE_MODELS = [
  { id: "pro-max", label: "pro-max (最强)" },
  { id: "pro", label: "pro (均衡)" },
  { id: "se", label: "se (轻量)" },
] as const

/** Modes that run through the workflow engine (MoA/Debate). */
export type WorkflowMoAMode = "moa" | "debate"
/** All dialog modes, including the workflow-free single-expert consultation. */
export type MoAMode = WorkflowMoAMode | "single"

export interface ExpertRow {
  id: string
  engine: string
  model: string
  role: string
}

export interface MoATriggerInput {
  goal: string
  ac: string[]
  projects: string[]
  userInput: string
  mode: WorkflowMoAMode
  experts: Array<{ agent: string; engine: string; model: string }>
  aggregator?: { engine: string; model: string }
  rounds?: number
  consensusThreshold?: number
}

export interface SingleExpertInput {
  role: { id: string; label: string }
  /** The composed chat message (explicitly instructs the main agent to invoke
   *  the expert subagent) — this is what gets sent to the session. */
  composedPrompt: string
}

export interface MoATriggerDialogProps {
  task: Task
  open: boolean
  onOpenChange: (open: boolean) => void
  onTrigger: (input: MoATriggerInput) => void
  onConsultSingle?: (input: SingleExpertInput) => void
  running?: boolean
}

// ── Helpers ────────────────────────────────────────────────────────

let rowCounter = 0
function nextRowId() { return `row-${++rowCounter}` }

function makeDefaultRow(role?: string): ExpertRow {
  return { id: nextRowId(), engine: "pi", model: "pro", role: role ?? AVAILABLE_ROLES[0].id }
}

/** Compose the chat message for single-expert consultation. It explicitly names
 *  the subagent the main agent must invoke (the server registers it for this
 *  turn via the SDK `agents` option) and asks for the answer verbatim. */
function buildSingleConsultPrompt(role: { id: string; label: string }, prompt: string): string {
  const q = prompt.trim()
  return [
    `🔍 专家咨询 · ${role.label}（${role.id}）`,
    "",
    `请调用子代理「${role.id}」（${role.label}）来回答下面的问题，并把它的回答原样反馈给我，不要自己代替它回答：`,
    "",
    q,
  ].join("\n")
}

// ── Component ──────────────────────────────────────────────────────

export function MoATriggerDialog({
  task, open, onOpenChange, onTrigger, onConsultSingle, running = false,
}: MoATriggerDialogProps) {
  const spec = task.task_spec
  const goal = spec.goal ?? ""
  const ac = spec.ac ?? []
  const projectNames: string[] = task.project_ids ?? []
  const hasContext = goal || ac.length > 0

  const [mode, setMode] = useState<MoAMode>("moa")
  const [rows, setRows] = useState<ExpertRow[]>([
    { id: nextRowId(), engine: "pi", model: "pro", role: AVAILABLE_ROLES[0].id },
    { id: nextRowId(), engine: "claude", model: "pro-max", role: AVAILABLE_ROLES[1].id },
  ])
  const [aggEngine, setAggEngine] = useState("claude")
  const [aggModel, setAggModel] = useState("pro-max")
  const [rounds, setRounds] = useState(3)
  const [userInput, setUserInput] = useState("")
  // Single-expert mode state
  const [singleRole, setSingleRole] = useState<string>(AVAILABLE_ROLES[0].id)
  const [singlePrompt, setSinglePrompt] = useState("")

  // Reset on dialog close
  useEffect(() => {
    if (!open) {
      setMode("moa")
      setUserInput("")
      setSinglePrompt("")
    }
  }, [open])

  const singleRoleDef = AVAILABLE_ROLES.find((r) => r.id === singleRole) ?? AVAILABLE_ROLES[0]

  // Roles already selected (for debate uniqueness constraint)
  const usedRoles = useMemo(() => new Set(rows.map((r) => r.role)), [rows])

  const addRow = () => {
    // Find first unused role for the new row
    const unusedRole = AVAILABLE_ROLES.find((r) => !usedRoles.has(r.id))
    const defaultRole = unusedRole?.id ?? AVAILABLE_ROLES[0].id
    setRows((prev) => [...prev, makeDefaultRow(defaultRole)])
  }

  const removeRow = (id: string) => {
    setRows((prev) => prev.length > 2 ? prev.filter((r) => r.id !== id) : prev)
  }

  const updateRow = (id: string, field: keyof ExpertRow, value: string) => {
    setRows((prev) => prev.map((r) => r.id === id ? { ...r, [field]: value } : r))
  }

  const handleSubmit = () => {
    if (mode === "single") {
      onConsultSingle?.({
        role: { id: singleRoleDef.id, label: singleRoleDef.label },
        composedPrompt: buildSingleConsultPrompt(singleRoleDef, singlePrompt),
      })
      return
    }
    onTrigger({
      goal,
      ac,
      projects: projectNames,
      userInput: userInput.trim(),
      mode,
      experts: rows.map((r) => ({ agent: r.role, engine: r.engine, model: r.model })),
      aggregator: mode === "moa" ? { engine: aggEngine, model: aggModel } : undefined,
      rounds: mode === "debate" ? rounds : undefined,
    })
  }

  const canSubmit = mode === "single"
    ? singlePrompt.trim().length > 0
    : rows.length >= 2

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[85vh] flex flex-col gap-0 p-0" showCloseButton>
        <DialogHeader className="px-5 pt-4 pb-3 border-b shrink-0">
          <DialogTitle className="text-sm flex items-center gap-2">
            <Brain className="size-4 text-purple-500" />
            专家分析
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            配置参辩角色、引擎和模型，对需求进行多角度评审
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-3 space-y-4 overflow-y-auto flex-1 min-h-0">

          {/* ── Mode selector ── */}
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-medium text-muted-foreground">模式:</span>
            <label className="flex items-center gap-1.5 text-[11px] cursor-pointer">
              <input type="radio" name="moa-mode" checked={mode === "moa"} onChange={() => setMode("moa")} className="accent-purple-600" />
              MoA 多专家并行
            </label>
            <label className="flex items-center gap-1.5 text-[11px] cursor-pointer">
              <input type="radio" name="moa-mode" checked={mode === "debate"} onChange={() => setMode("debate")} className="accent-purple-600" />
              Debate 多轮辩论
            </label>
            <label className="flex items-center gap-1.5 text-[11px] cursor-pointer">
              <input type="radio" name="moa-mode" checked={mode === "single"} onChange={() => setMode("single")} className="accent-purple-600" />
              💬 单专家咨询
            </label>
          </div>

          {/* ── Pre-filled context ── */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium text-muted-foreground">评审输入（来自草稿）</div>
            {hasContext ? (
              <div className="rounded-md border bg-muted/30 p-2.5 space-y-1 text-[11px]">
                {goal && <div><span className="text-muted-foreground font-medium">目标：</span>{goal}</div>}
                {ac.length > 0 && (
                  <div>
                    <span className="text-muted-foreground font-medium">验收标准：</span>
                    <ul className="ml-3 list-disc list-inside">{ac.map((item, i) => <li key={i}>{item}</li>)}</ul>
                  </div>
                )}
                {projectNames.length > 0 && (
                  <div><span className="text-muted-foreground font-medium">涉及项目：</span>{projectNames.join(", ")}</div>
                )}
              </div>
            ) : (
              <div className="rounded-md border border-amber-400/40 bg-amber-500/5 p-2.5 text-[11px] text-amber-600">
                ⚠️ 草稿尚未填写目标或验收标准 — 专家分析可能不够聚焦
              </div>
            )}
          </div>

          {/* ── Expert rows ── */}
          {mode !== "single" && (
          <div className="space-y-2">
            <div className="text-[11px] font-medium text-muted-foreground">
              参辩角色（至少 2 个）
              {mode === "moa" && <span className="ml-1 text-[10px] font-normal">· 角色可重复（对比不同引擎/模型）</span>}
              {mode === "debate" && <span className="ml-1 text-[10px] font-normal">· 角色不可重复（视角必须不同）</span>}
            </div>

            <div className="space-y-1.5">
              {/* Table header */}
              <div className="grid grid-cols-[1fr_1fr_2fr_auto] gap-1.5 px-1 text-[10px] text-muted-foreground">
                <span>引擎</span>
                <span>模型</span>
                <span>角色</span>
                <span className="w-5" />
              </div>

              {rows.map((row) => {
                // For debate: filter out roles already used by OTHER rows
                const availableRoles = mode === "debate"
                  ? AVAILABLE_ROLES.filter((r) => r.id === row.role || !usedRoles.has(r.id))
                  : AVAILABLE_ROLES

                return (
                  <div key={row.id} className="grid grid-cols-[1fr_1fr_2fr_auto] gap-1.5 items-center">
                    <select
                      className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px]"
                      value={row.engine}
                      onChange={(e) => updateRow(row.id, "engine", e.target.value)}
                      disabled={running}
                    >
                      {AVAILABLE_ENGINES.map((eng) => <option key={eng.id} value={eng.id}>{eng.label}</option>)}
                    </select>

                    <select
                      className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px]"
                      value={row.model}
                      onChange={(e) => updateRow(row.id, "model", e.target.value)}
                      disabled={running}
                    >
                      {AVAILABLE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>

                    <select
                      className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px]"
                      value={row.role}
                      onChange={(e) => updateRow(row.id, "role", e.target.value)}
                      disabled={running}
                    >
                      {availableRoles.map((r) => (
                        <option key={r.id} value={r.id}>{r.label} — {r.desc}</option>
                      ))}
                    </select>

                    <button
                      onClick={() => removeRow(row.id)}
                      disabled={rows.length <= 2 || running}
                      className="p-0.5 rounded text-muted-foreground hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
                      title="移除"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                )
              })}

              <Button
                variant="ghost"
                size="sm"
                onClick={addRow}
                disabled={running}
                className="h-6 text-[10px] text-muted-foreground"
              >
                <Plus className="size-3 mr-1" /> 添加角色
              </Button>
            </div>
          </div>
          )}

          {/* ── Single-expert consultation ── */}
          {mode === "single" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="text-[11px] font-medium text-muted-foreground">咨询专家</div>
                <select
                  className="h-7 w-full rounded-md border border-border bg-background px-1.5 text-[11px]"
                  value={singleRole}
                  onChange={(e) => setSingleRole(e.target.value)}
                  disabled={running}
                >
                  {AVAILABLE_ROLES.map((r) => (
                    <option key={r.id} value={r.id}>{r.label} — {r.desc}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-muted-foreground" htmlFor="single-consult-question">
                  咨询问题
                </label>
                <Textarea
                  id="single-consult-question"
                  placeholder="例如：针对这份草稿，请评估验收标准是否完备，并给出补充建议..."
                  value={singlePrompt}
                  onChange={(e) => setSinglePrompt(e.target.value)}
                  className="min-h-[90px] text-[12px] resize-none"
                  disabled={running}
                />
              </div>

              <div className="space-y-1">
                <div className="text-[11px] font-medium text-muted-foreground">将发送到会话（请确认）</div>
                <div className="rounded-md border bg-muted/30 p-2.5 text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                  {buildSingleConsultPrompt(singleRoleDef, singlePrompt) || "请输入咨询问题"}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  提交后由主 agent 调用该专家子代理并反馈回答，不走工作流引擎。
                </p>
              </div>
            </div>
          )}

          {/* ── Mode-specific config ── */}
          {mode === "moa" && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium text-muted-foreground">汇总模型</div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px]"
                  value={aggEngine}
                  onChange={(e) => setAggEngine(e.target.value)}
                  disabled={running}
                >
                  <option value="" className="text-muted-foreground">引擎（同专家）</option>
                  {AVAILABLE_ENGINES.map((eng) => <option key={eng.id} value={eng.id}>{eng.label}</option>)}
                </select>
                <select
                  className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px]"
                  value={aggModel}
                  onChange={(e) => setAggModel(e.target.value)}
                  disabled={running}
                >
                  {AVAILABLE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </div>
            </div>
          )}

          {mode === "debate" && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium text-muted-foreground">辩论设置</div>
              <div className="flex items-center gap-3">
                <label className="text-[11px] flex items-center gap-1.5">
                  <span className="text-muted-foreground">轮数:</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={rounds}
                    onChange={(e) => setRounds(Math.max(1, Math.min(10, parseInt(e.target.value) || 3)))}
                    disabled={running}
                    className="h-7 w-14 rounded-md border border-border bg-background px-1.5 text-[11px] text-center"
                  />
                </label>
              </div>
            </div>
          )}

          {/* ── User input ── */}
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground" htmlFor="moa-user-input">
              补充上下文 / 关注问题（可选）
            </label>
            <Textarea
              id="moa-user-input"
              placeholder="例如：重点关注 API 兼容性、性能瓶颈、是否有遗漏的边界条件..."
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              className="min-h-[70px] text-[12px] resize-none"
              disabled={running}
            />
          </div>
        </div>

        <div className="px-5 py-3 border-t flex items-center justify-between shrink-0">
          <span className="text-[10px] text-muted-foreground">
            {mode === "single"
              ? "提交后将发送到会话，由主 agent 调用专家子代理回复"
              : "分析结果将保存为产物文件，可在聊天中让 agent 读取"}
          </span>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!canSubmit || running}
            className="bg-purple-600 hover:bg-purple-700 text-white"
          >
            {running ? (
              <><Loader2 className="size-3.5 mr-1.5 animate-spin" />处理中…</>
            ) : mode === "single" ? (
              <><Brain className="size-3.5 mr-1.5" />开始咨询</>
            ) : mode === "moa" ? (
              <><Brain className="size-3.5 mr-1.5" />开始分析</>
            ) : (
              <><Brain className="size-3.5 mr-1.5" />开始辩论</>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
