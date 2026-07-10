"use client"

import { useState, useEffect, useRef } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2, TrendingUp, DollarSign, AlertCircle, Lightbulb, Package, FileText, ChevronDown, ChevronUp } from "lucide-react"
import { previewArchive, getArchiveDraft, deleteArchiveDraft, getResourceGroups, previewArchiveSSE } from "@/lib/archive-api"
import type { StepEvent, ResourceGroups } from "@/lib/archive-api"
import { ArchiveProgress } from "./archive-progress"
import { toast } from "sonner"
import type { Workspace } from "@/lib/types"
import type { ArchivePreview, ArchiveDraft, ExperienceCandidate, SkillCandidate, SkillInstallOption } from "@/lib/archive-api"

function formatDraftAge(updatedAt: string): string {
  const diff = Date.now() - new Date(updatedAt).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
}

const CREATE_NEW = "__create_new__"

function GroupSelector({
  value,
  groups,
  onChange,
  onCreateGroup,
}: {
  value: string
  groups: string[]
  onChange: (group: string) => void
  onCreateGroup: (name: string) => void
}) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creating) inputRef.current?.focus()
  }, [creating])

  const handleConfirm = () => {
    const trimmed = newName.trim()
    if (trimmed && !groups.includes(trimmed)) {
      onCreateGroup(trimmed)
      onChange(trimmed)
    }
    setCreating(false)
    setNewName("")
  }

  if (creating) {
    return (
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          className="h-7 w-[140px] rounded-md border border-input bg-background px-2 text-xs"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleConfirm()
            if (e.key === "Escape") { setCreating(false); setNewName("") }
          }}
          placeholder="输入组名..."
        />
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleConfirm}>
          <span className="text-green-500 text-sm">✓</span>
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setCreating(false); setNewName("") }}>
          <span className="text-muted-foreground text-sm">✕</span>
        </Button>
      </div>
    )
  }

  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v === CREATE_NEW) { setCreating(true); return }
        onChange(v)
      }}
    >
      <SelectTrigger className="h-7 w-[180px] text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {groups.map((g) => (
          <SelectItem key={g} value={g}>{g}</SelectItem>
        ))}
        <SelectItem value={CREATE_NEW} className="text-blue-600 font-medium">
          + 新建组...
        </SelectItem>
      </SelectContent>
    </Select>
  )
}

interface ArchivePreviewDialogProps {
  workspace: Workspace | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onArchived: () => void
}

const PREVIEW_STEP_DEFS = [
  { key: "build_context", label: "构建分析上下文" },
  { key: "discover_skills", label: "扫描 Skill 目录" },
  { key: "discover_workflows", label: "扫描 Workflow 目录" },
  { key: "discover_agents", label: "扫描 Agent 目录" },
  { key: "analyze_parallel", label: "LLM 并行分析" },
  { key: "assemble", label: "合并分析结果" },
  { key: "save_draft", label: "保存分析草稿" },
]

export function ArchivePreviewDialog({
  workspace,
  open,
  onOpenChange,
  onArchived,
}: ArchivePreviewDialogProps) {
  const [preview, setPreview] = useState<ArchivePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [started, setStarted] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [selectedExperiences, setSelectedExperiences] = useState<string[]>([])
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [selectedWorkflows, setSelectedWorkflows] = useState<string[]>([])
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState("analysis")
  const [draft, setDraft] = useState<ArchiveDraft | null>(null)
  const [draftAge, setDraftAge] = useState<string | null>(null)
  const [skillGroups, setSkillGroups] = useState<Record<string, string>>({})
  const [workflowGroups, setWorkflowGroups] = useState<Record<string, string>>({})
  const [agentGroups, setAgentGroups] = useState<Record<string, string>>({})
  const [resourceGroups, setResourceGroups] = useState<ResourceGroups>({ skillGroups: ["archive-extracted"], workflowGroups: ["archive-extracted"], agentGroups: ["archive-extracted"] })
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set())
  const previewDriverRef = useRef<{
    onStep: ((e: StepEvent) => void) | null
    onLog: ((m: string) => void) | null
    onComplete: ((r: any) => void) | null
    onError: ((e: Error) => void) | null
    abort: (() => void) | null
  }>({ onStep: null, onLog: null, onComplete: null, onError: null, abort: null })

  useEffect(() => {
    if (open && workspace) {
      checkDraft()
    }
  }, [open, workspace])

  useEffect(() => {
    if (open && workspace) {
      getResourceGroups().then(setResourceGroups)
    }
  }, [open, workspace])

  useEffect(() => {
    if (preview?.skills) {
      const defaults: Record<string, string> = {}
      for (const skill of preview.skills) {
        defaults[skill.name] = skillGroups[skill.name] ?? (skill as any).existingGroup ?? "archive-extracted"
      }
      setSkillGroups(defaults)
    }
  }, [preview?.skills])

  useEffect(() => {
    const wfs = (preview as any)?.workflows ?? []
    if (wfs.length > 0) {
      const defaults: Record<string, string> = {}
      for (const wf of wfs) {
        defaults[wf.name] = workflowGroups[wf.name] ?? wf.existingGroup ?? "archive-extracted"
      }
      setWorkflowGroups(defaults)
    }
  }, [(preview as any)?.workflows])

  useEffect(() => {
    const agents = (preview as any)?.agents ?? []
    if (agents.length > 0) {
      const defaults: Record<string, string> = {}
      for (const agent of agents) {
        defaults[agent.name] = agentGroups[agent.name] ?? agent.existingGroup ?? "archive-extracted"
      }
      setAgentGroups(defaults)
    }
  }, [(preview as any)?.agents])

  const checkDraft = async () => {
    if (!workspace) return
    try {
      const existingDraft = await getArchiveDraft(workspace.id)
      if (existingDraft) {
        setDraft(existingDraft)
        setPreview({
          stats: existingDraft.stats,
          analysis: existingDraft.analysis_report,
          experiences: existingDraft.experiences,
          skills: existingDraft.skills,
          workflows: (existingDraft as any).workflows ?? [],
          tokenStats: (existingDraft as any).tokenStats ?? {},
          agents: (existingDraft as any).agents ?? [],
        } as any)
        setDraftAge(formatDraftAge(existingDraft.updated_at))
      }
    } catch {
      // No draft — user will click to start
    }
  }

  const handleStartAnalysis = () => {
    setStarted(true)
    setLoading(true)
  }

  const loadPreview = () => {
    if (!workspace) return
    setStarted(true)
    setPreview(null)
    setLoading(true)
  }

  const handleRegenerate = async () => {
    if (!workspace) return
    await deleteArchiveDraft(workspace.id)
    setDraft(null)
    setDraftAge(null)
    setPreview(null)
    loadPreview()
  }

  const handleArchive = () => {
    if (!workspace) return
    setArchiving(true)
  }

  const toggleExperience = (id: string) => {
    setSelectedExperiences((prev) =>
      prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id]
    )
  }

  const toggleSkill = (name: string) => {
    setSelectedSkills((prev) =>
      prev.includes(name) ? prev.filter((s) => s !== name) : [...prev, name]
    )
  }

  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    if (hours > 0) return `${hours}h ${minutes % 60}m`
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`
    return `${seconds}s`
  }

  const formatCost = (cost: number) => {
    return `$${cost.toFixed(2)}`
  }

  if (!workspace) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[80vh] w-full sm:max-w-[960px] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>归档工作空间预览</DialogTitle>
          <DialogDescription>
            查看 &ldquo;{workspace.name}&rdquo; 的归档分析结果，选择要提取的经验和 Skill
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <ArchiveProgress
            stepDefs={PREVIEW_STEP_DEFS}
            externalDriver={{
              onStep: (h) => { previewDriverRef.current.onStep = h },
              onLog: (h) => { previewDriverRef.current.onLog = h },
              onComplete: (h) => { previewDriverRef.current.onComplete = h },
              onError: (h) => { previewDriverRef.current.onError = h },
              onReady: () => {
                if (!workspace) return
                const abort = previewArchiveSSE(
                  workspace.id,
                  (step) => previewDriverRef.current.onStep?.(step),
                  (msg) => previewDriverRef.current.onLog?.(msg),
                  (result) => {
                    setPreview(result)
                    setDraft(null)
                    setDraftAge(null)
                    setLoading(false)
                  },
                  (err) => {
                    toast.error(err.message || "加载预览失败")
                    setLoading(false)
                  },
                  (workspace as any).org,
                )
                previewDriverRef.current.abort = () => abort.abort()
              },
              abort: () => previewDriverRef.current.abort?.(),
            }}
            onComplete={() => {}}
            onCancel={() => { setLoading(false); onOpenChange(false) }}
          />
        ) : archiving && preview ? (
          <ArchiveProgress
            workspaceId={workspace.id}
            options={{
              extractExperiences: selectedExperiences,
              installSkills: selectedSkills.map((name) => {
                const skill = preview.skills.find((s) => s.name === name)
                return {
                  name,
                  group: skillGroups[name] ?? "archive-extracted",
                  path: skill?.path,
                  content: skill?.content,
                }
              }),
              installWorkflows: selectedWorkflows.map((name) => {
                const wf = ((preview as any).workflows ?? []).find((w: any) => w.name === name)
                return {
                  name,
                  group: workflowGroups[name] ?? "archive-extracted",
                  path: wf?.path,
                  content: wf?.content,
                }
              }),
              installAgents: selectedAgents.map((name) => {
                const agent = ((preview as any).agents ?? []).find((a: any) => a.name === name)
                return {
                  name,
                  group: agentGroups[name] ?? "archive-extracted",
                  path: agent?.path,
                  content: agent?.content,
                }
              }),
              analysisReport: preview.analysis,
              stats: preview.stats,
              metadata: {
                experiences: preview.experiences.filter(e => selectedExperiences.includes(e.id)),
                skills: preview.skills.filter(s => selectedSkills.includes(s.name)),
                allExperiences: preview.experiences,
                allSkills: preview.skills,
                tokenStats: (preview as any).tokenStats,
                workflows: ((preview as any).workflows ?? []).filter((w: any) => selectedWorkflows.includes(w.name)),
                allWorkflows: (preview as any).workflows ?? [],
                agents: ((preview as any).agents ?? []).filter((a: any) => selectedAgents.includes(a.name)),
                allAgents: (preview as any).agents ?? [],
              },
            }}
            onComplete={() => {
              toast.success(`"${workspace.name}" 已归档`)
              onArchived()
            }}
            onCancel={() => {
              setArchiving(false)
              onOpenChange(false)
            }}
          />
        ) : preview ? (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="space-y-6">
            {draft && draftAge && (
              <div className="flex items-center justify-between rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-sm">
                <span className="text-amber-800 dark:text-amber-200">
                  已加载上次分析结果（{draftAge}）
                </span>
                <Button variant="outline" size="sm" onClick={handleRegenerate}>
                  重新分析
                </Button>
              </div>
            )}

            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <TrendingUp className="h-4 w-4" />
                    执行次数
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{preview.stats.execution_count}</div>
                  <div className="text-xs text-muted-foreground">
                    成功率: {(preview.stats.success_rate > 1 ? preview.stats.success_rate : preview.stats.success_rate * 100).toFixed(1)}%
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <DollarSign className="h-4 w-4" />
                    总成本
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{formatCost(preview.stats.total_cost)}</div>
                  <div className="text-xs text-muted-foreground">
                    平均: {formatCost(preview.stats.avg_cost_per_execution)}/次
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">总耗时</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {formatDuration(preview.stats.total_duration_ms)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    平均: {formatDuration(preview.stats.avg_duration_ms)}/次
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">可提取</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {preview.experiences.length + preview.skills.length + ((preview as any).workflows ?? []).length + ((preview as any).agents ?? []).length}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {preview.experiences.length} 经验, {preview.skills.length} Skill, {((preview as any).workflows ?? []).length} 工作流, {((preview as any).agents ?? []).length} Agent
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="grid w-full grid-cols-6">
                <TabsTrigger value="analysis">分析报告</TabsTrigger>
                <TabsTrigger value="tokens">Token 统计</TabsTrigger>
                <TabsTrigger value="experiences">
                  经验 ({preview.experiences.length})
                </TabsTrigger>
                <TabsTrigger value="skills">Skill ({preview.skills.length})</TabsTrigger>
                <TabsTrigger value="workflows">工作流 ({((preview as any).workflows ?? []).length})</TabsTrigger>
                <TabsTrigger value="agents">Agent ({((preview as any).agents ?? []).length})</TabsTrigger>
              </TabsList>

              <TabsContent value="analysis" className="space-y-4">
                {preview.analysis.summary && (
                  <div>
                    <h4 className="font-semibold mb-2">总结</h4>
                    <p className="text-sm text-muted-foreground">{preview.analysis.summary}</p>
                  </div>
                )}

                {preview.analysis.execution_patterns.length > 0 && (
                  <div>
                    <h4 className="font-semibold mb-2 flex items-center gap-2">
                      <TrendingUp className="h-4 w-4" />
                      执行模式
                    </h4>
                    <ul className="list-disc ml-4 space-y-1">
                      {preview.analysis.execution_patterns.map((pattern, idx) => (
                        <li key={idx} className="text-sm text-muted-foreground">
                          {pattern}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {preview.analysis.cost_efficiency && (
                  <div>
                    <h4 className="font-semibold mb-2 flex items-center gap-2">
                      <DollarSign className="h-4 w-4" />
                      成本效率
                    </h4>
                    <div className="space-y-1">
                      <p className="text-sm">
                        <Badge variant="outline" className="mr-2">{preview.analysis.cost_efficiency.rating}</Badge>
                        {preview.analysis.cost_efficiency.analysis}
                      </p>
                      {preview.analysis.cost_efficiency.optimization_ideas.length > 0 && (
                        <ul className="list-disc ml-4 mt-1 space-y-1">
                          {preview.analysis.cost_efficiency.optimization_ideas.map((idea, idx) => (
                            <li key={idx} className="text-sm text-muted-foreground">{idea}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}

                {preview.analysis.error_patterns.length > 0 && (
                  <div>
                    <h4 className="font-semibold mb-2 flex items-center gap-2">
                      <AlertCircle className="h-4 w-4" />
                      错误模式
                    </h4>
                    <ul className="list-disc ml-4 space-y-1">
                      {preview.analysis.error_patterns.map((pattern, idx) => (
                        <li key={idx} className="text-sm text-muted-foreground">
                          {pattern}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {preview.analysis.recommendations.length > 0 && (
                  <div>
                    <h4 className="font-semibold mb-2 flex items-center gap-2">
                      <Lightbulb className="h-4 w-4" />
                      建议
                    </h4>
                    <ul className="list-disc ml-4 space-y-1">
                      {preview.analysis.recommendations.map((rec, idx) => (
                        <li key={idx} className="text-sm text-muted-foreground">
                          {rec}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="tokens" className="space-y-4">
                {(() => {
                  const ts = (preview as any).tokenStats
                  if (!ts?.total || (ts.total.inputTokens === 0 && ts.total.outputTokens === 0)) {
                    return <div className="text-center py-8 text-muted-foreground">无 Token 使用数据</div>
                  }
                  const fmt = (n: number) => n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
                  return (
                    <>
                      {/* Summary cards */}
                      <div className="grid grid-cols-3 gap-4">
                        <Card><CardContent className="pt-4 text-center">
                          <div className="text-xs text-muted-foreground mb-1">Input Tokens</div>
                          <div className="text-xl font-bold">{fmt(ts.total.inputTokens)}</div>
                        </CardContent></Card>
                        <Card><CardContent className="pt-4 text-center">
                          <div className="text-xs text-muted-foreground mb-1">Output Tokens</div>
                          <div className="text-xl font-bold">{fmt(ts.total.outputTokens)}</div>
                        </CardContent></Card>
                        <Card><CardContent className="pt-4 text-center">
                          <div className="text-xs text-muted-foreground mb-1">Total Cost</div>
                          <div className="text-xl font-bold">${ts.total.cost.toFixed(4)}</div>
                        </CardContent></Card>
                      </div>

                      {/* By Model */}
                      {ts.byModel.length > 0 && (
                        <Card>
                          <CardHeader className="pb-2"><CardTitle className="text-sm">按 Model</CardTitle></CardHeader>
                          <CardContent>
                            <table className="w-full text-xs">
                              <thead><tr className="border-b text-muted-foreground">
                                <th className="text-left py-1">Model</th>
                                <th className="text-right py-1">Input</th>
                                <th className="text-right py-1">Output</th>
                                <th className="text-right py-1">Cost</th>
                              </tr></thead>
                              <tbody>
                                {ts.byModel.map((m: any) => (
                                  <tr key={m.model} className="border-b last:border-0">
                                    <td className="py-1 font-mono">{m.model}</td>
                                    <td className="text-right py-1">{fmt(m.inputTokens)}</td>
                                    <td className="text-right py-1">{fmt(m.outputTokens)}</td>
                                    <td className="text-right py-1">${m.cost.toFixed(4)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </CardContent>
                        </Card>
                      )}

                      {/* By Workflow → Nodes */}
                      {ts.byWorkflow.length > 0 && (
                        <Card>
                          <CardHeader className="pb-2"><CardTitle className="text-sm">按工作流 / 节点</CardTitle></CardHeader>
                          <CardContent className="space-y-3">
                            {ts.byWorkflow.map((wf: any) => {
                              const wfNodes = (ts.nodes || []).filter((n: any) => n.workflowRef === wf.workflowRef)
                              return (
                                <div key={wf.workflowRef} className="border rounded-md p-3">
                                  <div className="flex justify-between items-center mb-2">
                                    <span className="text-sm font-medium">{wf.workflowRef}</span>
                                    <span className="text-xs text-muted-foreground">{fmt(wf.inputTokens + wf.outputTokens)} tokens · ${wf.cost.toFixed(4)}</span>
                                  </div>
                                  {wf.byModel.length > 0 && (
                                    <div className="flex gap-3 text-xs text-muted-foreground mb-2">
                                      {wf.byModel.map((m: any) => <span key={m.model}>{m.model}: {fmt(m.inputTokens + m.outputTokens)}</span>)}
                                    </div>
                                  )}
                                  {wfNodes.length > 0 && (
                                    <div className="ml-3 space-y-1">
                                      {wfNodes.map((node: any) => (
                                        <div key={node.nodeId} className="flex justify-between items-center text-xs py-0.5">
                                          <span className="flex items-center gap-2">
                                            <Badge variant="outline" className="text-[10px] px-1">{node.nodeType}</Badge>
                                            <span className="font-mono">{node.nodeName}</span>
                                          </span>
                                          <span className="text-muted-foreground">{fmt(node.inputTokens + node.outputTokens)} tokens · ${node.cost.toFixed(4)}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </CardContent>
                        </Card>
                      )}
                    </>
                  )
                })()}
              </TabsContent>

              <TabsContent value="experiences">
                {preview.experiences.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    未检测到可提取的经验
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between mb-4">
                      <p className="text-sm text-muted-foreground">
                        选择要合并到知识库的经验（已选 {selectedExperiences.length}）
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setSelectedExperiences(
                            selectedExperiences.length === preview.experiences.length
                              ? []
                              : preview.experiences.map((e) => e.id)
                          )
                        }
                      >
                        {selectedExperiences.length === preview.experiences.length
                          ? "取消全选"
                          : "全选"}
                      </Button>
                    </div>

                    {(["add", "update", "delete"] as const).map((action) => {
                      const group = preview.experiences.filter(
                        (e) => (e.action ?? "add") === action
                      )
                      if (group.length === 0) return null

                      const label =
                        action === "add" ? "新增" : action === "update" ? "修改" : "删除"
                      const icon =
                        action === "add" ? "🟢" : action === "update" ? "🟡" : "🔴"

                      return (
                        <div key={action}>
                          <h4 className="text-sm font-medium mb-2">
                            {icon} {label} ({group.length})
                          </h4>
                          <div className="space-y-2">
                            {group.map((exp) => (
                              <Card key={exp.id}>
                                <CardContent className="pt-4">
                                  <div className="flex items-start gap-3">
                                    <Checkbox
                                      checked={selectedExperiences.includes(exp.id)}
                                      onCheckedChange={() => toggleExperience(exp.id)}
                                    />
                                    <div className="flex-1">
                                      <p className="text-sm">{exp.text}</p>
                                      {exp.replaces_text && (
                                        <p className="text-xs text-muted-foreground mt-1 italic">
                                          原文: &ldquo;{exp.replaces_text}&rdquo;
                                        </p>
                                      )}
                                      <div className="flex items-center gap-2 mt-2">
                                        <Badge variant="outline" className="text-xs">
                                          {exp.scope ?? "org"}: {exp.target ?? "all"}
                                        </Badge>
                                        <Badge variant="secondary" className="text-xs">
                                          置信度: {((exp.confidence ?? 0.5) * 100).toFixed(0)}%
                                        </Badge>
                                      </div>
                                    </div>
                                  </div>
                                </CardContent>
                              </Card>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="skills">
                {preview.skills.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    未检测到可提取的 Skill
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between mb-4">
                      <p className="text-sm text-muted-foreground">
                        选择要安装到资源库的 Skill（已选 {selectedSkills.length}）
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setSelectedSkills(
                            selectedSkills.length === preview.skills.length
                              ? []
                              : preview.skills.map((s) => s.name)
                          )
                        }
                      >
                        {selectedSkills.length === preview.skills.length ? "取消全选" : "全选"}
                      </Button>
                    </div>
                    {preview.skills.map((skill) => (
                      <Card key={skill.name}>
                        <CardContent className="pt-4">
                          <div className="flex items-start gap-3">
                            <Checkbox
                              checked={selectedSkills.includes(skill.name)}
                              onCheckedChange={() => toggleSkill(skill.name)}
                            />
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <Package className="h-4 w-4" />
                                <h4 className="font-semibold">{skill.name}</h4>
                                {(skill as any).status === "updated" ? (
                                  <Badge variant="default" className="text-xs bg-amber-500">有更新</Badge>
                                ) : (skill as any).status === "new" ? (
                                  <Badge variant="default" className="text-xs bg-green-600">新发现</Badge>
                                ) : skill.auto_discovered ? (
                                  <Badge variant="default" className="text-xs">
                                    <FileText className="h-3 w-3 mr-1" />
                                    自动发现
                                  </Badge>
                                ) : (
                                  <Badge variant="secondary" className="text-xs">
                                    <Lightbulb className="h-3 w-3 mr-1" />
                                    LLM 生成
                                  </Badge>
                                )}
                              </div>
                              <p className="text-sm text-muted-foreground mb-2">
                                {skill.description}
                              </p>
                              <p className="text-xs text-muted-foreground mb-2">
                                <strong>提取原因:</strong> {skill.reason}
                              </p>
                              {skill.content && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 px-2 text-xs mb-2"
                                  onClick={() => {
                                    const newExpanded = new Set(expandedSkills)
                                    if (newExpanded.has(skill.name)) {
                                      newExpanded.delete(skill.name)
                                    } else {
                                      newExpanded.add(skill.name)
                                    }
                                    setExpandedSkills(newExpanded)
                                  }}
                                >
                                  {expandedSkills.has(skill.name) ? (
                                    <>
                                      <ChevronUp className="h-3 w-3 mr-1" />
                                      收起内容
                                    </>
                                  ) : (
                                    <>
                                      <ChevronDown className="h-3 w-3 mr-1" />
                                      查看内容
                                    </>
                                  )}
                                </Button>
                              )}
                              {expandedSkills.has(skill.name) && skill.content && (
                                <div className="mb-2 p-2 bg-muted rounded-md text-xs font-mono max-h-60 overflow-y-auto whitespace-pre-wrap">
                                  {skill.content}
                                </div>
                              )}
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">安装到组:</span>
                                <GroupSelector
                                  value={skillGroups[skill.name] ?? "archive-extracted"}
                                  groups={resourceGroups.skillGroups}
                                  onChange={(v) => setSkillGroups(prev => ({ ...prev, [skill.name]: v }))}
                                  onCreateGroup={(name) => setResourceGroups(prev => ({
                                    ...prev,
                                    skillGroups: [...prev.skillGroups, name].sort(),
                                  }))}
                                />
                              </div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="workflows">
                {(() => {
                  const wfs: Array<{ name: string; description: string; content?: string }> = (preview as any).workflows ?? []
                  if (wfs.length === 0) {
                    return <div className="text-center py-8 text-muted-foreground">未发现项目级工作流</div>
                  }
                  return (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between mb-4">
                        <p className="text-sm text-muted-foreground">
                          选择要安装到资源库的工作流（已选 {selectedWorkflows.length}）
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setSelectedWorkflows(
                              selectedWorkflows.length === wfs.length ? [] : wfs.map((w) => w.name)
                            )
                          }
                        >
                          {selectedWorkflows.length === wfs.length ? "取消全选" : "全选"}
                        </Button>
                      </div>
                      {wfs.map((wf) => (
                        <Card key={wf.name}>
                          <CardContent className="pt-4">
                            <div className="flex items-start gap-3">
                              <Checkbox
                                checked={selectedWorkflows.includes(wf.name)}
                                onCheckedChange={() =>
                                  setSelectedWorkflows((prev) =>
                                    prev.includes(wf.name) ? prev.filter((s) => s !== wf.name) : [...prev, wf.name]
                                  )
                                }
                              />
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  <Package className="h-4 w-4" />
                                  <h4 className="font-semibold">{wf.name}</h4>
                                  {wf.status === "updated" ? (
                                    <Badge variant="default" className="text-xs bg-amber-500">有更新</Badge>
                                  ) : wf.status === "new" ? (
                                    <Badge variant="default" className="text-xs bg-green-600">新发现</Badge>
                                  ) : null}
                                </div>
                                <p className="text-sm text-muted-foreground mb-2">{wf.description}</p>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground">安装到组:</span>
                                  <GroupSelector
                                    value={workflowGroups[wf.name] ?? "archive-extracted"}
                                    groups={resourceGroups.workflowGroups}
                                    onChange={(v) => setWorkflowGroups(prev => ({ ...prev, [wf.name]: v }))}
                                    onCreateGroup={(name) => setResourceGroups(prev => ({
                                      ...prev,
                                      workflowGroups: [...prev.workflowGroups, name].sort(),
                                    }))}
                                  />
                                </div>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )
                })()}
              </TabsContent>

              <TabsContent value="agents">
                {(() => {
                  const agents: Array<{ name: string; description: string; content?: string }> = (preview as any).agents ?? []
                  if (agents.length === 0) {
                    return <div className="text-center py-8 text-muted-foreground">未发现 Agent</div>
                  }
                  return (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between mb-4">
                        <p className="text-sm text-muted-foreground">
                          选择要安装到资源库的 Agent（已选 {selectedAgents.length}）
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setSelectedAgents(
                              selectedAgents.length === agents.length ? [] : agents.map((a) => a.name)
                            )
                          }
                        >
                          {selectedAgents.length === agents.length ? "取消全选" : "全选"}
                        </Button>
                      </div>
                      {agents.map((agent) => (
                        <Card key={agent.name}>
                          <CardContent className="pt-4">
                            <div className="flex items-start gap-3">
                              <Checkbox
                                checked={selectedAgents.includes(agent.name)}
                                onCheckedChange={() =>
                                  setSelectedAgents((prev) =>
                                    prev.includes(agent.name) ? prev.filter((s) => s !== agent.name) : [...prev, agent.name]
                                  )
                                }
                              />
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  <Package className="h-4 w-4" />
                                  <h4 className="font-semibold">{agent.name}</h4>
                                  {(agent as any).status === "updated" ? (
                                    <Badge variant="default" className="text-xs bg-amber-500">有更新</Badge>
                                  ) : (agent as any).status === "new" ? (
                                    <Badge variant="default" className="text-xs bg-green-600">新发现</Badge>
                                  ) : null}
                                </div>
                                <p className="text-sm text-muted-foreground mb-2">{agent.description}</p>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs text-muted-foreground">安装到组:</span>
                                  <GroupSelector
                                    value={agentGroups[agent.name] ?? "archive-extracted"}
                                    groups={resourceGroups.agentGroups}
                                    onChange={(v) => setAgentGroups(prev => ({ ...prev, [agent.name]: v }))}
                                    onCreateGroup={(name) => setResourceGroups(prev => ({
                                      ...prev,
                                      agentGroups: [...prev.agentGroups, name].sort(),
                                    }))}
                                  />
                                </div>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )
                })()}
              </TabsContent>
            </Tabs>
          </div>
        </div>
        ) : !started ? (
          <div className="flex flex-col items-center justify-center gap-4 py-16">
            <p className="text-muted-foreground">分析工作空间的执行记录，提取可复用的经验和 Skill</p>
            <Button onClick={handleStartAnalysis} size="lg">
              开始归档分析
            </Button>
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">加载预览失败</div>
        )}

        {!archiving && preview && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={archiving}>
              取消
            </Button>
            <Button onClick={handleArchive} disabled={archiving || loading}>
              {archiving ? "归档中..." : "确认归档"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
