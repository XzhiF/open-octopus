// PROTOTYPE — throwaway UI prototype for task authoring interaction model.
// Three variants switchable via ?variant= URL param.
//
// Question: "What's the best AI-native interaction for task authoring?"
//   A — Chat dominant (70/30) + preset toolbar + compact field chips
//   B — Equal split (50/50) + floating spec card with sections + preset modal
//   C — Chat full width + bottom drawer preview + preset inline
//
// Task types: coding (org/project/skills/goal/ac) vs generic (name/description)

"use client"

import React, { useState, useCallback, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import {
  Settings2, Send, Check, ChevronDown, ChevronUp, X, Plus,
  Code2, FileText, Zap, Bot, Maximize2, Minimize2, Eye,
} from "lucide-react"

// ── Types ──────────────────────────────────────────────────────────

type TaskType = "coding" | "generic"

interface Preset {
  org?: string
  projects?: string[]
  skills?: string[]
}

interface SpecState {
  taskType: TaskType
  preset: Preset
  // Agent-filled fields
  goal: string
  ac: string[]
  subunits: { name: string }[]
  integrationGoal: string
  // Generic fields
  name: string
  description: string
}

// ── Mock data ──────────────────────────────────────────────────────

const ORGS = ["miyuan", "xzf", "open-octopus"]
const PROJECTS_BY_ORG: Record<string, string[]> = {
  miyuan: ["miyuan-web", "miyuan-api", "miyuan-shared"],
  xzf: ["xzf-cli", "xzf-server"],
  "open-octopus": ["octopus-engine", "octopus-web-app", "octopus-server", "octopus-cli"],
}
const SKILLS = ["octo-workflow-dev", "octo-guide", "octo-backend", "octo-frontend", "e2e-harness"]

const MOCK_CHAT = [
  { role: "user" as const, text: "我想给 octopus 加一个实时通知功能，让工作流执行时可以推送消息到 Telegram" },
  { role: "assistant" as const, text: "好的，我来帮你规划这个任务。\n\n目标明确了：给 Octopus 工作流引擎添加 Telegram 通知能力。\n\n让我确认几个问题：\n1. 是每个节点完成后都通知，还是只在关键节点通知？\n2. 需要支持其他渠道（Discord/Slack）吗？\n3. 有没有偏好的 Telegram Bot API 库？" },
  { role: "user" as const, text: "先只做 Telegram，关键节点通知就行。用 telegraf 库" },
  { role: "assistant" as const, text: "明白了！我来整理 spec：\n\n✅ 已绑定 goal: \"给 Octopus 添加 Telegram 实时通知\"\n✅ 已绑定 ac:\n  1. 工作流关键节点完成后通过 Telegram Bot 推送通知\n  2. 使用 telegraf 库对接 Telegram Bot API\n  3. 通知内容包含工作流名、节点名、执行状态\n\n还需要确认：这个项目涉及哪些仓库？" },
]

// ── Initial states ─────────────────────────────────────────────────

function initSpec(type: TaskType): SpecState {
  return {
    taskType: type,
    preset: type === "coding" ? { org: "", projects: [], skills: [] } : {},
    goal: "",
    ac: [],
    subunits: [],
    integrationGoal: "",
    name: "",
    description: "",
  }
}

// Simulate agent filling spec fields over time
function useAgentSimulation(spec: SpecState, setSpec: React.Dispatch<React.SetStateAction<SpecState>>) {
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (step >= 3) return
    const timer = setTimeout(() => {
      setSpec((prev: SpecState) => {
        if (step === 0) return { ...prev, goal: "给 Octopus 添加 Telegram 实时通知" }
        if (step === 1) return { ...prev, ac: ["关键节点完成后推送通知", "使用 telegraf 库", "通知包含工作流名+节点名+状态"] }
        return prev
      })
      setStep(step + 1)
    }, 2000 + step * 1500)
    return () => clearTimeout(timer)
  }, [step, setSpec])
}

// ── Preset Modal (shared by all variants) ──────────────────────────

function PresetModal({
  open, onClose, spec, onChange,
}: {
  open: boolean; onClose: () => void; spec: SpecState; onChange: (s: SpecState) => void
}) {
  const isCoding = spec.taskType === "coding"
  const org = spec.preset.org ?? ORGS[0]
  const projects = spec.preset.projects ?? []
  const skills = spec.preset.skills ?? []

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[520px] max-h-[80vh] p-0 gap-0 flex flex-col">
        <DialogHeader className="px-5 py-3 border-b">
          <DialogTitle className="text-base">⚙️ 任务预设</DialogTitle>
          <DialogDescription className="text-xs">
            预设值会传递给 Agent 和 Preview。不同任务类型有不同预设项。
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="flex-1">
          <div className="p-5 space-y-4">
            {/* Task type selector */}
            <section>
              <Label className="text-xs text-muted-foreground mb-2 block">任务类型</Label>
              <div className="flex gap-2">
                {(["coding", "generic"] as TaskType[]).map((t) => (
                  <Button
                    key={t}
                    variant={spec.taskType === t ? "default" : "outline"}
                    size="sm"
                    onClick={() => onChange({ ...initSpec(t), preset: spec.preset })}
                  >
                    {t === "coding" ? <Code2 className="size-3.5 mr-1.5" /> : <FileText className="size-3.5 mr-1.5" />}
                    {t === "coding" ? "开发任务" : "通用任务"}
                  </Button>
                ))}
              </div>
            </section>

            {isCoding ? (
              <>
                {/* Org */}
                <section>
                  <Label className="text-xs text-muted-foreground mb-1 block">组织 (org)</Label>
                  <select
                    className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
                    value={org}
                    onChange={(e) => onChange({ ...spec, preset: { ...spec.preset, org: e.target.value, projects: [] } })}
                  >
                    {ORGS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </section>

                {/* Projects */}
                <section>
                  <Label className="text-xs text-muted-foreground mb-1 block">项目 (多选)</Label>
                  <div className="space-y-1">
                    {(PROJECTS_BY_ORG[org] ?? []).map((p) => (
                      <label key={p} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={projects.includes(p)}
                          onChange={(e) => onChange({
                            ...spec,
                            preset: {
                              ...spec.preset,
                              projects: e.target.checked ? [...projects, p] : projects.filter((x) => x !== p),
                            },
                          })}
                        />
                        {p}
                      </label>
                    ))}
                  </div>
                </section>

                {/* Skills */}
                <section>
                  <Label className="text-xs text-muted-foreground mb-1 block">技能 (多选)</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {SKILLS.map((s) => (
                      <Badge
                        key={s}
                        variant={skills.includes(s) ? "default" : "outline"}
                        className="cursor-pointer text-xs"
                        onClick={() => onChange({
                          ...spec,
                          preset: {
                            ...spec.preset,
                            skills: skills.includes(s) ? skills.filter((x) => x !== s) : [...skills, s],
                          },
                        })}
                      >
                        {s}
                      </Badge>
                    ))}
                  </div>
                </section>
              </>
            ) : (
              <section className="text-xs text-muted-foreground p-3 rounded-md border border-dashed">
                通用任务无需项目/技能预设。Agent 会在对话中收集所需信息。
              </section>
            )}
          </div>
        </ScrollArea>
        <div className="px-5 py-3 border-t flex justify-end">
          <Button size="sm" onClick={onClose}>确认</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Variant A: Chat Dominant (70/30) + Preset Toolbar ──────────────

function VariantA() {
  const [spec, setSpec] = useState(initSpec("coding"))
  const [presetOpen, setPresetOpen] = useState(false)
  const [chatInput, setChatInput] = useState("")
  useAgentSimulation(spec, setSpec)

  const filledCount = [spec.goal, spec.ac.length > 0, spec.preset.projects?.length! > 0, spec.preset.skills?.length! > 0].filter(Boolean).length

  return (
    <div className="flex flex-col h-full">
      {/* Top toolbar */}
      <div className="px-4 py-2 border-b flex items-center gap-3 bg-muted/30">
        <Badge variant="outline" className="text-xs">
          <Code2 className="size-3 mr-1" /> 开发任务
        </Badge>
        <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => setPresetOpen(true)}>
          <Settings2 className="size-3.5" /> 预设
          {spec.preset.projects?.length ? <Badge variant="secondary" className="ml-1 h-4 text-[10px] px-1">{spec.preset.projects.length}</Badge> : null}
        </Button>
        <div className="ml-auto text-xs text-muted-foreground">
          spec 进度: {filledCount}/4
        </div>
      </div>

      {/* Main: 70/30 split */}
      <div className="flex-1 flex min-h-0">
        {/* Chat (70%) */}
        <div className="flex-[7] flex flex-col min-h-0 border-r">
          <ScrollArea className="flex-1 p-4 space-y-3">
            {MOCK_CHAT.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[80%] rounded-lg p-3 text-sm ${msg.role === "user" ? "bg-blue-500/10" : "bg-muted"}`}>
                  {msg.text}
                </div>
              </div>
            ))}
          </ScrollArea>
          <div className="p-3 border-t flex gap-2">
            <Input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="描述你的需求..." className="flex-1" />
            <Button size="sm"><Send className="size-4" /></Button>
          </div>
        </div>

        {/* Preview (30%) — compact field chips */}
        <div className="flex-[3] flex flex-col min-h-0">
          <div className="px-3 py-2 border-b flex items-center gap-2">
            <Eye className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">Spec 预览</span>
          </div>
          <ScrollArea className="flex-1 p-3">
            <div className="space-y-2">
              <FieldChip label="goal" value={spec.goal} required />
              <FieldChip label="ac" value={spec.ac.length ? spec.ac.join("; ") : ""} required badge={spec.ac.length ? `${spec.ac.length} 条` : undefined} />
              {spec.taskType === "coding" && (
                <>
                  <FieldChip label="projects" value={spec.preset.projects?.join(", ") ?? ""} preset />
                  <FieldChip label="skills" value={spec.preset.skills?.join(", ") ?? ""} preset />
                </>
              )}
              <FieldChip label="subunits" value={spec.subunits.length ? `${spec.subunits.length} 个` : ""} optional />
            </div>
          </ScrollArea>
        </div>
      </div>

      <PresetModal open={presetOpen} onClose={() => setPresetOpen(false)} spec={spec} onChange={setSpec} />
    </div>
  )
}

function FieldChip({ label, value, required, optional, preset, badge }: {
  label: string; value: string; required?: boolean; optional?: boolean; preset?: boolean; badge?: string
}) {
  const filled = !!value
  return (
    <div className={`rounded-md border p-2 text-xs ${filled ? "border-emerald-500/30 bg-emerald-500/5" : optional ? "border-dashed border-border" : "border-orange-500/30 bg-orange-500/5"}`}>
      <div className="flex items-center gap-1.5 mb-0.5">
        {filled ? <Check className="size-3 text-emerald-500" /> : <span className="size-3 rounded-full border border-orange-400" />}
        <span className="font-medium">{label}</span>
        {required && <span className="text-orange-500">*</span>}
        {optional && <span className="text-muted-foreground">(可选)</span>}
        {preset && <span className="text-blue-500 text-[10px]">预设</span>}
        {badge && <Badge variant="secondary" className="h-4 text-[10px] px-1 ml-auto">{badge}</Badge>}
      </div>
      {value && <div className="text-muted-foreground truncate">{value}</div>}
    </div>
  )
}

// ── Variant B: Equal Split (50/50) + Floating Spec Card ────────────

function VariantB() {
  const [spec, setSpec] = useState(initSpec("coding"))
  const [presetOpen, setPresetOpen] = useState(false)
  const [chatInput, setChatInput] = useState("")
  useAgentSimulation(spec, setSpec)

  return (
    <div className="flex flex-col h-full">
      {/* Header with task type + preset */}
      <div className="px-4 py-2 border-b flex items-center gap-3">
        <select
          className="h-7 rounded-md border border-border bg-background px-2 text-xs"
          value={spec.taskType}
          onChange={(e) => setSpec(initSpec(e.target.value as TaskType))}
        >
          <option value="coding">🛠 开发任务</option>
          <option value="generic">📄 通用任务</option>
        </select>
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => setPresetOpen(true)}>
          <Settings2 className="size-3.5" /> 配置预设
        </Button>
      </div>

      {/* 50/50 split */}
      <div className="flex-1 flex min-h-0">
        {/* Chat (50%) */}
        <div className="flex-1 flex flex-col min-h-0 border-r">
          <ScrollArea className="flex-1 p-4 space-y-3">
            {MOCK_CHAT.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-lg p-3 text-sm ${msg.role === "user" ? "bg-blue-500/10" : "bg-muted"}`}>
                  {msg.text}
                </div>
              </div>
            ))}
          </ScrollArea>
          <div className="p-3 border-t flex gap-2">
            <Input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="描述你的需求..." className="flex-1" />
            <Button size="sm"><Send className="size-4" /></Button>
          </div>
        </div>

        {/* Spec Card (50%) — sectioned card */}
        <div className="flex-1 flex flex-col min-h-0 bg-muted/20">
          <ScrollArea className="flex-1 p-4">
            <div className="max-w-sm mx-auto space-y-4">
              <div className="text-center">
                <h3 className="text-sm font-semibold">📋 Task Spec</h3>
                <p className="text-[11px] text-muted-foreground mt-0.5">Agent 对话中自动填充，你可以微调</p>
              </div>

              {/* Required section */}
              <SpecSection title="必填" icon="🔴">
                <SpecRow label="目标 (goal)" value={spec.goal} required />
                <SpecRow label="验收标准 (ac)" value={spec.ac.length ? `${spec.ac.length} 条` : ""} required
                  detail={spec.ac.length ? spec.ac : undefined} />
              </SpecSection>

              {/* Preset section */}
              {spec.taskType === "coding" && (
                <SpecSection title="预设" icon="⚙️">
                  <SpecRow label="组织" value={spec.preset.org ?? ""} preset />
                  <SpecRow label="项目" value={spec.preset.projects?.join(", ") ?? ""} preset
                    badge={spec.preset.projects?.length ? `${spec.preset.projects.length}` : undefined} />
                  <SpecRow label="技能" value={spec.preset.skills?.join(", ") ?? ""} preset
                    badge={spec.preset.skills?.length ? `${spec.preset.skills.length}` : undefined} />
                </SpecSection>
              )}

              {/* Optional section */}
              <SpecSection title="可选" icon="⚪">
                <SpecRow label="子单元 (subunits)" value={spec.subunits.length ? `${spec.subunits.length} 个` : ""} optional />
                <SpecRow label="整合策略" value={spec.integrationGoal || ""} optional />
              </SpecSection>

              {/* Action */}
              <div className="pt-2 flex gap-2">
                <Button size="sm" variant="outline" className="flex-1 text-xs" onClick={() => setPresetOpen(true)}>
                  <Settings2 className="size-3.5 mr-1" /> 修改预设
                </Button>
                <Button size="sm" className="flex-1 text-xs">
                  <Zap className="size-3.5 mr-1" /> 入队
                </Button>
              </div>
            </div>
          </ScrollArea>
        </div>
      </div>

      <PresetModal open={presetOpen} onClose={() => setPresetOpen(false)} spec={spec} onChange={setSpec} />
    </div>
  )
}

function SpecSection({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-background">
      <div className="px-3 py-1.5 border-b text-xs font-medium flex items-center gap-1.5">
        <span>{icon}</span> {title}
      </div>
      <div className="divide-y">{children}</div>
    </div>
  )
}

function SpecRow({ label, value, required, optional, preset, detail, badge }: {
  label: string; value: string; required?: boolean; optional?: boolean; preset?: boolean; detail?: string[]; badge?: string
}) {
  const filled = !!value
  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className={`size-1.5 rounded-full ${filled ? "bg-emerald-500" : required ? "bg-orange-400" : "bg-muted-foreground/30"}`} />
        <span className="font-medium">{label}</span>
        {required && !filled && <span className="text-[10px] text-orange-500">待填写</span>}
        {preset && <Badge variant="outline" className="h-4 text-[10px] px-1">预设</Badge>}
        {badge && <Badge variant="secondary" className="h-4 text-[10px] px-1 ml-auto">{badge}</Badge>}
      </div>
      {value && !detail && <div className="text-xs text-muted-foreground mt-0.5 pl-4 truncate">{value}</div>}
      {detail && (
        <ul className="mt-1 pl-4 space-y-0.5">
          {detail.map((d, i) => <li key={i} className="text-xs text-muted-foreground">• {d}</li>)}
        </ul>
      )}
    </div>
  )
}

// ── Variant C: Chat Full Width + Bottom Drawer Preview ─────────────

function VariantC() {
  const [spec, setSpec] = useState(initSpec("coding"))
  const [presetOpen, setPresetOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(true)
  const [chatInput, setChatInput] = useState("")
  useAgentSimulation(spec, setSpec)

  const filledCount = [spec.goal, spec.ac.length > 0].filter(Boolean).length

  return (
    <div className="flex flex-col h-full relative">
      {/* Toolbar */}
      <div className="px-4 py-2 border-b flex items-center gap-3">
        <Badge variant="outline" className="text-xs">
          <Code2 className="size-3 mr-1" /> 开发任务
        </Badge>
        <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => setPresetOpen(true)}>
          <Settings2 className="size-3.5" /> 预设
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">spec: {filledCount}/2 必填</span>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => setDrawerOpen(!drawerOpen)}>
            {drawerOpen ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
            {drawerOpen ? "收起预览" : "展开预览"}
          </Button>
        </div>
      </div>

      {/* Chat — full width, adjusts height based on drawer */}
      <div className={`flex flex-col min-h-0 ${drawerOpen ? "flex-[7]" : "flex-1"}`}>
        <ScrollArea className="flex-1 p-4 space-y-3">
          {MOCK_CHAT.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[75%] rounded-lg p-3 text-sm ${msg.role === "user" ? "bg-blue-500/10" : "bg-muted"}`}>
                {msg.text}
              </div>
            </div>
          ))}
        </ScrollArea>
        <div className="p-3 border-t flex gap-2">
          <Input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="描述你的需求..." className="flex-1" />
          <Button size="sm"><Send className="size-4" /></Button>
        </div>
      </div>

      {/* Bottom drawer — slides up */}
      {drawerOpen && (
        <div className="flex-[3] border-t-2 border-primary/20 bg-muted/20 flex flex-col min-h-0">
          <div className="px-4 py-2 border-b flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Eye className="size-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">Spec 预览</span>
              {filledCount > 0 && <Badge variant="secondary" className="h-4 text-[10px]">{filledCount}/2 已填</Badge>}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setPresetOpen(true)}>修改预设</Button>
              <Button size="sm" className="h-6 text-xs"><Zap className="size-3 mr-1" />入队</Button>
            </div>
          </div>
          <ScrollArea className="flex-1 p-3">
            {/* Horizontal card layout */}
            <div className="flex gap-3 flex-wrap">
              <PreviewCard
                title="goal"
                value={spec.goal}
                required
                filled={!!spec.goal}
                icon="🎯"
              />
              <PreviewCard
                title="ac"
                value={spec.ac.length ? `${spec.ac.length} 条验收标准` : ""}
                required
                filled={spec.ac.length > 0}
                icon="✅"
                detail={spec.ac}
              />
              <PreviewCard
                title="projects"
                value={spec.preset.projects?.join(", ") ?? ""}
                filled={!!spec.preset.projects?.length}
                icon="📁"
                tag="预设"
              />
              <PreviewCard
                title="skills"
                value={spec.preset.skills?.join(", ") ?? ""}
                filled={!!spec.preset.skills?.length}
                icon="🔧"
                tag="预设"
              />
            </div>
          </ScrollArea>
        </div>
      )}

      <PresetModal open={presetOpen} onClose={() => setPresetOpen(false)} spec={spec} onChange={setSpec} />
    </div>
  )
}

function PreviewCard({ title, value, required, filled, icon, detail, tag }: {
  title: string; value: string; required?: boolean; filled: boolean; icon: string; detail?: string[]; tag?: string
}) {
  return (
    <div className={`rounded-lg border p-3 min-w-[180px] max-w-[240px] flex-1 ${filled ? "border-emerald-500/30 bg-emerald-500/5" : required ? "border-orange-500/30 bg-orange-500/5" : "border-border bg-background"}`}>
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-sm">{icon}</span>
        <span className="text-xs font-medium">{title}</span>
        {required && !filled && <span className="text-[10px] text-orange-500 ml-auto">必填</span>}
        {tag && <Badge variant="outline" className="h-4 text-[10px] px-1 ml-auto">{tag}</Badge>}
      </div>
      {value && !detail && <div className="text-xs text-muted-foreground line-clamp-2">{value}</div>}
      {detail && (
        <ul className="space-y-0.5">
          {detail.map((d, i) => <li key={i} className="text-[11px] text-muted-foreground">• {d}</li>)}
        </ul>
      )}
      {!value && !detail && <div className="text-[11px] text-muted-foreground/50 italic">等待填写...</div>}
    </div>
  )
}

// ── Variant D: 结构化全流程 (定死) ─────────────────────────────────

const MOCK_CHAT_D = [
  { role: "user" as const, text: "我想给 octopus 加一个 Telegram 通知功能" },
  { role: "assistant" as const, text: "🔍 **澄清阶段**\n\n明确了目标方向。几个关键问题：\n1. 每个节点都通知还是关键节点？\n2. 用哪个 Telegram 库？\n3. 需要支持其他渠道吗？" },
  { role: "user" as const, text: "关键节点，用 telegraf，先只做 Telegram" },
  { role: "assistant" as const, text: "📝 **决策已记录**\n\n✅ goal 已绑定\n✅ ac 已绑定 (3 条)\n📌 决策记录:\n  - 通知范围: 关键节点 (非每个节点)\n  - 技术选型: telegraf (非 node-telegram-bot-api)\n  - 渠道: 仅 Telegram (暂不做 Discord/Slack)\n\n接下来选择执行工作流..." },
]

const MOCK_DECISIONS = [
  { question: "通知范围？", answer: "关键节点完成时", reason: "避免消息轰炸" },
  { question: "Telegram 库？", answer: "telegraf", reason: "社区活跃，类型支持好" },
  { question: "其他渠道？", answer: "暂不支持", reason: "MVP 先做 Telegram" },
]

function VariantD() {
  const [spec, setSpec] = useState(initSpec("coding"))
  const [presetOpen, setPresetOpen] = useState(false)
  const [chatInput, setChatInput] = useState("")
  const [phase, setPhase] = useState<"preset" | "chat" | "spec" | "workflow" | "ready">("chat")
  const [selectedWf, setSelectedWf] = useState("")
  useAgentSimulation(spec, setSpec)

  const phases = [
    { key: "preset", label: "① 预设", done: !!spec.preset.org },
    { key: "chat", label: "② 澄清", done: spec.goal !== "" },
    { key: "spec", label: "③ Spec", done: spec.ac.length > 0 },
    { key: "workflow", label: "④ 工作流", done: !!selectedWf },
    { key: "ready", label: "⑤ 入队", done: false },
  ] as const

  const workflows = [
    { ref: "default-dev.yaml", label: "标准开发流程", desc: "build → test → deploy" },
    { ref: "feature-branch.yaml", label: "特性分支流程", desc: "branch → dev → PR → merge" },
    { ref: "hotfix.yaml", label: "热修复流程", desc: "快速修复 → 测试 → 部署" },
  ]

  return (
    <div className="flex flex-col h-full">
      {/* Phase progress bar */}
      <div className="px-4 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-1">
          {phases.map((p, i) => (
            <React.Fragment key={p.key}>
              <button
                onClick={() => setPhase(p.key as typeof phase)}
                className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${
                  phase === p.key ? "bg-primary text-primary-foreground" :
                  p.done ? "bg-emerald-500/15 text-emerald-600" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {p.label}
              </button>
              {i < phases.length - 1 && <span className="text-muted-foreground/30">→</span>}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Main: 50/50 */}
      <div className="flex-1 flex min-h-0">
        {/* Chat */}
        <div className="flex-1 flex flex-col min-h-0 border-r">
          <ScrollArea className="flex-1 p-4 space-y-3">
            {MOCK_CHAT_D.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-lg p-3 text-sm whitespace-pre-line ${msg.role === "user" ? "bg-blue-500/10" : "bg-muted"}`}>
                  {msg.text}
                </div>
              </div>
            ))}
          </ScrollArea>
          <div className="p-3 border-t flex gap-2">
            <Input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="描述你的需求..." className="flex-1" />
            <Button size="sm"><Send className="size-4" /></Button>
          </div>
        </div>

        {/* Right: phase-dependent preview */}
        <div className="flex-1 flex flex-col min-h-0 bg-muted/20">
          <ScrollArea className="flex-1 p-4">
            <div className="max-w-sm mx-auto space-y-4">

              {phase === "preset" && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-center">⚙️ 步骤 ①：任务预设</h3>
                  <p className="text-[11px] text-muted-foreground text-center">设置后传递给 Agent，Agent 据此调整对话上下文</p>
                  <div className="rounded-lg border bg-background p-4 space-y-3">
                    <div><Label className="text-xs">组织</Label><div className="text-sm mt-1">{spec.preset.org || "未设置"}</div></div>
                    <div><Label className="text-xs">项目</Label><div className="text-sm mt-1">{spec.preset.projects?.join(", ") || "未选择"}</div></div>
                    <div><Label className="text-xs">技能</Label><div className="text-sm mt-1">{spec.preset.skills?.join(", ") || "未选择"}</div></div>
                    <Button size="sm" variant="outline" onClick={() => setPresetOpen(true)}><Settings2 className="size-3.5 mr-1" /> 配置预设</Button>
                  </div>
                </div>
              )}

              {phase === "chat" && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-center">💬 步骤 ②：对话澄清</h3>
                  <p className="text-[11px] text-muted-foreground text-center">Agent 通过提问澄清需求，关键决策自动记录</p>
                  <div className="rounded-lg border bg-background">
                    <div className="px-3 py-2 border-b text-xs font-medium">📌 已记录的决策</div>
                    {MOCK_DECISIONS.map((d, i) => (
                      <div key={i} className="px-3 py-2 border-b last:border-0">
                        <div className="text-xs font-medium">{d.question}</div>
                        <div className="text-xs text-emerald-600 mt-0.5">→ {d.answer}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">{d.reason}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {phase === "spec" && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-center">📋 步骤 ③：Spec 预览</h3>
                  <SpecSection title="Spec 产物" icon="📋">
                    <SpecRow label="goal" value={spec.goal} required />
                    <SpecRow label="ac" value={spec.ac.length ? `${spec.ac.length} 条` : ""} required detail={spec.ac.length ? spec.ac : undefined} />
                    <SpecRow label="projects" value={spec.preset.projects?.join(", ") ?? ""} preset />
                    <SpecRow label="skills" value={spec.preset.skills?.join(", ") ?? ""} preset />
                  </SpecSection>
                  <div className="rounded-lg border bg-background p-3">
                    <div className="text-xs font-medium mb-1">📌 关键决策 (附在 spec 中)</div>
                    {MOCK_DECISIONS.map((d, i) => (
                      <div key={i} className="text-[11px] text-muted-foreground">• {d.question} → <span className="text-emerald-600">{d.answer}</span></div>
                    ))}
                  </div>
                  <Button size="sm" className="w-full text-xs" onClick={() => setPhase("workflow")}>确认 Spec →</Button>
                </div>
              )}

              {phase === "workflow" && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-center">⚡ 步骤 ④：选择工作流</h3>
                  <p className="text-[11px] text-muted-foreground text-center">Agent 推荐，你确认</p>
                  {workflows.map((wf) => (
                    <button
                      key={wf.ref}
                      onClick={() => setSelectedWf(wf.ref)}
                      className={`w-full text-left rounded-lg border p-3 transition-colors ${
                        selectedWf === wf.ref ? "border-primary bg-primary/5" : "bg-background hover:bg-muted/50"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`size-3 rounded-full border-2 ${selectedWf === wf.ref ? "border-primary bg-primary" : "border-muted-foreground/30"}`} />
                        <span className="text-xs font-medium">{wf.label}</span>
                        <Badge variant="outline" className="ml-auto text-[10px]">{wf.ref}</Badge>
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-1 pl-5">{wf.desc}</div>
                    </button>
                  ))}
                  {selectedWf && <Button size="sm" className="w-full text-xs" onClick={() => setPhase("ready")}>确认 →</Button>}
                </div>
              )}

              {phase === "ready" && (
                <div className="space-y-4 text-center">
                  <div className="text-3xl">🚀</div>
                  <h3 className="text-sm font-semibold">准备入队</h3>
                  <div className="rounded-lg border bg-background p-4 text-left text-xs space-y-2">
                    <div><span className="text-muted-foreground">goal:</span> {spec.goal || "..."}</div>
                    <div><span className="text-muted-foreground">ac:</span> {spec.ac.length} 条</div>
                    <div><span className="text-muted-foreground">projects:</span> {spec.preset.projects?.join(", ")}</div>
                    <div><span className="text-muted-foreground">workflow:</span> {selectedWf}</div>
                    <div><span className="text-muted-foreground">decisions:</span> {MOCK_DECISIONS.length} 条</div>
                  </div>
                  <Button className="w-full"><Zap className="size-4 mr-1" /> 入队执行</Button>
                </div>
              )}

            </div>
          </ScrollArea>
        </div>
      </div>

      <PresetModal open={presetOpen} onClose={() => setPresetOpen(false)} spec={spec} onChange={setSpec} />
    </div>
  )
}

// ── Variant E: 技能驱动自由流 (自由) ──────────────────────────────

const SKILLS_AVAILABLE = [
  { name: "open-spec", desc: "产出 spec.md 文档（目标/范围/约束/决策）", icon: "📄" },
  { name: "matt-verified-requirement", desc: "产出 user stories + 验证策略 + AC", icon: "📝" },
  { name: "domain-modeling", desc: "产出领域模型 + 术语表 + ADR", icon: "🏗️" },
  { name: "design-an-interface", desc: "产出多个接口设计方案对比", icon: "🎨" },
]

const MOCK_CHAT_E = [
  { role: "user" as const, text: "我想给 octopus 加一个 Telegram 通知功能" },
  { role: "assistant" as const, text: "好的！我可以用不同的技能来帮你规划：\n\n📄 `/open-spec` — 产出完整 spec 文档\n📝 `/matt-verified-requirement` — 产出 stories + AC\n🏗️ `/domain-modeling` — 建模通知领域\n\n你想用哪个开始？或者你直接说需求，我来建议。" },
  { role: "user" as const, text: "/open-spec" },
  { role: "assistant" as const, text: "📄 **启动 open-spec 技能**\n\n正在生成 spec.md...\n\n---\n## Telegram 通知功能\n\n### 目标\n给 Octopus 工作流引擎添加 Telegram 实时通知\n\n### 范围\n- 关键节点完成后推送\n- 使用 telegraf 库\n- 暂不支持其他渠道\n\n### 约束\n- 不阻塞工作流执行\n- 配置存储在 org settings\n\n---\n\n✅ **Artifact 已生成** → 见右侧 Preview\n\n需要进一步用 `/matt-verified-requirement` 细化 stories 吗？" },
]

interface Artifact {
  type: string
  title: string
  icon: string
  content: string
  timestamp: string
}

function VariantE() {
  const [chatInput, setChatInput] = useState("")
  const [artifacts, setArtifacts] = useState<Artifact[]>([
    {
      type: "spec",
      title: "spec.md — Telegram 通知功能",
      icon: "📄",
      content: "## 目标\n给 Octopus 添加 Telegram 实时通知\n\n## 范围\n- 关键节点推送\n- telegraf 库\n- 仅 Telegram\n\n## 约束\n- 不阻塞执行\n- 配置存 org settings",
      timestamp: "2 min ago",
    },
  ])
  const [skillMenuOpen, setSkillMenuOpen] = useState(false)

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="px-4 py-2 border-b flex items-center gap-3">
        <Badge variant="outline" className="text-xs">
          <Bot className="size-3 mr-1" /> 自由模式
        </Badge>
        <div className="relative">
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => setSkillMenuOpen(!skillMenuOpen)}>
            <Zap className="size-3.5" /> 可用技能
          </Button>
          {skillMenuOpen && (
            <div className="absolute top-full left-0 mt-1 z-50 w-72 rounded-lg border bg-background shadow-lg p-2 space-y-1">
              {SKILLS_AVAILABLE.map((s) => (
                <button
                  key={s.name}
                  onClick={() => { setSkillMenuOpen(false); setChatInput(`/${s.name} `) }}
                  className="w-full text-left rounded-md p-2 hover:bg-muted transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span>{s.icon}</span>
                    <span className="text-xs font-medium">/{s.name}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5 pl-6">{s.desc}</div>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="ml-auto text-xs text-muted-foreground">
          {artifacts.length} 个产物
        </div>
      </div>

      {/* Main: 50/50 */}
      <div className="flex-1 flex min-h-0">
        {/* Chat */}
        <div className="flex-1 flex flex-col min-h-0 border-r">
          <ScrollArea className="flex-1 p-4 space-y-3">
            {MOCK_CHAT_E.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-lg p-3 text-sm whitespace-pre-line ${msg.role === "user" ? "bg-blue-500/10" : "bg-muted"}`}>
                  {msg.text}
                </div>
              </div>
            ))}
          </ScrollArea>
          <div className="p-3 border-t flex gap-2">
            <Input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="描述需求 或 /skill-name 调用技能..." className="flex-1" />
            <Button size="sm"><Send className="size-4" /></Button>
          </div>
        </div>

        {/* Artifacts panel — dynamic, not fixed fields */}
        <div className="flex-1 flex flex-col min-h-0 bg-muted/20">
          <div className="px-4 py-2 border-b flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="size-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">产物 (Artifacts)</span>
            </div>
            <Button variant="ghost" size="sm" className="h-6 text-xs" disabled={!artifacts.length}>
              <Zap className="size-3 mr-1" /> 入队
            </Button>
          </div>
          <ScrollArea className="flex-1 p-4">
            {artifacts.length === 0 ? (
              <div className="text-center py-12">
                <div className="text-3xl mb-2">🎯</div>
                <p className="text-sm text-muted-foreground">Agent 将根据使用的技能</p>
                <p className="text-sm text-muted-foreground">生成不同格式的产物</p>
                <p className="text-xs text-muted-foreground/60 mt-2">试试 /open-spec 或 /matt-verified-requirement</p>
              </div>
            ) : (
              <div className="space-y-3 max-w-sm mx-auto">
                {artifacts.map((a, i) => (
                  <div key={i} className="rounded-lg border bg-background overflow-hidden">
                    <div className="px-3 py-2 border-b flex items-center gap-2 bg-muted/30">
                      <span>{a.icon}</span>
                      <span className="text-xs font-medium flex-1">{a.title}</span>
                      <span className="text-[10px] text-muted-foreground">{a.timestamp}</span>
                    </div>
                    <div className="p-3">
                      <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap font-sans">{a.content}</pre>
                    </div>
                    <div className="px-3 py-1.5 border-t bg-muted/20 flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">{a.type}</Badge>
                      <span className="text-[10px] text-muted-foreground ml-auto">
                        入队时自动匹配执行方式
                      </span>
                    </div>
                  </div>
                ))}

                {/* Potential next artifacts hint */}
                <div className="rounded-lg border border-dashed p-3 text-center">
                  <p className="text-[11px] text-muted-foreground">可以继续调用技能产出更多产物：</p>
                  <div className="flex flex-wrap gap-1.5 mt-2 justify-center">
                    {SKILLS_AVAILABLE.filter((s) => !artifacts.some((a) => a.title.includes(s.name))).map((s) => (
                      <Badge
                        key={s.name}
                        variant="outline"
                        className="text-[10px] cursor-pointer hover:bg-muted"
                        onClick={() => setChatInput(`/${s.name} `)}
                      >
                        {s.icon} /{s.name}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </ScrollArea>
        </div>
      </div>
    </div>
  )
}

// ── Variant F: 综合模型 (Task Type + Methodology + Artifacts) ──────

const METHODOLOGIES = [
  { id: "default", name: "默认通用", icon: "⚡", desc: "内置：goal + AC → 直接执行", skills: ["内置 spec-field 绑定"] },
  { id: "open-spec", name: "Open Spec", icon: "📄", desc: "spec.md 文档驱动", skills: ["/open-spec", "/spec-review", "/spec-to-tasks"] },
  { id: "matt-pocock", name: "Matt Pocock Skills", icon: "🎯", desc: "类型安全 + TDD 方法论", skills: ["/design-an-interface", "/tdd", "/simplify"] },
  { id: "superpower-zh", name: "超能力中文", icon: "🚀", desc: "中文开发方法论套件", skills: ["/xzf-clarify", "/xzf-spec-designer", "/xzf-implementer"] },
  { id: "matt-dev", name: "Matt Dev Pipeline", icon: "🏭", desc: "全流水线：需求→开发→E2E→交付", skills: ["/matt-verified-requirement", "/matt-dev-pipeline", "/matt-e2e-tester"] },
]

interface VariantFState {
  taskType: TaskType
  methodology: string
  preset: Preset
  // Artifacts from skills
  artifacts: { skill: string; title: string; icon: string; content: string; status: "generating" | "done" | "reviewing" }[]
}

const MOCK_CHAT_F = [
  { role: "user" as const, text: "我想给 octopus 加一个 Telegram 通知功能" },
  { role: "assistant" as const, text: "🎯 当前方案：**Open Spec** (spec.md 文档驱动)\n\n我来用 `/open-spec` 帮你生成规格文档。\n\n先确认几点：\n1. 通知触发时机？（每个节点 / 关键节点 / 自定义）\n2. 需要通知哪些信息？（状态/耗时/错误详情）\n3. 配置方式？（全局 / 每工作流）" },
  { role: "user" as const, text: "关键节点，通知状态+耗时，全局配置" },
  { role: "assistant" as const, text: "📄 `/open-spec` 执行中...\n\n正在生成 spec.md 文档 →\n\n✅ **Artifact 已生成**：spec.md\n包含：目标 / 范围 / 约束 / 决策记录\n\n接下来可以：\n• `/spec-to-tasks` 把 spec 拆成执行任务\n• `/spec-review` 审查 spec 完整性\n• 或直接 [入队] 用默认工作流执行" },
]

function VariantF() {
  const [state, setState] = useState<VariantFState>({
    taskType: "coding",
    methodology: "open-spec",
    preset: { org: "open-octopus", projects: ["octopus-server", "octopus-engine"], skills: ["octo-backend"] },
    artifacts: [
      {
        skill: "open-spec",
        title: "spec.md — Telegram 通知功能",
        icon: "📄",
        status: "done",
        content: "# Telegram 通知功能\n\n## 目标\n给 Octopus 工作流引擎添加 Telegram 实时通知能力\n\n## 范围\n- 关键节点完成后推送通知\n- 通知内容：工作流名 + 节点名 + 状态 + 耗时\n- 全局配置（org settings 级别）\n\n## 约束\n- 不阻塞工作流执行（异步推送）\n- 使用 telegraf 库\n- 仅 Telegram（v1）\n\n## 决策\n- Q: 触发时机？→ 关键节点\n- Q: 通知内容？→ 状态 + 耗时\n- Q: 配置级别？→ 全局",
      },
    ],
  })
  const [chatInput, setChatInput] = useState("")
  const [configOpen, setConfigOpen] = useState(false)

  const currentMethod = METHODOLOGIES.find((m) => m.id === state.methodology) ?? METHODOLOGIES[0]

  return (
    <div className="flex flex-col h-full">
      {/* Top config bar */}
      <div className="px-4 py-2 border-b bg-muted/30 flex items-center gap-3 flex-wrap">
        {/* Task type */}
        <select
          className="h-7 rounded-md border border-border bg-background px-2 text-xs"
          value={state.taskType}
          onChange={(e) => setState({ ...state, taskType: e.target.value as TaskType })}
        >
          <option value="coding">🛠 开发任务</option>
          <option value="generic">📄 通用任务</option>
        </select>

        {/* Methodology */}
        <select
          className="h-7 rounded-md border border-border bg-background px-2 text-xs"
          value={state.methodology}
          onChange={(e) => setState({ ...state, methodology: e.target.value })}
        >
          {METHODOLOGIES.map((m) => (
            <option key={m.id} value={m.id}>{m.icon} {m.name}</option>
          ))}
        </select>

        {/* Presets summary + edit button */}
        {state.taskType === "coding" && (
          <div className="flex items-center gap-1.5 text-xs">
            <Badge variant="outline" className="text-[10px]">{state.preset.org}</Badge>
            <Badge variant="secondary" className="text-[10px]">{state.preset.projects?.length ?? 0} 项目</Badge>
            <Badge variant="secondary" className="text-[10px]">{state.preset.skills?.length ?? 0} 技能</Badge>
            <Button variant="ghost" size="sm" className="h-6 text-[10px] px-1.5" onClick={() => setConfigOpen(true)}>
              <Settings2 className="size-3" /> 编辑
            </Button>
          </div>
        )}

        {/* Artifacts count */}
        <div className="ml-auto text-xs text-muted-foreground">
          {state.artifacts.length} 个产物
        </div>
      </div>

      {/* Main: 50/50 */}
      <div className="flex-1 flex min-h-0">
        {/* Chat (left) */}
        <div className="flex-1 flex flex-col min-h-0 border-r">
          {/* Methodology skills bar */}
          <div className="px-3 py-1.5 border-b bg-background flex items-center gap-2 overflow-x-auto">
            <span className="text-[10px] text-muted-foreground shrink-0">{currentMethod.icon} 可用命令:</span>
            {currentMethod.skills.map((s) => (
              <button
                key={s}
                onClick={() => setChatInput(s.startsWith("/") ? `${s} ` : "")}
                className="shrink-0 px-2 py-0.5 rounded text-[10px] bg-muted hover:bg-accent transition-colors"
              >
                {s}
              </button>
            ))}
          </div>

          <ScrollArea className="flex-1 p-4 space-y-3">
            {MOCK_CHAT_F.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-lg p-3 text-sm whitespace-pre-line ${msg.role === "user" ? "bg-blue-500/10" : "bg-muted"}`}>
                  {msg.text}
                </div>
              </div>
            ))}
          </ScrollArea>

          <div className="p-3 border-t flex gap-2">
            <Input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="描述需求 或 /command 调用技能..." className="flex-1" />
            <Button size="sm"><Send className="size-4" /></Button>
          </div>
        </div>

        {/* Right: Config + Artifacts */}
        <div className="flex-1 flex flex-col min-h-0 bg-muted/20">
          <ScrollArea className="flex-1 p-4">
            <div className="max-w-sm mx-auto space-y-4">

              {/* Methodology info */}
              <div className="rounded-lg border bg-background p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-lg">{currentMethod.icon}</span>
                  <div>
                    <div className="text-sm font-semibold">{currentMethod.name}</div>
                    <div className="text-[11px] text-muted-foreground">{currentMethod.desc}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {currentMethod.skills.map((s) => (
                    <Badge key={s} variant="outline" className="text-[10px]">{s}</Badge>
                  ))}
                </div>
              </div>

              {/* Presets (coding only) */}
              {state.taskType === "coding" && (
                <div className="rounded-lg border bg-background">
                  <div className="px-3 py-2 border-b text-xs font-medium flex items-center gap-2">
                    <Settings2 className="size-3.5" /> 预设配置
                    <Button variant="ghost" size="sm" className="h-5 text-[10px] ml-auto px-1.5" onClick={() => setConfigOpen(true)}>编辑</Button>
                  </div>
                  <div className="px-3 py-2 space-y-1.5">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground w-12">组织</span>
                      <Badge variant="secondary" className="text-[10px]">{state.preset.org}</Badge>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground w-12">项目</span>
                      <div className="flex flex-wrap gap-1">
                        {state.preset.projects?.map((p) => <Badge key={p} variant="secondary" className="text-[10px]">{p}</Badge>)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground w-12">技能</span>
                      <div className="flex flex-wrap gap-1">
                        {state.preset.skills?.map((s) => <Badge key={s} variant="secondary" className="text-[10px]">{s}</Badge>)}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Artifacts */}
              <div>
                <div className="text-xs font-medium mb-2 flex items-center gap-2">
                  <FileText className="size-3.5" /> 产物 ({state.artifacts.length})
                </div>
                <div className="space-y-2">
                  {state.artifacts.map((a, i) => (
                    <div key={i} className="rounded-lg border bg-background overflow-hidden">
                      <div className="px-3 py-2 border-b flex items-center gap-2">
                        <span>{a.icon}</span>
                        <span className="text-xs font-medium flex-1 truncate">{a.title}</span>
                        <Badge variant={a.status === "done" ? "secondary" : "outline"}
                          className={`text-[10px] ${a.status === "done" ? "bg-emerald-500/15 text-emerald-600" : ""}`}>
                          {a.status === "done" ? "✅ 完成" : a.status === "generating" ? "⏳ 生成中" : "👁 审核中"}
                        </Badge>
                      </div>
                      <div className="p-3 max-h-[200px] overflow-y-auto">
                        <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap font-sans">{a.content}</pre>
                      </div>
                      <div className="px-3 py-1.5 border-t bg-muted/20 flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">/{a.skill}</Badge>
                        <span className="text-[10px] text-muted-foreground ml-auto">入队时自动匹配执行方式</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Next actions */}
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="flex-1 text-xs" disabled={!state.artifacts.length}>
                  <Zap className="size-3.5 mr-1" /> 入队执行
                </Button>
              </div>
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* Config Modal (reuses PresetModal pattern) */}
      <Dialog open={configOpen} onOpenChange={(o) => !o && setConfigOpen(false)}>
        <DialogContent className="sm:max-w-[520px] max-h-[80vh] p-0 gap-0 flex flex-col">
          <DialogHeader className="px-5 py-3 border-b">
            <DialogTitle className="text-base">⚙️ 任务配置</DialogTitle>
            <DialogDescription className="text-xs">
              预设会在对话前传递给 Agent。如不预设，Agent 会在对话中确认并写入配置。
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="flex-1">
            <div className="p-5 space-y-4">
              <section>
                <Label className="text-xs text-muted-foreground mb-1 block">组织</Label>
                <select
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
                  value={state.preset.org ?? ""}
                  onChange={(e) => setState({ ...state, preset: { ...state.preset, org: e.target.value, projects: [] } })}
                >
                  {ORGS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </section>
              <section>
                <Label className="text-xs text-muted-foreground mb-1 block">项目 (多选)</Label>
                <div className="space-y-1">
                  {(PROJECTS_BY_ORG[state.preset.org ?? ORGS[0]] ?? []).map((p) => (
                    <label key={p} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={state.preset.projects?.includes(p) ?? false}
                        onChange={(e) => setState({
                          ...state,
                          preset: {
                            ...state.preset,
                            projects: e.target.checked
                              ? [...(state.preset.projects ?? []), p]
                              : (state.preset.projects ?? []).filter((x) => x !== p),
                          },
                        })}
                      />
                      {p}
                    </label>
                  ))}
                </div>
              </section>
              <section>
                <Label className="text-xs text-muted-foreground mb-1 block">技能 (多选)</Label>
                <div className="flex flex-wrap gap-1.5">
                  {SKILLS.map((s) => (
                    <Badge
                      key={s}
                      variant={state.preset.skills?.includes(s) ? "default" : "outline"}
                      className="cursor-pointer text-xs"
                      onClick={() => setState({
                        ...state,
                        preset: {
                          ...state.preset,
                          skills: state.preset.skills?.includes(s)
                            ? state.preset.skills.filter((x) => x !== s)
                            : [...(state.preset.skills ?? []), s],
                        },
                      })}
                    >
                      {s}
                    </Badge>
                  ))}
                </div>
              </section>
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                💡 不设置预设也行 — Agent 会在对话中确认这些信息并自动写入配置。
              </div>
            </div>
          </ScrollArea>
          <div className="px-5 py-3 border-t flex justify-end">
            <Button size="sm" onClick={() => setConfigOpen(false)}>确认</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Variant G: 架构可视化 — Skill 加载与产物收集方案对比 ─────────

const SKILL_SOURCES = [
  { path: "packages/core-pack/skills/", label: "core-pack 内置", example: "task-author, octo-workflow-dev", color: "text-blue-500" },
  { path: "~/.octopus/resources/installed/skills/", label: "全局安装", example: "open-spec, mattpocock-skills/*", color: "text-emerald-500" },
  { path: "<cwd>/.claude/skills/", label: "项目本地", example: "项目专属 skills", color: "text-orange-500" },
]

function VariantG() {
  const [approach, setApproach] = useState<"A" | "B" | "C">("B")
  const [showDetail, setShowDetail] = useState<string | null>(null)

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-6 max-w-4xl mx-auto w-full space-y-6">

        {/* Header */}
        <div>
          <h2 className="text-lg font-bold">🏗️ 架构难点分析：Skill 加载 × 产物收集</h2>
          <p className="text-sm text-muted-foreground mt-1">
            task-author agent 如何使用不同来源的 skills？不同 skill 的产物放哪里？
          </p>
        </div>

        {/* Current skill sources */}
        <section className="rounded-lg border p-4">
          <h3 className="text-sm font-semibold mb-3">📂 Skill 来源（当前实际状态）</h3>
          <div className="space-y-2">
            {SKILL_SOURCES.map((s) => (
              <div key={s.path} className="flex items-start gap-3 text-xs">
                <code className={`font-mono shrink-0 ${s.color}`}>{s.path}</code>
                <span className="text-muted-foreground">{s.label} — {s.example}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-md bg-orange-500/10 border border-orange-500/20 p-3 text-xs">
            ⚠️ <strong>问题</strong>：task-author clone 运行在 server 进程里，它的 CWD 是 server 的 CWD（主仓库）。
            全局安装的 skills（~/.octopus/resources/installed/）不在 CWD 里，agent 无法直接 Read 它们。
          </div>
        </section>

        {/* Three approaches */}
        <section>
          <h3 className="text-sm font-semibold mb-3">🔀 三种实现方案</h3>
          <div className="flex gap-2 mb-4">
            {(["A", "B", "C"] as const).map((a) => (
              <Button
                key={a}
                variant={approach === a ? "default" : "outline"}
                size="sm"
                onClick={() => setApproach(a)}
              >
                方案 {a}
              </Button>
            ))}
          </div>

          {approach === "A" && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-blue-500/5 p-4">
                <h4 className="text-sm font-semibold">方案 A：System Prompt 全量注入</h4>
                <p className="text-xs text-muted-foreground mt-1">选方法论 → 读所有 SKILL.md → 拼进 system prompt</p>
              </div>

              <pre className="text-[11px] bg-muted rounded-lg p-4 overflow-x-auto whitespace-pre">{`
┌─ Methodology 选择 ─────────────────────────────────┐
│ "open-spec"                                        │
│   → 解析 installPath                               │
│   → 读 SKILL.md (1-3 个文件)                       │
│   → 全部拼入 systemPrompt.append                   │
└────────────────────────────────────────────────────┘
         │
         ▼
┌─ Claude Agent System Prompt ──────────────────────┐
│ [persona] + [authoring_resources] + [methodology   │
│  skills SKILL.md 内容]                             │
│                                                    │
│ Agent 知道 /open-spec 怎么用（SKILL.md 里有说明）  │
│ Agent 用 Bash/Read/Write 工具执行 SKILL 指令       │
└────────────────────────────────────────────────────┘
              `}</pre>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-md bg-emerald-500/10 border border-emerald-500/20 p-3">
                  <div className="font-semibold text-emerald-600 mb-1">✅ 优点</div>
                  <ul className="space-y-1 text-muted-foreground">
                    <li>• 实现简单（现有 augmenter 模式）</li>
                    <li>• Agent 自然理解 skill 指令</li>
                    <li>• 无需新基建</li>
                  </ul>
                </div>
                <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3">
                  <div className="font-semibold text-red-500 mb-1">❌ 缺点</div>
                  <ul className="space-y-1 text-muted-foreground">
                    <li>• Token 爆炸（3 个 SKILL.md ≈ 10K+ tokens）</li>
                    <li>• 方法论切换需重建 session</li>
                    <li>• 无法运行时动态加载新 skill</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {approach === "B" && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-emerald-500/5 p-4">
                <h4 className="text-sm font-semibold">方案 B：摘要注入 + Agent 按需 Read（推荐）</h4>
                <p className="text-xs text-muted-foreground mt-1">
                  system prompt 只放 skill 索引（名称+描述），Agent 需要时 Read 完整 SKILL.md
                </p>
              </div>

              <pre className="text-[11px] bg-muted rounded-lg p-4 overflow-x-auto whitespace-pre">{`
┌─ Methodology 选择 ─────────────────────────────────┐
│ "open-spec"                                        │
│   → 扫描 installPath 下所有 skills/                │
│   → 提取每个 SKILL.md 的 frontmatter               │
│     (name, description, version)                   │
│   → 生成 skill 索引表注入 system prompt            │
└────────────────────────────────────────────────────┘
         │
         ▼
┌─ Claude System Prompt (精简) ─────────────────────┐
│ [persona]                                          │
│                                                    │
│ ## 可用技能 (Open Spec 方法论)                     │
│ | 命令 | 描述 | 详情路径 |                         │
│ | /open-spec | 生成 spec.md | ~/.octopus/.../SKILL │
│ | /spec-review | 审查 spec | ~/.octopus/.../SKILL  │
│                                                    │
│ 使用某技能时，先 Read 完整 SKILL.md 获取详细指令   │
└────────────────────────────────────────────────────┘
         │
         ▼ 用户输入 /open-spec
         │
┌─ Agent 行为 ──────────────────────────────────────┐
│ 1. Read("~/.octopus/.../open-spec/SKILL.md")       │
│ 2. 按 SKILL.md 指令执行（Bash/Write 等）           │
│ 3. 产物写入 .scratch/task-{id}/open-spec/          │
└────────────────────────────────────────────────────┘
              `}</pre>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-md bg-emerald-500/10 border border-emerald-500/20 p-3">
                  <div className="font-semibold text-emerald-600 mb-1">✅ 优点</div>
                  <ul className="space-y-1 text-muted-foreground">
                    <li>• Token 节省（索引 ≈ 500 tokens vs 10K+）</li>
                    <li>• 运行时动态 Read 任意 skill</li>
                    <li>• 切换方法论只改索引，不重建 session</li>
                    <li>• 复用现有 Read 工具，无新基建</li>
                  </ul>
                </div>
                <div className="rounded-md bg-orange-500/10 border border-orange-500/20 p-3">
                  <div className="font-semibold text-orange-500 mb-1">⚠️ 注意</div>
                  <ul className="space-y-1 text-muted-foreground">
                    <li>• Agent 需多一步 Read 才知详情</li>
                    <li>• SKILL.md 路径需绝对路径（非 CWD 相对）</li>
                    <li>• 需确保 Read 工具可访问 ~/.octopus/ 路径</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {approach === "C" && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-purple-500/5 p-4">
                <h4 className="text-sm font-semibold">方案 C：注册为 Custom Tools</h4>
                <p className="text-xs text-muted-foreground mt-1">
                  每个 skill 注册为 Claude SDK 的 custom tool，Agent 直接调用
                </p>
              </div>

              <pre className="text-[11px] bg-muted rounded-lg p-4 overflow-x-auto whitespace-pre">{`
┌─ Methodology 选择 ─────────────────────────────────┐
│ "open-spec"                                        │
│   → 扫描 skills/ → 解析 SKILL.md frontmatter       │
│   → 为每个 skill 创建 custom tool definition:       │
│     {                                              │
│       name: "open_spec",                           │
│       description: "生成 spec.md 文档",             │
│       input_schema: { task_description: string }    │
│     }                                              │
└────────────────────────────────────────────────────┘
         │
         ▼
┌─ Claude Agent (带 custom tools) ──────────────────┐
│ [persona] + [tools: Bash, Read, Write,             │
│                      open_spec, spec_review, ...]   │
│                                                    │
│ Agent 调用 open_spec tool →                        │
│   Server handler: Read SKILL.md →                  │
│     构建子 agent prompt → 执行 → 返回产物          │
└────────────────────────────────────────────────────┘
              `}</pre>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-md bg-emerald-500/10 border border-emerald-500/20 p-3">
                  <div className="font-semibold text-emerald-600 mb-1">✅ 优点</div>
                  <ul className="space-y-1 text-muted-foreground">
                    <li>• 最干净的抽象</li>
                    <li>• 前端可追踪 tool call</li>
                    <li>• 产物收集方便（tool return value）</li>
                  </ul>
                </div>
                <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3">
                  <div className="font-semibold text-red-500 mb-1">❌ 缺点</div>
                  <ul className="space-y-1 text-muted-foreground">
                    <li>• 需要大量新基建（tool registry, handler）</li>
                    <li>• 每个 skill 的 input_schema 难标准化</li>
                    <li>• skill 本质是"指令"不是"函数"，强行 tool 化会失真</li>
                    <li>• Claude SDK 的 tool 数量有限</li>
                  </ul>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Artifact collection */}
        <section className="rounded-lg border p-4">
          <h3 className="text-sm font-semibold mb-3">📦 产物收集方案（与 Skill 加载正交）</h3>
          <pre className="text-[11px] bg-muted rounded-lg p-4 overflow-x-auto whitespace-pre">{`
方案：统一 .scratch 目录 + 约定式收集

.scratch/task-{taskId}/
├── open-spec/
│   └── spec.md              ← /open-spec 产物
├── matt-verified-req/
│   ├── spec.md              ← /matt-verified-requirement 产物
│   ├── stories/
│   │   ├── 01-xxx.md
│   │   └── 02-yyy.md
│   └── verification-strategy.md
├── domain-model/
│   ├── glossary.md          ← /domain-modeling 产物
│   └── adr-001.md
└── artifacts.json           ← 产物索引（agent 维护）

artifacts.json 格式:
[
  { "skill": "open-spec", "type": "spec",
    "path": "open-spec/spec.md",
    "title": "Telegram 通知功能", "status": "done" },
  { "skill": "matt-verified-req", "type": "stories",
    "path": "matt-verified-req/stories/",
    "title": "3 user stories", "status": "done" }
]

收集方式：
1. Agent 用 Write 工具写入 .scratch/task-{id}/{skill}/
2. 完成后写 artifacts.json 索引
3. Preview 面板读 artifacts.json → 渲染产物卡片
          `}</pre>

          <div className="mt-3 rounded-md bg-blue-500/10 border border-blue-500/20 p-3 text-xs">
            💡 <strong>关键</strong>：SKILL.md 里需要约定产物输出路径。可以在 SKILL.md frontmatter 加
            <code className="mx-1 bg-muted px-1 rounded">output_dir</code> 字段，
            agent 据此知道往哪写。或者更简单：persona 里统一约定
            <code className="mx-1 bg-muted px-1 rounded">.scratch/task-$TASK_ID/$SKILL_NAME/</code>。
          </div>
        </section>

        {/* Recommendation */}
        <section className="rounded-lg border-2 border-primary/30 bg-primary/5 p-4">
          <h3 className="text-sm font-semibold mb-2">⭐ 推荐：方案 B + 统一 .scratch</h3>
          <div className="text-xs space-y-2">
            <p><strong>Skill 加载</strong>：摘要索引注入 system prompt + Agent 按需 Read 完整 SKILL.md</p>
            <p><strong>Slash 命令</strong>：前端识别 <code>/command</code> → 在消息前加
              <code className="mx-1 bg-muted px-1 rounded">请先 Read SKILL.md 然后执行 /command 的指令</code>
              → Agent 自然执行</p>
            <p><strong>产物收集</strong>：统一 <code>.scratch/task-{'{id}'}/{'{skill}'}/</code> 目录 + artifacts.json 索引</p>
            <p><strong>CWD 问题</strong>：全局 skills 用绝对路径（~/.octopus/resources/installed/.../SKILL.md），
              Read 工具不受 CWD 限制</p>
          </div>
        </section>

      </div>
    </div>
  )
}

// ── Variant H: 综合模型 + 推荐架构 (F + B 方案实现) ──────────────

function VariantH() {
  const [state, setState] = useState<VariantFState>({
    taskType: "coding",
    methodology: "open-spec",
    preset: { org: "open-octopus", projects: ["octopus-server"], skills: ["octo-backend"] },
    artifacts: [
      {
        skill: "open-spec",
        title: "spec.md — Telegram 通知功能",
        icon: "📄",
        status: "done",
        content: "# Telegram 通知功能\n\n## 目标\n给 Octopus 工作流引擎添加 Telegram 实时通知\n\n## 范围\n- 关键节点推送\n- telegraf 库\n- 仅 Telegram (v1)\n\n## 产物路径\n.scratch/task-abc123/open-spec/spec.md",
      },
    ],
  })
  const [chatInput, setChatInput] = useState("")
  const [showArch, setShowArch] = useState(false)

  const currentMethod = METHODOLOGIES.find((m) => m.id === state.methodology) ?? METHODOLOGIES[0]

  // Skill index that would be injected into system prompt
  const skillIndex = currentMethod.skills.map((s) => {
    const name = s.replace("/", "")
    return { cmd: s, name, path: `~/.octopus/resources/installed/${state.methodology}/skills/${name}/SKILL.md` }
  })

  return (
    <div className="flex flex-col h-full">
      {/* Config bar */}
      <div className="px-4 py-2 border-b bg-muted/30 flex items-center gap-3 flex-wrap">
        <select className="h-7 rounded-md border border-border bg-background px-2 text-xs" value={state.taskType}
          onChange={(e) => setState({ ...state, taskType: e.target.value as TaskType })}>
          <option value="coding">🛠 开发任务</option>
          <option value="generic">📄 通用任务</option>
        </select>
        <select className="h-7 rounded-md border border-border bg-background px-2 text-xs" value={state.methodology}
          onChange={(e) => setState({ ...state, methodology: e.target.value })}>
          {METHODOLOGIES.map((m) => <option key={m.id} value={m.id}>{m.icon} {m.name}</option>)}
        </select>
        {state.taskType === "coding" && (
          <div className="flex items-center gap-1.5 text-xs">
            <Badge variant="outline" className="text-[10px]">{state.preset.org}</Badge>
            <Badge variant="secondary" className="text-[10px]">{state.preset.projects?.length ?? 0} 项目</Badge>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => setShowArch(!showArch)}>
            {showArch ? "隐藏架构" : "🔍 架构透视"}
          </Button>
          <span className="text-xs text-muted-foreground">{state.artifacts.length} 产物</span>
        </div>
      </div>

      {/* Architecture overlay */}
      {showArch && (
        <div className="border-b bg-blue-500/5 px-4 py-3">
          <div className="text-xs space-y-2">
            <div className="font-semibold">🔍 System Prompt 注入内容（方案 B: 摘要索引）</div>
            <pre className="text-[10px] bg-muted rounded p-2 overflow-x-auto whitespace-pre">{`## ${currentMethod.name} 方法论 — 可用技能

| 命令 | 说明 | SKILL.md 路径 |
|------|------|---------------|
${skillIndex.map((s) => `| ${s.cmd} | ${s.name} | ${s.path} |`).join("\n")}

使用技能时，先 Read 完整 SKILL.md 获取详细指令。
产物统一写入 .scratch/task-{id}/{skill-name}/ 目录。
完成后更新 .scratch/task-{id}/artifacts.json 索引。`}</pre>
            <div className="text-[10px] text-muted-foreground">
              ≈ {skillIndex.length * 80} tokens（仅索引）vs 全量注入 ≈ 10,000+ tokens
            </div>
          </div>
        </div>
      )}

      {/* Main 50/50 */}
      <div className="flex-1 flex min-h-0">
        {/* Chat */}
        <div className="flex-1 flex flex-col min-h-0 border-r">
          <div className="px-3 py-1.5 border-b bg-background flex items-center gap-2 overflow-x-auto">
            <span className="text-[10px] text-muted-foreground shrink-0">{currentMethod.icon}</span>
            {currentMethod.skills.map((s) => (
              <button key={s} onClick={() => setChatInput(s.startsWith("/") ? `${s} ` : "")}
                className="shrink-0 px-2 py-0.5 rounded text-[10px] bg-muted hover:bg-accent transition-colors">
                {s}
              </button>
            ))}
          </div>

          <ScrollArea className="flex-1 p-4 space-y-3">
            {/* Architecture annotations on chat messages */}
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-lg p-3 text-sm bg-blue-500/10">
                我想给 octopus 加一个 Telegram 通知功能
              </div>
            </div>
            {showArch && (
              <div className="flex justify-start">
                <div className="max-w-[60%] rounded-md border border-dashed border-blue-400/50 p-2 text-[10px] text-blue-600 bg-blue-500/5">
                  🔍 <strong>架构透视</strong>：用户消息直接发送给 Agent。Agent 在 system prompt 中已有方法论技能索引。
                </div>
              </div>
            )}
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-lg p-3 text-sm bg-muted whitespace-pre-line">
                好的！当前使用 <strong>Open Spec</strong> 方法论。{"\n\n"}
                可用命令：/open-spec /spec-review /spec-to-tasks{"\n\n"}
                建议先执行 <code className="bg-muted-foreground/20 px-1 rounded">/open-spec</code> 生成规格文档。
                需要我先问几个澄清问题吗？
              </div>
            </div>
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-lg p-3 text-sm bg-blue-500/10">
                /open-spec 关键节点通知，用 telegraf
              </div>
            </div>
            {showArch && (
              <div className="flex justify-start">
                <div className="max-w-[60%] rounded-md border border-dashed border-emerald-400/50 p-2 text-[10px] text-emerald-600 bg-emerald-500/5">
                  🔍 <strong>Agent 执行流</strong>：<br/>
                  1. 识别 /open-spec 命令<br/>
                  2. <code>Read("~/.octopus/.../open-spec/SKILL.md")</code><br/>
                  3. 按 SKILL.md 指令生成 spec.md<br/>
                  4. <code>Write(".scratch/task-abc/open-spec/spec.md", ...)</code><br/>
                  5. 更新 artifacts.json
                </div>
              </div>
            )}
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-lg p-3 text-sm bg-muted whitespace-pre-line">
                📄 <code>/open-spec</code> 执行完成！{"\n\n"}
                ✅ spec.md 已生成{"\n"}
                📁 路径: <code>.scratch/task-abc123/open-spec/spec.md</code>{"\n\n"}
                包含：目标 / 范围 / 约束 / 决策记录{"\n\n"}
                接下来可以：{"\n"}
                • <code>/spec-to-tasks</code> 拆成执行任务{"\n"}
                • <code>/spec-review</code> 审查完整性{"\n"}
                • 直接 [入队] 执行
              </div>
            </div>
          </ScrollArea>

          <div className="p-3 border-t flex gap-2">
            <Input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="描述需求 或 /command..." className="flex-1" />
            <Button size="sm"><Send className="size-4" /></Button>
          </div>
        </div>

        {/* Right: Artifacts + File tree */}
        <div className="flex-1 flex flex-col min-h-0 bg-muted/20">
          <ScrollArea className="flex-1 p-4">
            <div className="max-w-sm mx-auto space-y-4">

              {/* Method + Skill Index */}
              <div className="rounded-lg border bg-background p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-lg">{currentMethod.icon}</span>
                  <div>
                    <div className="text-sm font-semibold">{currentMethod.name}</div>
                    <div className="text-[11px] text-muted-foreground">方案 B: 摘要索引注入，按需 Read</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {currentMethod.skills.map((s) => (
                    <Badge key={s} variant="outline" className="text-[10px] cursor-pointer" onClick={() => setChatInput(s.startsWith("/") ? `${s} ` : "")}>
                      {s}
                    </Badge>
                  ))}
                </div>
              </div>

              {/* .scratch file tree */}
              <div className="rounded-lg border bg-background">
                <div className="px-3 py-2 border-b text-xs font-medium">
                  📁 .scratch/task-abc123/
                </div>
                <div className="px-3 py-2 font-mono text-[11px] space-y-0.5">
                  <div className="text-emerald-600">├── open-spec/</div>
                  <div className="text-emerald-600 pl-4">├── spec.md ✅</div>
                  <div className="text-muted-foreground/40">├── matt-verified-req/</div>
                  <div className="text-muted-foreground/30 pl-4">└── (未生成)</div>
                  <div className="text-muted-foreground/40">├── domain-model/</div>
                  <div className="text-muted-foreground/30 pl-4">└── (未生成)</div>
                  <div className="text-blue-500">└── artifacts.json</div>
                </div>
              </div>

              {/* Artifacts */}
              <div>
                <div className="text-xs font-medium mb-2">产物 ({state.artifacts.length})</div>
                {state.artifacts.map((a, i) => (
                  <div key={i} className="rounded-lg border bg-background overflow-hidden mb-2">
                    <div className="px-3 py-2 border-b flex items-center gap-2">
                      <span>{a.icon}</span>
                      <span className="text-xs font-medium flex-1 truncate">{a.title}</span>
                      <Badge className="text-[10px] bg-emerald-500/15 text-emerald-600">✅</Badge>
                    </div>
                    <div className="p-3 max-h-[160px] overflow-y-auto">
                      <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap font-sans">{a.content}</pre>
                    </div>
                    <div className="px-3 py-1.5 border-t bg-muted/20 flex items-center gap-2 text-[10px]">
                      <Badge variant="outline" className="text-[10px]">/{a.skill}</Badge>
                      <span className="text-muted-foreground">→ .scratch/task-abc123/{a.skill}/</span>
                    </div>
                  </div>
                ))}
              </div>

              <Button size="sm" className="w-full text-xs" disabled={!state.artifacts.length}>
                <Zap className="size-3.5 mr-1" /> 入队执行
              </Button>
            </div>
          </ScrollArea>
        </div>
      </div>
    </div>
  )
}

// ── Variant I: 修订版综合模型 (v3) ─────────────────────────────────
// 修复 H 的问题：预设弹窗回归 · Goal/AC 永久置顶可确认 · 完整 Spec Review ·
// 架构透视改为真实 SDK 机制（plugin 扫描 → frontmatter 索引 → Skill 工具）

interface VariantIArtifact {
  skill: string
  title: string
  icon: string
  path: string
  unified: boolean // true = 统一 artifacts_dir; false = skill 原生位置（登记）
}

interface VariantIState {
  taskType: TaskType
  methodology: string
  preset: Preset
  goalConfirmed: boolean
  acConfirmed: boolean
  artifacts: VariantIArtifact[]
}

function VariantI() {
  const [state, setState] = useState<VariantIState>({
    taskType: "coding",
    methodology: "open-spec",
    preset: { org: "open-octopus", projects: ["octopus-server"], skills: ["octo-backend"] },
    goalConfirmed: false,
    acConfirmed: false,
    artifacts: [
      {
        skill: "task-author",
        title: "task_spec.json — 结构化规格",
        icon: "🧾",
        path: "~/.octopus/tasks/t-8f3a/artifacts/task_spec.json",
        unified: true,
      },
      {
        skill: "open-spec",
        title: "proposal.md — Telegram 通知变更提案",
        icon: "📄",
        path: "octopus-server/openspec/changes/telegram-notify/proposal.md",
        unified: false,
      },
    ],
  })
  const [chatInput, setChatInput] = useState("")
  const [showArch, setShowArch] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(true)

  const currentMethod = METHODOLOGIES.find((m) => m.id === state.methodology) ?? METHODOLOGIES[0]
  const goal = "给 Octopus 工作流引擎添加 Telegram 实时通知"
  const ac = ["关键节点完成后推送通知", "使用 telegraf 库", "通知包含工作流名+节点名+状态"]
  const canEnqueue = state.goalConfirmed && state.acConfirmed

  const patch = (p: Partial<VariantIState>) => setState((s) => ({ ...s, ...p }))

  return (
    <div className="flex flex-col h-full">
      {/* Config bar */}
      <div className="px-4 py-2 border-b bg-muted/30 flex items-center gap-2 flex-wrap">
        <select className="h-7 rounded-md border border-border bg-background px-2 text-xs" value={state.taskType}
          onChange={(e) => patch({ taskType: e.target.value as TaskType })}>
          <option value="coding">🛠 开发任务</option>
          <option value="generic">📄 通用任务</option>
        </select>
        <select className="h-7 rounded-md border border-border bg-background px-2 text-xs" value={state.methodology}
          onChange={(e) => patch({ methodology: e.target.value })}>
          {METHODOLOGIES.map((m) => <option key={m.id} value={m.id}>{m.icon} {m.name}</option>)}
        </select>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setPresetOpen(true)}>
          <Settings2 className="size-3.5 mr-1" /> 预设
        </Button>
        {state.taskType === "coding" && (
          <div className="flex items-center gap-1.5 text-xs">
            <Badge variant="outline" className="text-[10px]">{state.preset.org || "未选组织"}</Badge>
            <Badge variant="secondary" className="text-[10px]">{state.preset.projects?.length ?? 0} 项目</Badge>
            <Badge variant="secondary" className="text-[10px]">{state.preset.skills?.length ?? 0} 技能</Badge>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => setShowArch(!showArch)}>
            {showArch ? "隐藏架构" : "🔍 架构透视"}
          </Button>
        </div>
      </div>

      {/* Architecture overlay — 真实 SDK 机制 */}
      {showArch && (
        <div className="border-b bg-blue-500/5 px-4 py-3 grid grid-cols-2 gap-3 text-[10px]">
          <div className="space-y-1">
            <div className="font-semibold">① 会话启动 · Plugin 扫描 <span className="text-muted-foreground font-normal">(clone-runtime.getPlugins, ADR-006)</span></div>
            <pre className="bg-muted rounded p-2 overflow-x-auto whitespace-pre">{`plugins = [
  ~/.octopus/agent/                    ← 共享 skills
  ~/.octopus/agent/built-in/task-author/ ← clone 专属
  ~/.octopus/tasks/t-8f3a/skills/      ← ★ 本任务方法论
]   // SDK 扫描各目录的 skills/ 子目录（非递归）`}</pre>
            <div className="text-muted-foreground">选择方法论后，server 把套件 skills 从 resources/installed/{state.methodology}/skills/* symlink 到任务 plugin 目录</div>
          </div>
          <div className="space-y-1">
            <div className="font-semibold">② System Prompt 注入 <span className="text-muted-foreground font-normal">(SDK 自动 · 渐进式披露)</span></div>
            <pre className="bg-muted rounded p-2 overflow-x-auto whitespace-pre">{`只读 SKILL.md 的 YAML frontmatter：
---
name: open-spec
description: spec.md 文档驱动开发方法论
---
→ 注入「可用技能」列表 ≈20 tokens/skill
→ 完整 SKILL.md 正文【不注入】`}</pre>
          </div>
          <div className="space-y-1">
            <div className="font-semibold">③ 按需加载 · Skill 工具</div>
            <pre className="bg-muted rounded p-2 overflow-x-auto whitespace-pre">{`模型调用 Skill("open-spec")
  → SDK 注入完整 SKILL.md 到上下文
  → agent 按指令执行
/slash 命令 = Skill 工具调用（SDK 原生）
关联 skills 同目录可发现 → 无需 user prompt 告知`}</pre>
          </div>
          <div className="space-y-1">
            <div className="font-semibold">④ 产物目录 <span className="text-muted-foreground font-normal">(system prompt 追加一行)</span></div>
            <pre className="bg-muted rounded p-2 overflow-x-auto whitespace-pre">{`本任务产物目录: ~/.octopus/tasks/t-8f3a/artifacts/
· octopus 原生 skills → 写入统一目录
· 方法论 skills → 原生位置 + 登记产物索引
· 编写期中央存储（不假定 cwd）
· 执行期 → {repo}/.scratch/task-{slug}/`}</pre>
          </div>
        </div>
      )}

      {/* Main 50/50 */}
      <div className="flex-1 flex min-h-0">
        {/* Left: Chat */}
        <div className="flex-1 flex flex-col min-h-0 border-r">
          <div className="px-3 py-1.5 border-b bg-background flex items-center gap-2 overflow-x-auto">
            <span className="text-[10px] text-muted-foreground shrink-0">{currentMethod.icon} {currentMethod.name}:</span>
            {currentMethod.skills.map((s) => (
              <button key={s} onClick={() => setChatInput(s.startsWith("/") ? `${s} ` : "")}
                className="shrink-0 px-2 py-0.5 rounded text-[10px] bg-muted hover:bg-accent transition-colors">
                {s}
              </button>
            ))}
          </div>

          <ScrollArea className="flex-1 p-4 space-y-3">
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-lg p-3 text-sm bg-blue-500/10">
                我想给 octopus 加一个 Telegram 通知功能
              </div>
            </div>
            {showArch && (
              <div className="flex justify-start">
                <div className="max-w-[60%] rounded-md border border-dashed border-blue-400/50 p-2 text-[10px] text-blue-600 bg-blue-500/5">
                  🔍 预设（组织/项目/技能）在会话创建时已随 system prompt 传给 agent。方法论 skills 经 per-task plugin 目录被 SDK 索引。
                </div>
              </div>
            )}
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-lg p-3 text-sm bg-muted whitespace-pre-line">
                好的！当前方法论：<strong>{currentMethod.name}</strong>。{"\n\n"}
                我先澄清几点：{"\n"}
                1. 通知触发时机？（每个节点 / 关键节点）{"\n"}
                2. 通知内容？（状态/耗时/错误）{"\n"}
                3. 配置方式？（全局 / 每工作流）
              </div>
            </div>
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-lg p-3 text-sm bg-blue-500/10">
                /open-spec 关键节点通知，状态+耗时，全局配置
              </div>
            </div>
            {showArch && (
              <div className="flex justify-start">
                <div className="max-w-[60%] rounded-md border border-dashed border-emerald-400/50 p-2 text-[10px] text-emerald-600 bg-emerald-500/5">
                  🔍 <strong>Skill 工具调用</strong>：<br/>
                  1. Skill(&quot;open-spec&quot;) → SDK 注入完整 SKILL.md<br/>
                  2. 按 SKILL.md 生成 proposal.md<br/>
                  3. Write → 原生位置 openspec/changes/...<br/>
                  4. 登记产物索引（登记不搬迁）<br/>
                  5. spec-field 绑定 goal/ac → 右侧实时刷新
                </div>
              </div>
            )}
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-lg p-3 text-sm bg-muted whitespace-pre-line">
                📄 <code>/open-spec</code> 执行完成！{"\n\n"}
                ✅ proposal.md 已生成并登记产物索引{"\n"}
                🎯 已绑定 goal + ac → 右侧等你确认{"\n\n"}
                接下来可以：{"\n"}
                • <code>/spec-review</code> 审查完整性{"\n"}
                • 右侧确认 goal/ac 后 [入队]
              </div>
            </div>
          </ScrollArea>

          <div className="p-3 border-t flex gap-2">
            <Input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="描述需求 或 /command..." className="flex-1" />
            <Button size="sm"><Send className="size-4" /></Button>
          </div>
        </div>

        {/* Right: Preview */}
        <div className="flex-1 flex flex-col min-h-0 bg-muted/20">
          <ScrollArea className="flex-1 p-4">
            <div className="max-w-sm mx-auto space-y-3">

              {/* 1. Goal / AC — 永久置顶，显式确认 */}
              <div className="rounded-lg border-2 border-amber-400/40 bg-background overflow-hidden">
                <div className="px-3 py-2 border-b bg-amber-400/10 flex items-center gap-2">
                  <span className="text-xs font-semibold">🎯 目标 & 验收标准</span>
                  <span className="text-[10px] text-muted-foreground">任何任务类型都必须确认</span>
                </div>
                <div className="p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <button onClick={() => patch({ goalConfirmed: !state.goalConfirmed })}
                      className={`mt-0.5 size-4 rounded-full border flex items-center justify-center shrink-0 text-[10px] ${state.goalConfirmed ? "bg-emerald-500 text-white border-emerald-500" : "border-muted-foreground/40"}`}>
                      {state.goalConfirmed && <Check className="size-3" />}
                    </button>
                    <div>
                      <div className="text-[10px] text-muted-foreground mb-0.5">goal</div>
                      <div className="text-xs">{goal}</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <button onClick={() => patch({ acConfirmed: !state.acConfirmed })}
                      className={`mt-0.5 size-4 rounded-full border flex items-center justify-center shrink-0 text-[10px] ${state.acConfirmed ? "bg-emerald-500 text-white border-emerald-500" : "border-muted-foreground/40"}`}>
                      {state.acConfirmed && <Check className="size-3" />}
                    </button>
                    <div>
                      <div className="text-[10px] text-muted-foreground mb-0.5">ac（验收标准）</div>
                      <ul className="text-xs space-y-0.5">
                        {ac.map((a, i) => <li key={i}>• {a}</li>)}
                      </ul>
                    </div>
                  </div>
                </div>
              </div>

              {/* 2. 方法论 + skills */}
              <div className="rounded-lg border bg-background p-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <span>{currentMethod.icon}</span>
                  <div className="text-xs font-medium flex-1">{currentMethod.name}</div>
                  <span className="text-[10px] text-muted-foreground">SDK 原生索引</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {currentMethod.skills.map((s) => (
                    <Badge key={s} variant="outline" className="text-[10px] cursor-pointer" onClick={() => setChatInput(s.startsWith("/") ? `${s} ` : "")}>{s}</Badge>
                  ))}
                </div>
              </div>

              {/* 3. 产物索引（登记不搬迁） */}
              <div className="rounded-lg border bg-background">
                <div className="px-3 py-2 border-b flex items-center justify-between">
                  <span className="text-xs font-medium">📁 产物索引 ({state.artifacts.length})</span>
                  <span className="text-[10px] text-muted-foreground">登记，不搬迁</span>
                </div>
                <div className="divide-y">
                  {state.artifacts.map((a, i) => (
                    <div key={i} className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{a.icon}</span>
                        <span className="text-xs flex-1 truncate">{a.title}</span>
                        <Badge className={`text-[9px] ${a.unified ? "bg-blue-500/15 text-blue-600" : "bg-amber-500/15 text-amber-600"}`}>
                          {a.unified ? "统一目录" : "原生位置"}
                        </Badge>
                      </div>
                      <div className="mt-1 font-mono text-[9px] text-muted-foreground truncate">
                        {a.path}
                      </div>
                      <div className="text-[9px] text-muted-foreground/70">by {a.skill}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 4. Spec Review — 完整清单 */}
              <div className="rounded-lg border bg-background">
                <button className="w-full px-3 py-2 flex items-center justify-between" onClick={() => setReviewOpen(!reviewOpen)}>
                  <span className="text-xs font-medium">📋 Spec Review（完整性检查）</span>
                  {reviewOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                </button>
                {reviewOpen && (
                  <div className="px-3 pb-3 space-y-1 text-[11px]">
                    {[
                      { k: "goal", v: "✓ 已确认", ok: state.goalConfirmed },
                      { k: "ac", v: `✓ ${ac.length} 条已确认`, ok: state.acConfirmed },
                      { k: "org / projects", v: `${state.preset.org} / ${(state.preset.projects ?? []).join(", ") || "—"}`, ok: !!(state.preset.org && state.preset.projects?.length) },
                      { k: "执行 skills", v: (state.preset.skills ?? []).join(", ") || "—", ok: !!(state.preset.skills?.length) },
                      { k: "方法论", v: `${currentMethod.name}（${currentMethod.skills.length} skills）`, ok: true },
                      { k: "产物", v: `${state.artifacts.length} 项已登记`, ok: state.artifacts.length > 0 },
                      { k: "workflow_ref", v: "⏳ 待 agent 推荐 + 用户确认", ok: false },
                      { k: "integration_goal", v: "— 单任务不适用", ok: true },
                    ].map((row) => (
                      <div key={row.k} className="flex items-center gap-2">
                        <span className={row.ok ? "text-emerald-600" : "text-amber-500"}>{row.ok ? "✅" : "⏳"}</span>
                        <span className="text-muted-foreground w-24 shrink-0">{row.k}</span>
                        <span className="truncate">{row.v}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Button size="sm" className="w-full text-xs" disabled={!canEnqueue}>
                <Zap className="size-3.5 mr-1" /> {canEnqueue ? "入队执行" : "请先确认 goal + ac"}
              </Button>
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* Preset popup */}
      <Dialog open={presetOpen} onOpenChange={setPresetOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="text-base">⚙️ 任务预设</DialogTitle>
            <DialogDescription className="text-xs">
              预设值在会话创建时传给 agent（system prompt），并显示在 Preview。保存预设 ≠ 创建任务。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-xs">
            {state.taskType === "coding" ? (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">组织</Label>
                  <select className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs"
                    value={state.preset.org ?? ""} onChange={(e) => patch({ preset: { ...state.preset, org: e.target.value, projects: [] } })}>
                    <option value="">选择组织...</option>
                    {ORGS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">项目（可多选）</Label>
                  <div className="flex flex-wrap gap-1">
                    {(PROJECTS_BY_ORG[state.preset.org ?? ""] ?? []).map((p) => {
                      const on = state.preset.projects?.includes(p)
                      return (
                        <button key={p} onClick={() => patch({ preset: { ...state.preset, projects: on ? (state.preset.projects ?? []).filter((x) => x !== p) : [...(state.preset.projects ?? []), p] } })}
                          className={`px-2 py-0.5 rounded border text-[11px] ${on ? "bg-blue-500/15 border-blue-400 text-blue-600" : "border-border"}`}>
                          {p}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">执行技能</Label>
                  <div className="flex flex-wrap gap-1">
                    {SKILLS.map((s) => {
                      const on = state.preset.skills?.includes(s)
                      return (
                        <button key={s} onClick={() => patch({ preset: { ...state.preset, skills: on ? (state.preset.skills ?? []).filter((x) => x !== s) : [...(state.preset.skills ?? []), s] } })}
                          className={`px-2 py-0.5 rounded border text-[11px] ${on ? "bg-emerald-500/15 border-emerald-400 text-emerald-600" : "border-border"}`}>
                          {s}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </>
            ) : (
              <div className="text-muted-foreground">通用任务预设：仅任务名 + 描述（对话中由 agent 澄清 goal/ac）</div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Variant J: 模板锁定 + 专家团辅助编写 ────────────────────────────
// 预设瘦身为 org+projects · 方法论创建时锁定（🔒）·
// 编写期可触发辅助工作流（MoA 专家咨询）作为显式卡片

const MOA_EXPERTS = [
  { icon: "🎯", name: "需求专家", focus: "验收标准完整性与可验证性" },
  { icon: "🏗️", name: "架构专家", focus: "通知功能的集成点与影响面" },
  { icon: "🔒", name: "安全专家", focus: "Bot Token 管理与滥用防护" },
]

interface VariantJState {
  phase: "template" | "authoring"
  taskType: TaskType
  methodology: string
  org: string
  projects: string[]
  goalConfirmed: boolean
  acConfirmed: boolean
  moa: "idle" | "running" | "done"
  adopted: boolean
}

function VariantJ() {
  const [state, setState] = useState<VariantJState>({
    phase: "template",
    taskType: "coding",
    methodology: "open-spec",
    org: "open-octopus",
    projects: ["octopus-server"],
    goalConfirmed: false,
    acConfirmed: false,
    moa: "idle",
    adopted: false,
  })
  const [chatInput, setChatInput] = useState("")
  const [presetOpen, setPresetOpen] = useState(false)
  const patch = (p: Partial<VariantJState>) => setState((s) => ({ ...s, ...p }))

  // MoA running → done simulation
  useEffect(() => {
    if (state.moa !== "running") return
    const t = setTimeout(() => patch({ moa: "done" }), 3500)
    return () => clearTimeout(t)
  }, [state.moa])

  const currentMethod = METHODOLOGIES.find((m) => m.id === state.methodology) ?? METHODOLOGIES[0]
  const goal = "给 Octopus 工作流引擎添加 Telegram 实时通知"
  const baseAc = ["关键节点完成后推送通知", "使用 telegraf 库", "通知包含工作流名+节点名+状态"]
  const ac = state.adopted ? [...baseAc, "Bot Token 存环境变量，失败重试 3 次 🧠"] : baseAc
  const canEnqueue = state.goalConfirmed && state.acConfirmed

  // ── Phase 1: Template picker ──
  if (state.phase === "template") {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-lg mx-auto py-10 px-4 space-y-5">
          <div>
            <h2 className="text-lg font-semibold">新建任务</h2>
            <p className="text-xs text-muted-foreground mt-1">类型 + 方法论在创建后锁定。想换方法论 = 新建任务（旧草稿保留）。</p>
          </div>

          {/* Task type */}
          <div>
            <div className="text-xs font-medium mb-2">任务类型</div>
            <div className="grid grid-cols-2 gap-2">
              {([["coding", "🛠 开发任务", "org + 项目语境，spec 驱动"], ["generic", "📄 通用任务", "对话澄清，轻量"]] as const).map(([id, label, desc]) => (
                <button key={id} onClick={() => patch({ taskType: id })}
                  className={`rounded-lg border p-3 text-left ${state.taskType === id ? "border-blue-400 bg-blue-500/5" : "border-border"}`}>
                  <div className="text-sm font-medium">{label}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Methodology (locked after creation) */}
          <div>
            <div className="text-xs font-medium mb-2">方法论 🔒 <span className="text-muted-foreground font-normal">创建后锁定</span></div>
            <div className="space-y-1.5">
              {METHODOLOGIES.map((m) => (
                <button key={m.id} onClick={() => patch({ methodology: m.id })}
                  className={`w-full rounded-lg border px-3 py-2 text-left flex items-center gap-2 ${state.methodology === m.id ? "border-blue-400 bg-blue-500/5" : "border-border"}`}>
                  <span>{m.icon}</span>
                  <div className="flex-1">
                    <div className="text-xs font-medium">{m.name}</div>
                    <div className="text-[10px] text-muted-foreground">{m.desc}</div>
                  </div>
                  <span className="text-[10px] text-muted-foreground">{m.skills.length} 命令</span>
                </button>
              ))}
            </div>
          </div>

          {/* Org + projects (coding only) */}
          {state.taskType === "coding" && (
            <div>
              <div className="text-xs font-medium mb-2">编写语境 <span className="text-muted-foreground font-normal">（预设仅此两项）</span></div>
              <select className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs mb-2"
                value={state.org} onChange={(e) => patch({ org: e.target.value, projects: [] })}>
                {ORGS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <div className="flex flex-wrap gap-1">
                {(PROJECTS_BY_ORG[state.org] ?? []).map((p) => {
                  const on = state.projects.includes(p)
                  return (
                    <button key={p} onClick={() => patch({ projects: on ? state.projects.filter((x) => x !== p) : [...state.projects, p] })}
                      className={`px-2 py-0.5 rounded border text-[11px] ${on ? "bg-blue-500/15 border-blue-400 text-blue-600" : "border-border"}`}>
                      {p}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <Button className="w-full" onClick={() => patch({ phase: "authoring" })}>
            开始编写 →
          </Button>
          <div className="text-[10px] text-muted-foreground text-center">
            创建时：建 draft + 方法论 skills symlink 进任务 plugin 目录（SDK 原生索引）
          </div>
        </div>
      </div>
    )
  }

  // ── Phase 2: Authoring ──
  return (
    <div className="flex flex-col h-full">
      {/* Config bar — methodology locked */}
      <div className="px-4 py-2 border-b bg-muted/30 flex items-center gap-2 flex-wrap">
        <Badge variant="secondary" className="text-[10px]">{state.taskType === "coding" ? "🛠 开发任务" : "📄 通用任务"}</Badge>
        <Badge variant="outline" className="text-[10px]" title="方法论创建后锁定，更换需新建任务">
          🔒 {currentMethod.icon} {currentMethod.name}
        </Badge>
        {state.taskType === "coding" && (
          <>
            <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => setPresetOpen(true)}>
              <Settings2 className="size-3 mr-1" /> {state.org} · {state.projects.length} 项目
            </Button>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">换方法论？新建任务即可，本草稿保留</span>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Left: Chat */}
        <div className="flex-1 flex flex-col min-h-0 border-r">
          <div className="px-3 py-1.5 border-b bg-background flex items-center gap-2 overflow-x-auto">
            <span className="text-[10px] text-muted-foreground shrink-0">{currentMethod.icon}:</span>
            {currentMethod.skills.map((s) => (
              <button key={s} onClick={() => setChatInput(s.startsWith("/") ? `${s} ` : "")}
                className="shrink-0 px-2 py-0.5 rounded text-[10px] bg-muted hover:bg-accent transition-colors">
                {s}
              </button>
            ))}
            <span className="mx-1 text-border">|</span>
            <button onClick={() => state.moa === "idle" && patch({ moa: "running" })}
              className={`shrink-0 px-2 py-0.5 rounded text-[10px] transition-colors ${state.moa === "idle" ? "bg-purple-500/10 text-purple-600 hover:bg-purple-500/20" : "bg-muted text-muted-foreground"}`}>
              🧠 专家咨询 (MoA)
            </button>
          </div>

          <ScrollArea className="flex-1 p-4 space-y-3">
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-lg p-3 text-sm bg-blue-500/10">我想给 octopus 加一个 Telegram 通知功能，关键节点通知，用 telegraf</div>
            </div>
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-lg p-3 text-sm bg-muted whitespace-pre-line">
                🎯 已绑定 goal + ac → 右侧可确认。{"\n\n"}
                需要更深入的需求分析吗？可以启动 <strong>专家咨询（MoA 模式）</strong>：3 位专家并行评审本需求，聚合器汇总后你可以选择性采纳。
              </div>
            </div>

            {/* MoA workflow card */}
            {state.moa !== "idle" && (
              <div className="rounded-lg border border-purple-400/40 bg-purple-500/5 overflow-hidden">
                <div className="px-3 py-2 border-b border-purple-400/20 flex items-center gap-2">
                  <span className="text-sm">🧠</span>
                  <span className="text-xs font-medium flex-1">辅助工作流：moa-requirements-review</span>
                  {state.moa === "running"
                    ? <Badge className="text-[9px] bg-purple-500/15 text-purple-600 animate-pulse">运行中</Badge>
                    : <Badge className="text-[9px] bg-emerald-500/15 text-emerald-600">完成</Badge>}
                </div>
                <div className="p-3 space-y-1.5">
                  {MOA_EXPERTS.map((e) => (
                    <div key={e.name} className="flex items-center gap-2 text-[11px]">
                      <span>{e.icon}</span>
                      <span className="w-16 shrink-0">{e.name}</span>
                      <span className="text-muted-foreground flex-1 truncate">{e.focus}</span>
                      {state.moa === "running"
                        ? <span className="text-purple-500 animate-pulse">●●●</span>
                        : <span className="text-emerald-600">✓</span>}
                    </div>
                  ))}
                  {state.moa === "done" && (
                    <div className="mt-2 rounded-md bg-background border p-2.5 text-[11px] space-y-1.5">
                      <div className="font-medium">聚合结论（采纳为 ac 候选）：</div>
                      <div className="text-muted-foreground">
                        🔒 安全专家：Bot Token 必须存环境变量，不得入库/入仓；发送失败需重试（建议 3 次）防止通知丢失
                      </div>
                      <div className="flex gap-2 pt-1">
                        <Button size="sm" className="h-6 text-[10px]" disabled={state.adopted} onClick={() => patch({ adopted: true, acConfirmed: false })}>
                          {state.adopted ? "✓ 已采纳进 ac" : "采纳进验收标准"}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 text-[10px]">查看全文</Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {state.adopted && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-lg p-3 text-sm bg-muted whitespace-pre-line">
                  ✅ 已采纳：ac 新增「Bot Token 存环境变量，失败重试 3 次」{"\n"}
                  → 右侧 ac 已更新，来源标记 🧠。确认后即可入队。
                </div>
              </div>
            )}
          </ScrollArea>

          <div className="p-3 border-t flex gap-2">
            <Input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="描述需求 或 /command..." className="flex-1" />
            <Button size="sm"><Send className="size-4" /></Button>
          </div>
        </div>

        {/* Right: Preview (same skeleton as I) */}
        <div className="flex-1 flex flex-col min-h-0 bg-muted/20">
          <ScrollArea className="flex-1 p-4">
            <div className="max-w-sm mx-auto space-y-3">
              {/* Goal / AC pinned */}
              <div className="rounded-lg border-2 border-amber-400/40 bg-background overflow-hidden">
                <div className="px-3 py-2 border-b bg-amber-400/10 flex items-center gap-2">
                  <span className="text-xs font-semibold">🎯 目标 & 验收标准</span>
                  <span className="text-[10px] text-muted-foreground">必须显式确认</span>
                </div>
                <div className="p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <button onClick={() => patch({ goalConfirmed: !state.goalConfirmed })}
                      className={`mt-0.5 size-4 rounded-full border flex items-center justify-center shrink-0 ${state.goalConfirmed ? "bg-emerald-500 text-white border-emerald-500" : "border-muted-foreground/40"}`}>
                      {state.goalConfirmed && <Check className="size-3" />}
                    </button>
                    <div>
                      <div className="text-[10px] text-muted-foreground mb-0.5">goal</div>
                      <div className="text-xs">{goal}</div>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <button onClick={() => patch({ acConfirmed: !state.acConfirmed })}
                      className={`mt-0.5 size-4 rounded-full border flex items-center justify-center shrink-0 ${state.acConfirmed ? "bg-emerald-500 text-white border-emerald-500" : "border-muted-foreground/40"}`}>
                      {state.acConfirmed && <Check className="size-3" />}
                    </button>
                    <div>
                      <div className="text-[10px] text-muted-foreground mb-0.5">ac（{ac.length} 条）</div>
                      <ul className="text-xs space-y-0.5">
                        {ac.map((a, i) => <li key={i} className={a.includes("🧠") ? "text-purple-600" : ""}>• {a}</li>)}
                      </ul>
                      {state.adopted && <div className="text-[9px] text-purple-500 mt-1">🧠 = 专家咨询(MoA)产出，已采纳</div>}
                    </div>
                  </div>
                </div>
              </div>

              {/* Methodology locked */}
              <div className="rounded-lg border bg-background p-3">
                <div className="flex items-center gap-2">
                  <span>{currentMethod.icon}</span>
                  <div className="text-xs font-medium flex-1">{currentMethod.name} <span className="text-[10px] text-muted-foreground font-normal">🔒 创建时锁定</span></div>
                </div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {currentMethod.skills.map((s) => (
                    <Badge key={s} variant="outline" className="text-[10px]">{s}</Badge>
                  ))}
                </div>
              </div>

              {/* Authoring-assist workflows */}
              <div className="rounded-lg border bg-background p-3">
                <div className="text-xs font-medium mb-1.5">🧠 辅助工作流</div>
                <div className="text-[11px] space-y-1">
                  <div className="flex items-center gap-2">
                    <span className={state.moa === "idle" ? "text-muted-foreground/40" : state.moa === "running" ? "text-purple-500" : "text-emerald-600"}>
                      {state.moa === "idle" ? "○" : state.moa === "running" ? "◐" : "●"}
                    </span>
                    <span>moa-requirements-review（专家咨询）</span>
                  </div>
                  <div className="text-muted-foreground/50 pl-4">○ spec-review-swarm（规格评审）</div>
                  <div className="text-muted-foreground/50 pl-4">○ clarify-debate（需求辩论澄清）</div>
                </div>
              </div>

              {/* Spec review summary */}
              <div className="rounded-lg border bg-background px-3 py-2 text-[11px] space-y-1">
                <div className="flex items-center gap-2"><span className={state.goalConfirmed ? "text-emerald-600" : "text-amber-500"}>{state.goalConfirmed ? "✅" : "⏳"}</span> goal {state.goalConfirmed ? "已确认" : "待确认"}</div>
                <div className="flex items-center gap-2"><span className={state.acConfirmed ? "text-emerald-600" : "text-amber-500"}>{state.acConfirmed ? "✅" : "⏳"}</span> ac {ac.length} 条 {state.acConfirmed ? "已确认" : "待确认"}</div>
                <div className="flex items-center gap-2"><span className="text-emerald-600">✅</span> 语境 {state.org} / {state.projects.join(", ")}</div>
                <div className="flex items-center gap-2"><span className="text-emerald-600">✅</span> 方法论 {currentMethod.name} 🔒</div>
                <div className="flex items-center gap-2"><span className="text-amber-500">⏳</span> workflow_ref 待 agent 推荐</div>
              </div>

              <Button size="sm" className="w-full text-xs" disabled={!canEnqueue}>
                <Zap className="size-3.5 mr-1" /> {canEnqueue ? "入队执行" : "请先确认 goal + ac"}
              </Button>
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* Simplified preset popup — org + projects only */}
      <Dialog open={presetOpen} onOpenChange={setPresetOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-base">⚙️ 编写语境</DialogTitle>
            <DialogDescription className="text-xs">
              预设只有组织 + 项目两项。执行技能由 workflow.requires 负责，不在这里预设。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-xs">
            <select className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs"
              value={state.org} onChange={(e) => patch({ org: e.target.value, projects: [] })}>
              {ORGS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <div className="flex flex-wrap gap-1">
              {(PROJECTS_BY_ORG[state.org] ?? []).map((p) => {
                const on = state.projects.includes(p)
                return (
                  <button key={p} onClick={() => patch({ projects: on ? state.projects.filter((x) => x !== p) : [...state.projects, p] })}
                    className={`px-2 py-0.5 rounded border text-[11px] ${on ? "bg-blue-500/15 border-blue-400 text-blue-600" : "border-border"}`}>
                    {p}
                  </button>
                )
              })}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Variant K: Skill组多选 + 浮现/直编 + 产物批阅 + MoA结构化采纳 ────

interface KAcItem { text: string; source: "agent" | "moa" | "user" }
interface KArtifact {
  id: string; skill: string; title: string; icon: string; path: string
  unified: boolean; status: "pending" | "approved" | "revise"; excerpt: string
}

function VariantK() {
  const [state, setState] = useState({
    phase: "template" as "template" | "authoring",
    taskType: "coding" as TaskType,
    groups: ["open-spec"],
    org: "open-octopus",
    projects: ["octopus-server"],
    // spec field appearance / confirm / edit
    goalBound: false, goalConfirmed: false, goalEditing: false,
    goalText: "给 Octopus 工作流引擎添加 Telegram 实时通知",
    goalEditedByUser: false,
    acBound: false, acConfirmed: false,
    acItems: [] as KAcItem[],
    // artifacts
    artifacts: [
      { id: "a1", skill: "task-author", title: "task_spec.json — 结构化规格", icon: "🧾", path: "~/.octopus/tasks/t-8f3a/artifacts/task_spec.json", unified: true, status: "approved", excerpt: '{\n  "goal": "给 Octopus 工作流引擎添加 Telegram 实时通知",\n  "ac": ["关键节点完成后推送通知", ...]\n}' },
      { id: "a2", skill: "open-spec", title: "proposal.md — Telegram 通知变更提案", icon: "📄", path: "octopus-server/openspec/changes/telegram-notify/proposal.md", unified: false, status: "pending", excerpt: "# Telegram 通知\n\n## Why\n工作流执行结果缺乏即时反馈，长任务需要人工盯守。\n\n## What Changes\n- 关键节点完成后推送 Telegram 消息\n- 全局开关 + 每工作流覆盖\n\n## Impact\n- engine: 事件总线新增 notify hook" },
    ] as KArtifact[],
    expandedArtifact: "" as string,
    // assist workflows
    suggestDismissed: false,
    moa: "idle" as "idle" | "running" | "done",
    moaAcChecked: [true, true, false],
    moaSugChecked: [true, false],
    adopted: false,
    adoptedSuggestions: [] as string[],
  })
  const [chatInput, setChatInput] = useState("")
  const [draftGoal, setDraftGoal] = useState("")
  const [presetOpen, setPresetOpen] = useState(false)
  const patch = (p: Partial<typeof state>) => setState((s) => ({ ...s, ...p }))

  // Agent binding simulation: goal 0.8s, ac 2.2s after entering authoring
  useEffect(() => {
    if (state.phase !== "authoring") return
    const t1 = setTimeout(() => patch({ goalBound: true }), 800)
    const t2 = setTimeout(() => patch({
      acBound: true,
      acItems: [
        { text: "关键节点完成后推送通知", source: "agent" },
        { text: "使用 telegraf 库", source: "agent" },
        { text: "通知包含工作流名+节点名+状态", source: "agent" },
      ],
    }), 2200)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [state.phase])

  // MoA running → done
  useEffect(() => {
    if (state.moa !== "running") return
    const t = setTimeout(() => patch({ moa: "done" }), 3000)
    return () => clearTimeout(t)
  }, [state.moa])

  const groups = METHODOLOGIES.filter((m) => state.groups.includes(m.id))
  const allCommands = groups.flatMap((g) => g.skills)
  const canEnqueue = state.goalConfirmed && state.acConfirmed

  const toggleGroup = (id: string) => {
    const on = state.groups.includes(id)
    const next = on ? state.groups.filter((g) => g !== id) : [...state.groups, id]
    if (next.length > 0) patch({ groups: next })
  }

  const adoptMoa = () => {
    const acCandidates = [
      { text: "Bot Token 存环境变量，不入仓库/数据库", by: "🔒 安全专家" },
      { text: "发送失败重试 3 次，仍失败则记录告警", by: "🏗️ 架构专家" },
      { text: "通知文案限长 4096 字符（Telegram 上限）", by: "🎯 需求专家" },
    ]
    const suggestions = [
      "方案A：异步事件 + 独立通知服务（可扩展多渠道，代价是多一个服务）",
      "方案B：engine 内嵌 telegraf 直发（简单，但耦合且阻塞节点流）",
    ]
    const newAc = acCandidates
      .filter((_, i) => state.moaAcChecked[i])
      .map((c) => ({ text: c.text, source: "moa" as const }))
    const newSug = suggestions.filter((_, i) => state.moSugChecked[i])
    patch({ adopted: true, acItems: [...state.acItems, ...newAc], acConfirmed: false, adoptedSuggestions: newSug })
  }

  // ── Phase 1: Template ──
  if (state.phase === "template") {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-lg mx-auto py-10 px-4 space-y-5">
          <div>
            <h2 className="text-lg font-semibold">新建任务</h2>
            <p className="text-xs text-muted-foreground mt-1">类型 + Skill 组在创建后锁定。想换组合 = 新建任务（旧草稿保留）。</p>
          </div>

          <div>
            <div className="text-xs font-medium mb-2">任务类型</div>
            <div className="grid grid-cols-2 gap-2">
              {([["coding", "🛠 开发任务", "org + 项目语境，spec 驱动"], ["generic", "📄 通用任务", "对话澄清，轻量"]] as const).map(([id, label, desc]) => (
                <button key={id} onClick={() => patch({ taskType: id })}
                  className={`rounded-lg border p-3 text-left ${state.taskType === id ? "border-blue-400 bg-blue-500/5" : "border-border"}`}>
                  <div className="text-sm font-medium">{label}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Skill groups — multi-select */}
          <div>
            <div className="text-xs font-medium mb-2">
              Skill 组 🔒 <span className="text-muted-foreground font-normal">可多选 · 创建后锁定 · 多选的命令全部可用</span>
            </div>
            <div className="space-y-1.5">
              {METHODOLOGIES.map((m) => {
                const on = state.groups.includes(m.id)
                return (
                  <button key={m.id} onClick={() => toggleGroup(m.id)}
                    className={`w-full rounded-lg border px-3 py-2 text-left flex items-center gap-2 ${on ? "border-blue-400 bg-blue-500/5" : "border-border"}`}>
                    <span className={`size-4 rounded border flex items-center justify-center shrink-0 ${on ? "bg-blue-500 border-blue-500 text-white" : "border-muted-foreground/40"}`}>
                      {on && <Check className="size-3" />}
                    </span>
                    <span>{m.icon}</span>
                    <div className="flex-1">
                      <div className="text-xs font-medium">{m.name}</div>
                      <div className="text-[10px] text-muted-foreground">{m.desc}</div>
                    </div>
                    <span className="text-[10px] text-muted-foreground">{m.skills.length} 命令</span>
                  </button>
                )
              })}
            </div>
            {state.groups.length > 1 && (
              <div className="mt-2 text-[10px] text-amber-600 bg-amber-500/10 rounded px-2 py-1.5">
                ⚠ 整合模式：{state.groups.length} 个组的命令都可用。各组产物约定不同时，按「登记不搬迁」各自索引。
              </div>
            )}
          </div>

          {state.taskType === "coding" && (
            <div>
              <div className="text-xs font-medium mb-2">编写语境 <span className="text-muted-foreground font-normal">（预设仅此两项）</span></div>
              <select className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs mb-2"
                value={state.org} onChange={(e) => patch({ org: e.target.value, projects: [] })}>
                {ORGS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <div className="flex flex-wrap gap-1">
                {(PROJECTS_BY_ORG[state.org] ?? []).map((p) => {
                  const on = state.projects.includes(p)
                  return (
                    <button key={p} onClick={() => patch({ projects: on ? state.projects.filter((x) => x !== p) : [...state.projects, p] })}
                      className={`px-2 py-0.5 rounded border text-[11px] ${on ? "bg-blue-500/15 border-blue-400 text-blue-600" : "border-border"}`}>
                      {p}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <Button className="w-full" disabled={state.groups.length === 0} onClick={() => patch({ phase: "authoring" })}>
            开始编写 →
          </Button>
          <div className="text-[10px] text-muted-foreground text-center">
            创建时：建 draft + 所选 Skill 组 symlink 进任务 plugin 目录（SDK 原生索引）
          </div>
        </div>
      </div>
    )
  }

  // ── Phase 2: Authoring ──
  return (
    <div className="flex flex-col h-full">
      {/* Config bar */}
      <div className="px-4 py-2 border-b bg-muted/30 flex items-center gap-2 flex-wrap">
        <Badge variant="secondary" className="text-[10px]">{state.taskType === "coding" ? "🛠 开发任务" : "📄 通用任务"}</Badge>
        {groups.map((g) => (
          <Badge key={g.id} variant="outline" className="text-[10px]" title="Skill 组创建后锁定">🔒 {g.icon} {g.name}</Badge>
        ))}
        {state.taskType === "coding" && (
          <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => setPresetOpen(true)}>
            <Settings2 className="size-3 mr-1" /> {state.org} · {state.projects.length} 项目
          </Button>
        )}
        <div className="ml-auto text-[10px] text-muted-foreground">换 Skill 组？新建任务即可，本草稿保留</div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Left: Chat */}
        <div className="flex-1 flex flex-col min-h-0 border-r">
          <div className="px-3 py-1.5 border-b bg-background flex items-center gap-2 overflow-x-auto">
            {allCommands.map((s) => (
              <button key={s} onClick={() => setChatInput(s.startsWith("/") ? `${s} ` : "")}
                className="shrink-0 px-2 py-0.5 rounded text-[10px] bg-muted hover:bg-accent transition-colors">
                {s}
              </button>
            ))}
            <span className="mx-1 text-border">|</span>
            <button onClick={() => state.moa === "idle" && patch({ moa: "running", suggestDismissed: true })}
              className={`shrink-0 px-2 py-0.5 rounded text-[10px] ${state.moa === "idle" ? "bg-purple-500/10 text-purple-600 hover:bg-purple-500/20" : "bg-muted text-muted-foreground"}`}>
              🧠 专家咨询 (MoA)
            </button>
          </div>

          <ScrollArea className="flex-1 p-4 space-y-3">
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-lg p-3 text-sm bg-blue-500/10">我想给 octopus 加一个 Telegram 通知功能，关键节点通知，用 telegraf</div>
            </div>
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-lg p-3 text-sm bg-muted whitespace-pre-line">
                🎯 已绑定 <code>goal</code> 和 <code>ac</code>（3 条）→ 右侧已浮现，等你确认。{"\n"}
                你也可以直接在右侧编辑字段，我会收到通知。
              </div>
            </div>

            {/* user direct-edit system notice */}
            {state.goalEditedByUser && (
              <div className="flex justify-center">
                <div className="rounded-md bg-amber-500/10 border border-amber-400/30 px-3 py-1.5 text-[10px] text-amber-600">
                  ✏️ 你直接修改了 goal — server 已通过 @@spec_updated 通知 agent（下轮生效）
                </div>
              </div>
            )}

            {/* Agent suggestion bubble */}
            {state.moa === "idle" && !state.suggestDismissed && state.acBound && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-lg p-3 text-sm bg-purple-500/5 border border-purple-400/30">
                  💡 这个需求涉及 Bot Token 安全和跨模块集成，建议跑一次 <strong>专家咨询（MoA）</strong>，3 位专家并行评审。
                  <div className="flex gap-2 mt-2">
                    <Button size="sm" className="h-6 text-[10px]" onClick={() => patch({ moa: "running", suggestDismissed: true })}>🧠 运行</Button>
                    <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => patch({ suggestDismissed: true })}>跳过</Button>
                  </div>
                </div>
              </div>
            )}

            {/* MoA card */}
            {state.moa !== "idle" && (
              <div className="rounded-lg border border-purple-400/40 bg-purple-500/5 overflow-hidden">
                <div className="px-3 py-2 border-b border-purple-400/20 flex items-center gap-2">
                  <span className="text-sm">🧠</span>
                  <span className="text-xs font-medium flex-1">moa-requirements-review（内置模板）</span>
                  {state.moa === "running"
                    ? <Badge className="text-[9px] bg-purple-500/15 text-purple-600 animate-pulse">运行中</Badge>
                    : <Badge className="text-[9px] bg-emerald-500/15 text-emerald-600">完成</Badge>}
                </div>
                <div className="p-3 space-y-2">
                  {MOA_EXPERTS.map((e) => (
                    <div key={e.name} className="flex items-center gap-2 text-[11px]">
                      <span>{e.icon}</span>
                      <span className="w-16 shrink-0">{e.name}</span>
                      <span className="text-muted-foreground flex-1 truncate">{e.focus}</span>
                      {state.moa === "running" ? <span className="text-purple-500 animate-pulse">●●●</span> : <span className="text-emerald-600">✓</span>}
                    </div>
                  ))}

                  {/* Structured output — checkable adoption */}
                  {state.moa === "done" && !state.adopted && (
                    <div className="mt-2 rounded-md bg-background border p-2.5 text-[11px] space-y-2.5">
                      <div>
                        <div className="font-medium mb-1">✅ ac 候选（勾选采纳进验收标准）</div>
                        {[
                          { text: "Bot Token 存环境变量，不入仓库/数据库", by: "🔒 安全专家" },
                          { text: "发送失败重试 3 次，仍失败则记录告警", by: "🏗️ 架构专家" },
                          { text: "通知文案限长 4096 字符（Telegram 上限）", by: "🎯 需求专家" },
                        ].map((c, i) => (
                          <label key={i} className="flex items-start gap-2 py-0.5 cursor-pointer">
                            <input type="checkbox" className="mt-0.5" checked={state.moaAcChecked[i]}
                              onChange={() => patch({ moaAcChecked: state.moaAcChecked.map((v, j) => j === i ? !v : v) })} />
                            <span className="flex-1">{c.text}</span>
                            <span className="text-[9px] text-muted-foreground shrink-0">{c.by}</span>
                          </label>
                        ))}
                      </div>
                      <div>
                        <div className="font-medium mb-1">💡 方案建议（勾选采纳 → 决策备忘，帮你做选择）</div>
                        {[
                          { title: "方案A：异步事件 + 独立通知服务", desc: "engine 只发事件，通知服务消费。可扩展 Discord/Slack，代价是多一个服务" },
                          { title: "方案B：engine 内嵌 telegraf 直发", desc: "节点完成后同步发送。简单快，但耦合、发送阻塞节点流" },
                        ].map((s, i) => (
                          <label key={i} className="flex items-start gap-2 py-0.5 cursor-pointer">
                            <input type="checkbox" className="mt-0.5" checked={state.moSugChecked[i]}
                              onChange={() => patch({ moaSugChecked: state.moSugChecked.map((v, j) => j === i ? !v : v) })} />
                            <span className="flex-1"><strong>{s.title}</strong> — <span className="text-muted-foreground">{s.desc}</span></span>
                          </label>
                        ))}
                      </div>
                      <div>
                        <div className="font-medium mb-1">⚠️ 风险提示（仅告知）</div>
                        <ul className="text-muted-foreground space-y-0.5 list-disc pl-4">
                          <li>Bot 入群多时可能触发 Telegram 限流（30 msg/s）</li>
                          <li>Token 注入路径需要审计，避免出现在工作流日志</li>
                        </ul>
                      </div>
                      <Button size="sm" className="h-6 text-[10px] w-full" onClick={adoptMoa}>采纳勾选项</Button>
                    </div>
                  )}

                  {state.adopted && (
                    <div className="mt-2 rounded-md bg-background border p-2.5 text-[11px] text-emerald-600">
                      ✅ 已采纳：{state.acItems.filter((a) => a.source === "moa").length} 条 ac 候选 + {state.adoptedSuggestions.length} 条方案建议（见右侧）
                    </div>
                  )}
                </div>
              </div>
            )}
          </ScrollArea>

          <div className="p-3 border-t flex gap-2">
            <Input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="描述需求 或 /command..." className="flex-1" />
            <Button size="sm"><Send className="size-4" /></Button>
          </div>
        </div>

        {/* Right: Preview — full width layout */}
        <div className="flex-1 flex flex-col min-h-0 bg-muted/20">
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-3">

              {/* Goal / AC — appears when agent binds; inline editable */}
              <div className="rounded-lg border-2 border-amber-400/40 bg-background overflow-hidden">
                <div className="px-3 py-2 border-b bg-amber-400/10 flex items-center gap-2">
                  <span className="text-xs font-semibold">🎯 目标 & 验收标准</span>
                  <span className="text-[10px] text-muted-foreground">agent 绑定时浮现 · 可直接编辑（agent 会收到通知）</span>
                </div>
                <div className="p-3 space-y-3">
                  {/* goal */}
                  {!state.goalBound ? (
                    <div className="text-[11px] text-muted-foreground/50 border border-dashed rounded-md px-3 py-2">⏳ goal — 待 agent 在对话中绑定后浮现…</div>
                  ) : (
                    <div className="flex items-start gap-2">
                      <button onClick={() => patch({ goalConfirmed: !state.goalConfirmed })}
                        className={`mt-0.5 size-4 rounded-full border flex items-center justify-center shrink-0 ${state.goalConfirmed ? "bg-emerald-500 text-white border-emerald-500" : "border-muted-foreground/40"}`}>
                        {state.goalConfirmed && <Check className="size-3" />}
                      </button>
                      <div className="flex-1">
                        <div className="text-[10px] text-muted-foreground mb-0.5 flex items-center gap-2">
                          goal
                          {state.goalEditedByUser && <Badge variant="outline" className="text-[9px] text-amber-600">✏️ 用户已编辑</Badge>}
                          {!state.goalEditing && (
                            <button className="text-muted-foreground hover:text-foreground" title="直接编辑"
                              onClick={() => { setDraftGoal(state.goalText); patch({ goalEditing: true }) }}>
                              <FileText className="size-3" />
                            </button>
                          )}
                        </div>
                        {state.goalEditing ? (
                          <div className="space-y-1.5">
                            <Textarea value={draftGoal} onChange={(e) => setDraftGoal(e.target.value)} className="text-xs min-h-[52px]" />
                            <div className="flex gap-1.5">
                              <Button size="sm" className="h-6 text-[10px]" onClick={() => patch({ goalText: draftGoal, goalEditing: false, goalEditedByUser: true, goalConfirmed: false })}>保存</Button>
                              <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => patch({ goalEditing: false })}>取消</Button>
                            </div>
                          </div>
                        ) : (
                          <div className="text-xs">{state.goalText}</div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ac */}
                  {!state.acBound ? (
                    <div className="text-[11px] text-muted-foreground/50 border border-dashed rounded-md px-3 py-2">⏳ ac — 待 agent 在对话中绑定后浮现…</div>
                  ) : (
                    <div className="flex items-start gap-2">
                      <button onClick={() => patch({ acConfirmed: !state.acConfirmed })}
                        className={`mt-0.5 size-4 rounded-full border flex items-center justify-center shrink-0 ${state.acConfirmed ? "bg-emerald-500 text-white border-emerald-500" : "border-muted-foreground/40"}`}>
                        {state.acConfirmed && <Check className="size-3" />}
                      </button>
                      <div className="flex-1">
                        <div className="text-[10px] text-muted-foreground mb-0.5">ac（{state.acItems.length} 条）· 点 × 可删除</div>
                        <ul className="text-xs space-y-1">
                          {state.acItems.map((a, i) => (
                            <li key={i} className="flex items-start gap-1.5">
                              <span className={a.source === "moa" ? "text-purple-600 flex-1" : "flex-1"}>• {a.text}</span>
                              {a.source === "moa" && <span className="text-[9px] text-purple-500 shrink-0">🧠</span>}
                              <button className="text-muted-foreground/40 hover:text-red-500 shrink-0" title="删除"
                                onClick={() => patch({ acItems: state.acItems.filter((_, j) => j !== i), acConfirmed: false })}>
                                <X className="size-3" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Two-column bottom */}
              <div className="grid grid-cols-2 gap-3">
                {/* Left col: artifacts with review */}
                <div className="space-y-3">
                  <div className="rounded-lg border bg-background">
                    <div className="px-3 py-2 border-b flex items-center justify-between">
                      <span className="text-xs font-medium">📁 产物 ({state.artifacts.length})</span>
                      <span className="text-[10px] text-muted-foreground">查看 → 批阅</span>
                    </div>
                    <div className="divide-y">
                      {state.artifacts.map((a) => (
                        <div key={a.id} className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="text-sm">{a.icon}</span>
                            <button className="text-xs flex-1 truncate text-left hover:underline" onClick={() => patch({ expandedArtifact: state.expandedArtifact === a.id ? "" : a.id })}>
                              {a.title}
                            </button>
                            <Badge className={`text-[9px] ${a.status === "approved" ? "bg-emerald-500/15 text-emerald-600" : a.status === "revise" ? "bg-red-500/15 text-red-500" : "bg-amber-500/15 text-amber-600"}`}>
                              {a.status === "approved" ? "✅ 已批阅" : a.status === "revise" ? "✏️ 要求修改" : "⏳ 待批阅"}
                            </Badge>
                          </div>
                          <div className="mt-1 font-mono text-[9px] text-muted-foreground truncate">{a.path}</div>
                          {state.expandedArtifact === a.id && (
                            <div className="mt-2 space-y-2">
                              <pre className="text-[10px] bg-muted rounded p-2 whitespace-pre-wrap max-h-32 overflow-y-auto font-sans">{a.excerpt}</pre>
                              <div className="flex gap-1.5">
                                <Button size="sm" className="h-6 text-[10px]" onClick={() => patch({ artifacts: state.artifacts.map((x) => x.id === a.id ? { ...x, status: "approved" as const } : x) })}>✅ 批阅通过</Button>
                                <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => patch({ artifacts: state.artifacts.map((x) => x.id === a.id ? { ...x, status: "revise" as const } : x) })}>✏️ 要求修改</Button>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Adopted suggestions */}
                  {state.adoptedSuggestions.length > 0 && (
                    <div className="rounded-lg border border-purple-400/30 bg-background p-3">
                      <div className="text-xs font-medium mb-1.5">💡 已采纳方案建议（决策备忘）</div>
                      <ul className="text-[11px] space-y-1 text-muted-foreground">
                        {state.adoptedSuggestions.map((s, i) => <li key={i}>• {s}</li>)}
                      </ul>
                      <div className="text-[9px] text-purple-500 mt-1.5">🧠 来源：moa-requirements-review · 供你做方案决策，非强制</div>
                    </div>
                  )}
                </div>

                {/* Right col: groups + assist + checklist */}
                <div className="space-y-3">
                  <div className="rounded-lg border bg-background p-3">
                    <div className="text-xs font-medium mb-1.5">📦 Skill 组 🔒</div>
                    {groups.map((g) => (
                      <div key={g.id} className="flex flex-wrap gap-1 mb-1">
                        <span className="text-[10px] text-muted-foreground w-full">{g.icon} {g.name}</span>
                        {g.skills.map((s) => <Badge key={s} variant="outline" className="text-[9px]">{s}</Badge>)}
                      </div>
                    ))}
                  </div>

                  <div className="rounded-lg border bg-background p-3">
                    <div className="text-xs font-medium mb-1.5">🧠 辅助工作流 <span className="text-[9px] text-muted-foreground font-normal">内置模板 · agent 建议，用户执行</span></div>
                    <div className="text-[11px] space-y-1">
                      <div className="flex items-center gap-2">
                        <span className={state.moa === "idle" ? "text-muted-foreground/40" : state.moa === "running" ? "text-purple-500" : "text-emerald-600"}>
                          {state.moa === "idle" ? "○" : state.moa === "running" ? "◐" : "●"}
                        </span>
                        <span>moa-requirements-review</span>
                      </div>
                      <div className="text-muted-foreground/50 pl-4">○ spec-review-swarm</div>
                      <div className="text-muted-foreground/50 pl-4">○ clarify-debate</div>
                    </div>
                  </div>

                  <div className="rounded-lg border bg-background px-3 py-2 text-[11px] space-y-1">
                    <div className="text-xs font-medium mb-1">📋 Spec Review</div>
                    <div className="flex items-center gap-2"><span className={state.goalConfirmed ? "text-emerald-600" : "text-amber-500"}>{state.goalConfirmed ? "✅" : "⏳"}</span> goal {state.goalConfirmed ? "已确认" : state.goalBound ? "待确认" : "未绑定"}</div>
                    <div className="flex items-center gap-2"><span className={state.acConfirmed ? "text-emerald-600" : "text-amber-500"}>{state.acConfirmed ? "✅" : "⏳"}</span> ac {state.acBound ? `${state.acItems.length} 条` : "未绑定"}</div>
                    <div className="flex items-center gap-2"><span className="text-emerald-600">✅</span> 语境 {state.org} / {state.projects.join(", ")}</div>
                    <div className="flex items-center gap-2"><span className="text-emerald-600">✅</span> Skill 组 ×{groups.length}</div>
                    <div className="flex items-center gap-2"><span className={state.artifacts.every((a) => a.status === "approved") ? "text-emerald-600" : "text-amber-500"}>{state.artifacts.every((a) => a.status === "approved") ? "✅" : "⏳"}</span> 产物批阅 {state.artifacts.filter((a) => a.status === "approved").length}/{state.artifacts.length}</div>
                    <div className="flex items-center gap-2"><span className="text-amber-500">⏳</span> workflow_ref 待 agent 推荐</div>
                  </div>
                </div>
              </div>

              <Button size="sm" className="w-full text-xs" disabled={!canEnqueue}>
                <Zap className="size-3.5 mr-1" /> {canEnqueue ? "入队执行" : "请先确认 goal + ac"}
              </Button>
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* Preset popup — org + projects only */}
      <Dialog open={presetOpen} onOpenChange={setPresetOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-base">⚙️ 编写语境</DialogTitle>
            <DialogDescription className="text-xs">预设只有组织 + 项目两项。执行技能由 workflow.requires 负责。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-xs">
            <select className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs"
              value={state.org} onChange={(e) => patch({ org: e.target.value, projects: [] })}>
              {ORGS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <div className="flex flex-wrap gap-1">
              {(PROJECTS_BY_ORG[state.org] ?? []).map((p) => {
                const on = state.projects.includes(p)
                return (
                  <button key={p} onClick={() => patch({ projects: on ? state.projects.filter((x) => x !== p) : [...state.projects, p] })}
                    className={`px-2 py-0.5 rounded border text-[11px] ${on ? "bg-blue-500/15 border-blue-400 text-blue-600" : "border-border"}`}>
                    {p}
                  </button>
                )
              })}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Variant L: 右侧 = 产出查看器 ───────────────────────────────────
// 原则：产物看完整内容，工作流看过程日志。无审批操作（有问题 → 对话让 agent 改）。
// Skill 组与产出无关 → 从右侧移除（chat 上方已有命令栏）。

const L_ARTIFACTS = [
  {
    id: "a1", skill: "open-spec", title: "proposal.md — Telegram 通知变更提案", icon: "📄",
    path: "octopus-server/openspec/changes/telegram-notify/proposal.md",
    size: "3.2 KB", updated: "2 分钟前",
    content: `# Telegram 通知变更提案

## Why

工作流执行结果缺乏即时反馈。长任务（>10min）需要人工盯守，
失败发现滞后，平均响应时间 > 30min。

## What Changes

- engine 事件总线新增 notify hook（关键节点触发）
- 新增 NotificationService（telegraf 实现 Telegram 渠道）
- 全局开关 + 每工作流覆盖配置（workflow.yaml notify: 字段）
- 消息模板：工作流名 / 节点名 / 状态 / 耗时

## Impact

- Affected specs: engine-event-bus, workflow-config
- Affected code:
  - packages/engine/src/event-bus.ts（hook 点）
  - packages/server/src/services/notification/（新目录）
  - packages/shared/src/types/workflow.ts（notify 字段）

## Decisions

- D1: telegraf 而非自建 HTTP（社区成熟，long-polling 免公网 IP）
- D2: v1 仅 Telegram，渠道接口预留多渠道扩展
- D3: 发送失败重试 3 次后降级为日志记录，不阻塞工作流

## Open Questions

- Q1: 限流策略（Bot 30 msg/s）是否需要队列削峰？
- Q2: 通知订阅粒度是否需要到「节点级」？`,
  },
  {
    id: "a2", skill: "task-author", title: "task_spec.json — 结构化规格", icon: "🧾",
    path: "~/.octopus/tasks/t-8f3a/artifacts/task_spec.json",
    size: "0.9 KB", updated: "1 分钟前",
    content: `{
  "goal": "给 Octopus 工作流引擎添加 Telegram 实时通知",
  "ac": [
    "关键节点完成后推送通知",
    "使用 telegraf 库",
    "通知包含工作流名+节点名+状态",
    "Bot Token 存环境变量，不入仓库/数据库",
    "发送失败重试 3 次，仍失败则记录告警"
  ],
  "projects": ["octopus-server"],
  "authoring_resources": [
    { "type": "skill", "name": "open-spec" }
  ]
}`,
  },
]

const L_MOA_LOG = [
  { t: "00:00", icon: "▶️", text: "workflow start · moa-requirements-review · mode=moa" },
  { t: "00:01", icon: "🎯", text: "需求专家启动 · input: task_spec.goal + ac[3]" },
  { t: "00:01", icon: "🏗️", text: "架构专家启动 · input: repos/index.md + engine 结构" },
  { t: "00:01", icon: "🔒", text: "安全专家启动 · input: goal + telegraf 集成点" },
  { t: "00:07", icon: "🎯", text: "需求专家完成 → 输出 1.2 KB（ac 可验证性分析）" },
  { t: "00:09", icon: "🏗️", text: "架构专家完成 → 输出 2.1 KB（方案A/B 对比）" },
  { t: "00:11", icon: "🔒", text: "安全专家完成 → 输出 0.8 KB（Token 管理风险）" },
  { t: "00:12", icon: "🧩", text: "聚合器开始汇总 3 份专家输出…" },
  { t: "00:15", icon: "✅", text: "聚合完成 → 结构化产出：3 ac候选 / 2 方案建议 / 2 风险" },
  { t: "00:15", icon: "📤", text: "产出回传 task-author session · workflow done (15.2s)" },
]

function VariantL() {
  const [state, setState] = useState({
    phase: "template" as "template" | "authoring",
    taskType: "coding" as TaskType,
    groups: ["open-spec"],
    org: "open-octopus",
    projects: ["octopus-server"],
    goalBound: false, goalConfirmed: false, goalEditing: false,
    goalText: "给 Octopus 工作流引擎添加 Telegram 实时通知",
    goalEditedByUser: false,
    acBound: false, acConfirmed: false,
    acItems: [] as KAcItem[],
    viewerArtifact: "",
    logOpen: false,
    suggestDismissed: false,
    moa: "idle" as "idle" | "running" | "done",
    moaAcChecked: [true, true, false],
    moaSugChecked: [true, false],
    adopted: false,
    adoptedSuggestions: [] as string[],
  })
  const [chatInput, setChatInput] = useState("")
  const [draftGoal, setDraftGoal] = useState("")
  const [presetOpen, setPresetOpen] = useState(false)
  const patch = (p: Partial<typeof state>) => setState((s) => ({ ...s, ...p }))

  useEffect(() => {
    if (state.phase !== "authoring") return
    const t1 = setTimeout(() => patch({ goalBound: true }), 800)
    const t2 = setTimeout(() => patch({
      acBound: true,
      acItems: [
        { text: "关键节点完成后推送通知", source: "agent" },
        { text: "使用 telegraf 库", source: "agent" },
        { text: "通知包含工作流名+节点名+状态", source: "agent" },
      ],
    }), 2200)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [state.phase])

  useEffect(() => {
    if (state.moa !== "running") return
    const t = setTimeout(() => patch({ moa: "done" }), 3000)
    return () => clearTimeout(t)
  }, [state.moa])

  const groups = METHODOLOGIES.filter((m) => state.groups.includes(m.id))
  const allCommands = groups.flatMap((g) => g.skills)
  const canEnqueue = state.goalConfirmed && state.acConfirmed
  const viewedArtifact = L_ARTIFACTS.find((a) => a.id === state.viewerArtifact)

  const toggleGroup = (id: string) => {
    const on = state.groups.includes(id)
    const next = on ? state.groups.filter((g) => g !== id) : [...state.groups, id]
    if (next.length > 0) patch({ groups: next })
  }

  const adoptMoa = () => {
    const acCandidates = [
      { text: "Bot Token 存环境变量，不入仓库/数据库" },
      { text: "发送失败重试 3 次，仍失败则记录告警" },
      { text: "通知文案限长 4096 字符（Telegram 上限）" },
    ]
    const suggestions = [
      "方案A：异步事件 + 独立通知服务（可扩展多渠道，代价是多一个服务）",
      "方案B：engine 内嵌 telegraf 直发（简单，但耦合且阻塞节点流）",
    ]
    const newAc = acCandidates.filter((_, i) => state.moaAcChecked[i]).map((c) => ({ text: c.text, source: "moa" as const }))
    patch({
      adopted: true,
      acItems: [...state.acItems, ...newAc],
      acConfirmed: false,
      adoptedSuggestions: suggestions.filter((_, i) => state.moSugChecked[i]),
    })
  }

  // ── Phase 1: Template (same as K) ──
  if (state.phase === "template") {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-lg mx-auto py-10 px-4 space-y-5">
          <div>
            <h2 className="text-lg font-semibold">新建任务</h2>
            <p className="text-xs text-muted-foreground mt-1">类型 + Skill 组在创建后锁定。想换组合 = 新建任务（旧草稿保留）。</p>
          </div>
          <div>
            <div className="text-xs font-medium mb-2">任务类型</div>
            <div className="grid grid-cols-2 gap-2">
              {([["coding", "🛠 开发任务", "org + 项目语境，spec 驱动"], ["generic", "📄 通用任务", "对话澄清，轻量"]] as const).map(([id, label, desc]) => (
                <button key={id} onClick={() => patch({ taskType: id })}
                  className={`rounded-lg border p-3 text-left ${state.taskType === id ? "border-blue-400 bg-blue-500/5" : "border-border"}`}>
                  <div className="text-sm font-medium">{label}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{desc}</div>
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs font-medium mb-2">Skill 组 🔒 <span className="text-muted-foreground font-normal">可多选 · 创建后锁定</span></div>
            <div className="space-y-1.5">
              {METHODOLOGIES.map((m) => {
                const on = state.groups.includes(m.id)
                return (
                  <button key={m.id} onClick={() => toggleGroup(m.id)}
                    className={`w-full rounded-lg border px-3 py-2 text-left flex items-center gap-2 ${on ? "border-blue-400 bg-blue-500/5" : "border-border"}`}>
                    <span className={`size-4 rounded border flex items-center justify-center shrink-0 ${on ? "bg-blue-500 border-blue-500 text-white" : "border-muted-foreground/40"}`}>
                      {on && <Check className="size-3" />}
                    </span>
                    <span>{m.icon}</span>
                    <div className="flex-1">
                      <div className="text-xs font-medium">{m.name}</div>
                      <div className="text-[10px] text-muted-foreground">{m.desc}</div>
                    </div>
                    <span className="text-[10px] text-muted-foreground">{m.skills.length} 命令</span>
                  </button>
                )
              })}
            </div>
            {state.groups.length > 1 && (
              <div className="mt-2 text-[10px] text-amber-600 bg-amber-500/10 rounded px-2 py-1.5">
                ⚠ 整合模式：{state.groups.length} 个组的命令都可用，产物按「登记不搬迁」各自索引。
              </div>
            )}
          </div>
          {state.taskType === "coding" && (
            <div>
              <div className="text-xs font-medium mb-2">编写语境 <span className="text-muted-foreground font-normal">（预设仅此两项）</span></div>
              <select className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs mb-2"
                value={state.org} onChange={(e) => patch({ org: e.target.value, projects: [] })}>
                {ORGS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <div className="flex flex-wrap gap-1">
                {(PROJECTS_BY_ORG[state.org] ?? []).map((p) => {
                  const on = state.projects.includes(p)
                  return (
                    <button key={p} onClick={() => patch({ projects: on ? state.projects.filter((x) => x !== p) : [...state.projects, p] })}
                      className={`px-2 py-0.5 rounded border text-[11px] ${on ? "bg-blue-500/15 border-blue-400 text-blue-600" : "border-border"}`}>
                      {p}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <Button className="w-full" onClick={() => patch({ phase: "authoring" })}>开始编写 →</Button>
        </div>
      </div>
    )
  }

  // ── Phase 2: Authoring ──
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b bg-muted/30 flex items-center gap-2 flex-wrap">
        <Badge variant="secondary" className="text-[10px]">{state.taskType === "coding" ? "🛠 开发任务" : "📄 通用任务"}</Badge>
        {groups.map((g) => <Badge key={g.id} variant="outline" className="text-[10px]">🔒 {g.icon} {g.name}</Badge>)}
        {state.taskType === "coding" && (
          <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => setPresetOpen(true)}>
            <Settings2 className="size-3 mr-1" /> {state.org} · {state.projects.length} 项目
          </Button>
        )}
        <div className="ml-auto text-[10px] text-muted-foreground">右侧 = 产出查看器 · 有问题直接在对话里让 agent 改</div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Left: Chat */}
        <div className="flex-1 flex flex-col min-h-0 border-r">
          <div className="px-3 py-1.5 border-b bg-background flex items-center gap-2 overflow-x-auto">
            {allCommands.map((s) => (
              <button key={s} onClick={() => setChatInput(s.startsWith("/") ? `${s} ` : "")}
                className="shrink-0 px-2 py-0.5 rounded text-[10px] bg-muted hover:bg-accent transition-colors">{s}</button>
            ))}
            <span className="mx-1 text-border">|</span>
            <button onClick={() => state.moa === "idle" && patch({ moa: "running", suggestDismissed: true })}
              className={`shrink-0 px-2 py-0.5 rounded text-[10px] ${state.moa === "idle" ? "bg-purple-500/10 text-purple-600 hover:bg-purple-500/20" : "bg-muted text-muted-foreground"}`}>
              🧠 专家咨询 (MoA)
            </button>
          </div>

          <ScrollArea className="flex-1 p-4 space-y-3">
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-lg p-3 text-sm bg-blue-500/10">我想给 octopus 加一个 Telegram 通知功能，关键节点通知，用 telegraf</div>
            </div>
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-lg p-3 text-sm bg-muted whitespace-pre-line">
                🎯 已绑定 <code>goal</code> + <code>ac</code>（右侧已浮现）{"\n"}
                📄 已生成 <code>proposal.md</code>（右侧可看完整内容）{"\n\n"}
                对产物有意见？直接说，我来改。
              </div>
            </div>

            {state.goalEditedByUser && (
              <div className="flex justify-center">
                <div className="rounded-md bg-amber-500/10 border border-amber-400/30 px-3 py-1.5 text-[10px] text-amber-600">
                  ✏️ 你直接修改了 goal — server 已通过 @@spec_updated 通知 agent（下轮生效）
                </div>
              </div>
            )}

            {state.moa === "idle" && !state.suggestDismissed && state.acBound && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-lg p-3 text-sm bg-purple-500/5 border border-purple-400/30">
                  💡 这个需求涉及 Bot Token 安全和跨模块集成，建议跑一次 <strong>专家咨询（MoA）</strong>。
                  <div className="flex gap-2 mt-2">
                    <Button size="sm" className="h-6 text-[10px]" onClick={() => patch({ moa: "running", suggestDismissed: true })}>🧠 运行</Button>
                    <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => patch({ suggestDismissed: true })}>跳过</Button>
                  </div>
                </div>
              </div>
            )}

            {state.moa !== "idle" && (
              <div className="rounded-lg border border-purple-400/40 bg-purple-500/5 overflow-hidden">
                <div className="px-3 py-2 border-b border-purple-400/20 flex items-center gap-2">
                  <span className="text-sm">🧠</span>
                  <span className="text-xs font-medium flex-1">moa-requirements-review</span>
                  {state.moa === "running"
                    ? <Badge className="text-[9px] bg-purple-500/15 text-purple-600 animate-pulse">运行中</Badge>
                    : <Badge className="text-[9px] bg-emerald-500/15 text-emerald-600">完成</Badge>}
                </div>
                <div className="p-3 space-y-2">
                  {MOA_EXPERTS.map((e) => (
                    <div key={e.name} className="flex items-center gap-2 text-[11px]">
                      <span>{e.icon}</span>
                      <span className="w-16 shrink-0">{e.name}</span>
                      <span className="text-muted-foreground flex-1 truncate">{e.focus}</span>
                      {state.moa === "running" ? <span className="text-purple-500 animate-pulse">●●●</span> : <span className="text-emerald-600">✓</span>}
                    </div>
                  ))}
                  {state.moa === "done" && !state.adopted && (
                    <div className="mt-2 rounded-md bg-background border p-2.5 text-[11px] space-y-2.5">
                      <div>
                        <div className="font-medium mb-1">✅ ac 候选（勾选采纳）</div>
                        {["Bot Token 存环境变量，不入仓库/数据库", "发送失败重试 3 次，仍失败则记录告警", "通知文案限长 4096 字符（Telegram 上限）"].map((c, i) => (
                          <label key={i} className="flex items-start gap-2 py-0.5 cursor-pointer">
                            <input type="checkbox" className="mt-0.5" checked={state.moaAcChecked[i]}
                              onChange={() => patch({ moaAcChecked: state.moaAcChecked.map((v, j) => j === i ? !v : v) })} />
                            <span>{c}</span>
                          </label>
                        ))}
                      </div>
                      <div>
                        <div className="font-medium mb-1">💡 方案建议（勾选 → 决策备忘）</div>
                        {[
                          { title: "方案A：异步事件 + 独立通知服务", desc: "可扩展多渠道，代价多一个服务" },
                          { title: "方案B：engine 内嵌 telegraf 直发", desc: "简单，但耦合、阻塞节点流" },
                        ].map((s, i) => (
                          <label key={i} className="flex items-start gap-2 py-0.5 cursor-pointer">
                            <input type="checkbox" className="mt-0.5" checked={state.moSugChecked[i]}
                              onChange={() => patch({ moaSugChecked: state.moSugChecked.map((v, j) => j === i ? !v : v) })} />
                            <span><strong>{s.title}</strong> — <span className="text-muted-foreground">{s.desc}</span></span>
                          </label>
                        ))}
                      </div>
                      <div>
                        <div className="font-medium mb-1">⚠️ 风险（仅告知）</div>
                        <ul className="text-muted-foreground space-y-0.5 list-disc pl-4">
                          <li>Bot 入群多时可能触发限流（30 msg/s）</li>
                          <li>Token 注入路径需审计，避免出现在日志</li>
                        </ul>
                      </div>
                      <Button size="sm" className="h-6 text-[10px] w-full" onClick={adoptMoa}>采纳勾选项</Button>
                    </div>
                  )}
                  {state.adopted && (
                    <div className="mt-2 rounded-md bg-background border p-2.5 text-[11px] text-emerald-600">
                      ✅ 已采纳 {state.acItems.filter((a) => a.source === "moa").length} 条 ac + {state.adoptedSuggestions.length} 条方案建议
                    </div>
                  )}
                </div>
              </div>
            )}
          </ScrollArea>

          <div className="p-3 border-t flex gap-2">
            <Input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="对产物有意见？直接说… 或 /command" className="flex-1" />
            <Button size="sm"><Send className="size-4" /></Button>
          </div>
        </div>

        {/* Right: Output viewer */}
        <div className="flex-1 flex flex-col min-h-0 bg-muted/20">
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-3">

              {/* goal / ac */}
              <div className="rounded-lg border-2 border-amber-400/40 bg-background overflow-hidden">
                <div className="px-3 py-2 border-b bg-amber-400/10 flex items-center gap-2">
                  <span className="text-xs font-semibold">🎯 目标 & 验收标准</span>
                  <span className="text-[10px] text-muted-foreground">agent 绑定时浮现 · 可直编</span>
                </div>
                <div className="p-3 space-y-3">
                  {!state.goalBound ? (
                    <div className="text-[11px] text-muted-foreground/50 border border-dashed rounded-md px-3 py-2">⏳ goal — 待 agent 绑定后浮现…</div>
                  ) : (
                    <div className="flex items-start gap-2">
                      <button onClick={() => patch({ goalConfirmed: !state.goalConfirmed })}
                        className={`mt-0.5 size-4 rounded-full border flex items-center justify-center shrink-0 ${state.goalConfirmed ? "bg-emerald-500 text-white border-emerald-500" : "border-muted-foreground/40"}`}>
                        {state.goalConfirmed && <Check className="size-3" />}
                      </button>
                      <div className="flex-1">
                        <div className="text-[10px] text-muted-foreground mb-0.5 flex items-center gap-2">
                          goal
                          {state.goalEditedByUser && <Badge variant="outline" className="text-[9px] text-amber-600">✏️ 已编辑</Badge>}
                          {!state.goalEditing && (
                            <button className="text-muted-foreground hover:text-foreground" title="直接编辑"
                              onClick={() => { setDraftGoal(state.goalText); patch({ goalEditing: true }) }}>
                              <FileText className="size-3" />
                            </button>
                          )}
                        </div>
                        {state.goalEditing ? (
                          <div className="space-y-1.5">
                            <Textarea value={draftGoal} onChange={(e) => setDraftGoal(e.target.value)} className="text-xs min-h-[52px]" />
                            <div className="flex gap-1.5">
                              <Button size="sm" className="h-6 text-[10px]" onClick={() => patch({ goalText: draftGoal, goalEditing: false, goalEditedByUser: true, goalConfirmed: false })}>保存</Button>
                              <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => patch({ goalEditing: false })}>取消</Button>
                            </div>
                          </div>
                        ) : <div className="text-xs">{state.goalText}</div>}
                      </div>
                    </div>
                  )}
                  {!state.acBound ? (
                    <div className="text-[11px] text-muted-foreground/50 border border-dashed rounded-md px-3 py-2">⏳ ac — 待 agent 绑定后浮现…</div>
                  ) : (
                    <div className="flex items-start gap-2">
                      <button onClick={() => patch({ acConfirmed: !state.acConfirmed })}
                        className={`mt-0.5 size-4 rounded-full border flex items-center justify-center shrink-0 ${state.acConfirmed ? "bg-emerald-500 text-white border-emerald-500" : "border-muted-foreground/40"}`}>
                        {state.acConfirmed && <Check className="size-3" />}
                      </button>
                      <div className="flex-1">
                        <div className="text-[10px] text-muted-foreground mb-0.5">ac（{state.acItems.length} 条）</div>
                        <ul className="text-xs space-y-1">
                          {state.acItems.map((a, i) => (
                            <li key={i} className="flex items-start gap-1.5">
                              <span className={a.source === "moa" ? "text-purple-600 flex-1" : "flex-1"}>• {a.text}</span>
                              {a.source === "moa" && <span className="text-[9px] text-purple-500 shrink-0">🧠</span>}
                              <button className="text-muted-foreground/40 hover:text-red-500 shrink-0"
                                onClick={() => patch({ acItems: state.acItems.filter((_, j) => j !== i), acConfirmed: false })}>
                                <X className="size-3" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Artifacts — view full content */}
              <div className="rounded-lg border bg-background">
                <div className="px-3 py-2 border-b flex items-center justify-between">
                  <span className="text-xs font-medium">📁 产物 ({L_ARTIFACTS.length})</span>
                  <span className="text-[10px] text-muted-foreground">点击查看完整内容</span>
                </div>
                <div className="divide-y">
                  {L_ARTIFACTS.map((a) => (
                    <button key={a.id} className="w-full px-3 py-2.5 flex items-center gap-2.5 hover:bg-muted/50 text-left"
                      onClick={() => patch({ viewerArtifact: a.id })}>
                      <span className="text-base">{a.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs truncate">{a.title}</div>
                        <div className="text-[9px] text-muted-foreground font-mono truncate">{a.path}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-[9px] text-muted-foreground">{a.size} · {a.updated}</div>
                        <div className="text-[9px] text-muted-foreground">by {a.skill}</div>
                      </div>
                      <Eye className="size-3.5 text-muted-foreground shrink-0" />
                    </button>
                  ))}
                </div>
              </div>

              {/* Workflow runs — view process logs */}
              {state.moa !== "idle" && (
                <div className="rounded-lg border bg-background">
                  <div className="px-3 py-2 border-b flex items-center justify-between">
                    <span className="text-xs font-medium">🧠 工作流运行记录</span>
                    <span className="text-[10px] text-muted-foreground">点击查看过程日志</span>
                  </div>
                  <button className="w-full px-3 py-2.5 flex items-center gap-2.5 hover:bg-muted/50 text-left" onClick={() => patch({ logOpen: true })}>
                    <span className="text-base">🧠</span>
                    <div className="flex-1">
                      <div className="text-xs">moa-requirements-review</div>
                      <div className="text-[9px] text-muted-foreground">3 专家 + 聚合器 · 15.2s</div>
                    </div>
                    {state.moa === "running"
                      ? <Badge className="text-[9px] bg-purple-500/15 text-purple-600 animate-pulse">运行中</Badge>
                      : <Badge className="text-[9px] bg-emerald-500/15 text-emerald-600">完成</Badge>}
                    <Eye className="size-3.5 text-muted-foreground" />
                  </button>
                </div>
              )}

              {/* Adopted suggestions (decision memo) */}
              {state.adoptedSuggestions.length > 0 && (
                <div className="rounded-lg border border-purple-400/30 bg-background p-3">
                  <div className="text-xs font-medium mb-1.5">💡 决策备忘 <span className="text-[9px] text-muted-foreground font-normal">来自 MoA · 供方案决策</span></div>
                  <ul className="text-[11px] space-y-1 text-muted-foreground">
                    {state.adoptedSuggestions.map((s, i) => <li key={i}>• {s}</li>)}
                  </ul>
                </div>
              )}

              {/* Compact pre-enqueue checklist */}
              <div className="rounded-lg border bg-background px-3 py-2.5">
                <div className="flex items-center flex-wrap gap-x-4 gap-y-1 text-[11px] mb-2">
                  <span className="flex items-center gap-1"><span className={state.goalConfirmed ? "text-emerald-600" : "text-amber-500"}>{state.goalConfirmed ? "✅" : "⏳"}</span> goal</span>
                  <span className="flex items-center gap-1"><span className={state.acConfirmed ? "text-emerald-600" : "text-amber-500"}>{state.acConfirmed ? "✅" : "⏳"}</span> ac ×{state.acItems.length}</span>
                  <span className="flex items-center gap-1"><span className="text-emerald-600">✅</span> {state.org}/{state.projects.join(",")}</span>
                  <span className="flex items-center gap-1"><span className="text-emerald-600">✅</span> 产物 ×{L_ARTIFACTS.length}</span>
                  <span className="flex items-center gap-1"><span className="text-amber-500">⏳</span> workflow_ref</span>
                </div>
                <Button size="sm" className="w-full text-xs" disabled={!canEnqueue}>
                  <Zap className="size-3.5 mr-1" /> {canEnqueue ? "入队执行" : "请先确认 goal + ac"}
                </Button>
              </div>
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* Artifact full-content viewer */}
      <Dialog open={!!viewedArtifact} onOpenChange={(o) => !o && patch({ viewerArtifact: "" })}>
        <DialogContent className="sm:max-w-[720px] max-h-[85vh] p-0 gap-0 flex flex-col">
          <DialogHeader className="px-4 py-3 border-b shrink-0">
            <DialogTitle className="text-sm flex items-center gap-2">{viewedArtifact?.icon} {viewedArtifact?.title}</DialogTitle>
            <DialogDescription className="font-mono text-[10px]">{viewedArtifact?.path} · by {viewedArtifact?.skill}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="flex-1 min-h-0">
            <pre className="p-4 text-[11px] leading-relaxed whitespace-pre-wrap font-mono">{viewedArtifact?.content}</pre>
          </ScrollArea>
          <div className="px-4 py-2 border-t text-[10px] text-muted-foreground shrink-0">
            有意见？关闭后在左侧对话里直接说，agent 会修改并更新此产物
          </div>
        </DialogContent>
      </Dialog>

      {/* Workflow process log viewer */}
      <Dialog open={state.logOpen} onOpenChange={(o) => patch({ logOpen: o })}>
        <DialogContent className="sm:max-w-[640px] max-h-[85vh] p-0 gap-0 flex flex-col">
          <DialogHeader className="px-4 py-3 border-b shrink-0">
            <DialogTitle className="text-sm">🧠 moa-requirements-review · 过程日志</DialogTitle>
            <DialogDescription className="text-[10px]">workflow run #1 · 15.2s · exit 0</DialogDescription>
          </DialogHeader>
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-4 space-y-1 font-mono text-[11px]">
              {L_MOA_LOG.map((l, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-muted-foreground/60 shrink-0">[{l.t}]</span>
                  <span className="shrink-0">{l.icon}</span>
                  <span>{l.text}</span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Preset popup */}
      <Dialog open={presetOpen} onOpenChange={setPresetOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-base">⚙️ 编写语境</DialogTitle>
            <DialogDescription className="text-xs">预设只有组织 + 项目两项。执行技能由 workflow.requires 负责。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-xs">
            <select className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs"
              value={state.org} onChange={(e) => patch({ org: e.target.value, projects: [] })}>
              {ORGS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <div className="flex flex-wrap gap-1">
              {(PROJECTS_BY_ORG[state.org] ?? []).map((p) => {
                const on = state.projects.includes(p)
                return (
                  <button key={p} onClick={() => patch({ projects: on ? state.projects.filter((x) => x !== p) : [...state.projects, p] })}
                    className={`px-2 py-0.5 rounded border text-[11px] ${on ? "bg-blue-500/15 border-blue-400 text-blue-600" : "border-border"}`}>
                    {p}
                  </button>
                )
              })}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Switcher Bar ───────────────────────────────────────────────────

const VARIANTS = [
  { key: "L", name: "⭐⭐⭐⭐⭐⭐ 产出查看器" },
  { key: "K", name: "⭐⭐⭐⭐⭐ Skill组多选+批阅" },
  { key: "J", name: "⭐⭐⭐⭐ 模板锁定 + 专家团" },
  { key: "I", name: "⭐⭐⭐ 修订版综合 (v3)" },
  { key: "F", name: "⭐ 综合模型" },
  { key: "G", name: "🏗️ 架构分析" },
  { key: "H", name: "⭐⭐ 综合 + 架构透视" },
  { key: "A", name: "Chat 主导" },
  { key: "B", name: "Spec 卡片" },
  { key: "D", name: "🔒 结构化全流程" },
  { key: "E", name: "🔓 技能驱动" },
]

function PrototypeSwitcher({ current }: { current: string }) {
  const router = useRouter()
  const idx = VARIANTS.findIndex((v) => v.key === current)

  const go = useCallback((dir: -1 | 1) => {
    const next = (idx + dir + VARIANTS.length) % VARIANTS.length
    router.replace(`?variant=${VARIANTS[next].key}`)
  }, [idx, router])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === "INPUT" || tag === "TEXTAREA") return
      if (e.key === "ArrowLeft") go(-1)
      if (e.key === "ArrowRight") go(1)
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [go])

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[999] flex items-center gap-3 bg-zinc-900 text-white rounded-full px-5 py-2 shadow-2xl text-sm">
      <button onClick={() => go(-1)} className="hover:text-zinc-300">←</button>
      <span className="min-w-[200px] text-center">
        <span className="font-bold">{current}</span>
        <span className="text-zinc-400 ml-2">{VARIANTS[idx]?.name}</span>
      </span>
      <button onClick={() => go(1)} className="hover:text-zinc-300">→</button>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────

export default function TaskPrototypePage() {
  const searchParams = useSearchParams()
  const variant = searchParams.get("variant") ?? "L"

  return (
    <div className="h-screen flex flex-col bg-background">
      <div className="flex-1 min-h-0">
        {variant === "A" && <VariantA />}
        {variant === "B" && <VariantB />}
        {variant === "C" && <VariantC />}
        {variant === "D" && <VariantD />}
        {variant === "E" && <VariantE />}
        {variant === "F" && <VariantF />}
        {variant === "G" && <VariantG />}
        {variant === "H" && <VariantH />}
        {variant === "I" && <VariantI />}
        {variant === "J" && <VariantJ />}
        {variant === "K" && <VariantK />}
        {variant === "L" && <VariantL />}
      </div>
      <PrototypeSwitcher current={variant} />
    </div>
  )
}
