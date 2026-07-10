"use client"

import { useState, useEffect } from "react"
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Loader2, TrendingUp, DollarSign, AlertCircle, Lightbulb, Package, FileText, Check, Badge as BadgeIcon } from "lucide-react"
import { getServerUrl } from "@/lib/server-config"

interface ArchiveViewDialogProps {
  workspaceId: string | null
  workspaceName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface ArchiveMetadata {
  experiences?: Array<{ id: string; text: string; action?: string; confidence?: number; scope?: string; target?: string }>
  skills?: Array<{ name: string; description: string; reason?: string; auto_discovered?: boolean }>
  allExperiences?: Array<{ id: string; text: string; action?: string; confidence?: number; scope?: string; target?: string }>
  allSkills?: Array<{ name: string; description: string; reason?: string; auto_discovered?: boolean }>
  allWorkflows?: Array<{ name: string; description: string }>
  workflows?: Array<{ name: string; description: string }>
  tokenStats?: {
    total: { inputTokens: number; outputTokens: number; cost: number }
    byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number }>
    byWorkflow: Array<{ workflowRef: string; inputTokens: number; outputTokens: number; cost: number; byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number }> }>
    nodes: Array<{ workflowRef: string; nodeId: string; nodeName: string; nodeType: string; inputTokens: number; outputTokens: number; cost: number; byModel: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number }> }>
  }
}

interface AnalysisReport {
  summary?: string
  execution_patterns?: string[]
  cost_efficiency?: { rating: string; analysis: string; optimization_ideas?: string[] }
  error_patterns?: string[]
  recommendations?: string[]
}

interface ArchiveData {
  workspace_id: string
  name: string
  description: string | null
  execution_count: number
  total_cost: number
  total_duration_ms: number
  archived_at: string
  extracted_experiences: number
  extracted_skills: number
  analysis_report: unknown
  metadata: string | null
}

function formatDuration(ms: number) {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

function formatCost(cost: number) {
  return `$${cost.toFixed(2)}`
}

export function ArchiveViewDialog({ workspaceId, workspaceName, open, onOpenChange }: ArchiveViewDialogProps) {
  const [data, setData] = useState<ArchiveData | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState("summary")

  useEffect(() => {
    if (open && workspaceId) {
      setLoading(true)
      fetch(`${getServerUrl()}/api/archive/workspaces/${workspaceId}`, { credentials: "include" })
        .then(res => res.ok ? res.json() : null)
        .then(d => setData(d))
        .catch(() => setData(null))
        .finally(() => setLoading(false))
    }
    if (!open) {
      setData(null)
      setActiveTab("summary")
    }
  }, [open, workspaceId])

  const metadata: ArchiveMetadata | null = data?.metadata ? JSON.parse(data.metadata) : null
  const analysisReport: AnalysisReport | null = data?.analysis_report ? (typeof data.analysis_report === "string" ? JSON.parse(data.analysis_report) : data.analysis_report) : null
  const adoptedExpIds = new Set(metadata?.experiences?.map(e => e.id) ?? [])
  const adoptedSkillNames = new Set(metadata?.skills?.map(s => s.name) ?? [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[80vh] w-full sm:max-w-[960px] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>归档记录 — {workspaceName}</DialogTitle>
          <DialogDescription>
            查看 &ldquo;{workspaceName}&rdquo; 的归档结果
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : data ? (
            <div className="space-y-6 p-1">
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
                    <div className="text-2xl font-bold">{data.execution_count}</div>
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
                    <div className="text-2xl font-bold">{formatCost(data.total_cost)}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">总耗时</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{formatDuration(data.total_duration_ms)}</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">已提取</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {data.extracted_experiences + data.extracted_skills}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {data.extracted_experiences} 经验, {data.extracted_skills} Skill
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
                    经验 ({metadata?.allExperiences?.length ?? 0})
                  </TabsTrigger>
                  <TabsTrigger value="skills">
                    Skill ({metadata?.allSkills?.length ?? 0})
                  </TabsTrigger>
                  <TabsTrigger value="workflows">
                    工作流 ({metadata?.allWorkflows?.length ?? 0})
                  </TabsTrigger>
                  <TabsTrigger value="summary">归档摘要</TabsTrigger>
                </TabsList>

                <TabsContent value="analysis" className="space-y-4">
                  {analysisReport ? (
                    <>
                      {analysisReport.summary && (
                        <div>
                          <h4 className="font-semibold mb-2">总结</h4>
                          <p className="text-sm text-muted-foreground">{analysisReport.summary}</p>
                        </div>
                      )}
                      {(analysisReport.execution_patterns?.length ?? 0) > 0 && (
                        <div>
                          <h4 className="font-semibold mb-2 flex items-center gap-2">
                            <TrendingUp className="h-4 w-4" /> 执行模式
                          </h4>
                          <ul className="list-disc ml-4 space-y-1">
                            {analysisReport.execution_patterns!.map((p, i) => (
                              <li key={i} className="text-sm text-muted-foreground">{p}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {analysisReport.cost_efficiency && (
                        <div>
                          <h4 className="font-semibold mb-2 flex items-center gap-2">
                            <DollarSign className="h-4 w-4" /> 成本效率
                          </h4>
                          <div className="space-y-1">
                            <p className="text-sm">
                              <Badge variant="outline" className="mr-2">{analysisReport.cost_efficiency.rating}</Badge>
                              {analysisReport.cost_efficiency.analysis}
                            </p>
                            {(analysisReport.cost_efficiency.optimization_ideas?.length ?? 0) > 0 && (
                              <ul className="list-disc ml-4 mt-1 space-y-1">
                                {analysisReport.cost_efficiency.optimization_ideas!.map((idea, i) => (
                                  <li key={i} className="text-sm text-muted-foreground">{idea}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </div>
                      )}
                      {(analysisReport.error_patterns?.length ?? 0) > 0 && (
                        <div>
                          <h4 className="font-semibold mb-2 flex items-center gap-2">
                            <AlertCircle className="h-4 w-4" /> 错误模式
                          </h4>
                          <ul className="list-disc ml-4 space-y-1">
                            {analysisReport.error_patterns!.map((p, i) => (
                              <li key={i} className="text-sm text-muted-foreground">{p}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {(analysisReport.recommendations?.length ?? 0) > 0 && (
                        <div>
                          <h4 className="font-semibold mb-2 flex items-center gap-2">
                            <Lightbulb className="h-4 w-4" /> 建议
                          </h4>
                          <ul className="list-disc ml-4 space-y-1">
                            {analysisReport.recommendations!.map((r, i) => (
                              <li key={i} className="text-sm text-muted-foreground">{r}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-center py-8 text-muted-foreground">无分析报告数据</div>
                  )}
                </TabsContent>

                <TabsContent value="tokens" className="space-y-4">
                  {(() => {
                    const ts = metadata?.tokenStats
                    if (!ts?.total || (ts.total.inputTokens === 0 && ts.total.outputTokens === 0)) {
                      return <div className="text-center py-8 text-muted-foreground">无 Token 使用数据</div>
                    }
                    const fmt = (n: number) => n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
                    return (
                      <>
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
                                  {ts.byModel.map((m) => (
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
                        {ts.byWorkflow.length > 0 && (
                          <Card>
                            <CardHeader className="pb-2"><CardTitle className="text-sm">按工作流 / 节点</CardTitle></CardHeader>
                            <CardContent className="space-y-3">
                              {ts.byWorkflow.map((wf) => {
                                const wfNodes = (ts.nodes || []).filter((n) => n.workflowRef === wf.workflowRef)
                                return (
                                  <div key={wf.workflowRef} className="border rounded-md p-3">
                                    <div className="flex justify-between items-center mb-2">
                                      <span className="text-sm font-medium">{wf.workflowRef}</span>
                                      <span className="text-xs text-muted-foreground">{fmt(wf.inputTokens + wf.outputTokens)} tokens · ${wf.cost.toFixed(4)}</span>
                                    </div>
                                    {wf.byModel.length > 0 && (
                                      <div className="flex gap-3 text-xs text-muted-foreground mb-2">
                                        {wf.byModel.map((m) => <span key={m.model}>{m.model}: {fmt(m.inputTokens + m.outputTokens)}</span>)}
                                      </div>
                                    )}
                                    {wfNodes.length > 0 && (
                                      <div className="ml-3 space-y-1">
                                        {wfNodes.map((node) => (
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

                <TabsContent value="workflows">
                  {(() => {
                    const allWfs = metadata?.allWorkflows ?? []
                    const adoptedWfs = new Set((metadata?.workflows ?? []).map(w => w.name))
                    if (allWfs.length === 0) {
                      return <div className="text-center py-8 text-muted-foreground">无工作流记录</div>
                    }
                    return (
                      <div className="space-y-2">
                        {allWfs.map((wf) => {
                          const adopted = adoptedWfs.has(wf.name)
                          return (
                            <Card key={wf.name}>
                              <CardContent className="pt-4">
                                <div className="flex items-start gap-3">
                                  {adopted ? (
                                    <div className="flex h-5 w-5 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30 shrink-0 mt-0.5">
                                      <Check className="h-3 w-3 text-green-600" />
                                    </div>
                                  ) : (
                                    <div className="flex h-5 w-5 items-center justify-center rounded-full bg-muted shrink-0 mt-0.5" />
                                  )}
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-1">
                                      <Package className="h-4 w-4" />
                                      <h4 className="font-semibold">{wf.name}</h4>
                                      {adopted && <Badge className="text-xs bg-green-600">已安装</Badge>}
                                    </div>
                                    <p className="text-sm text-muted-foreground">{wf.description}</p>
                                  </div>
                                </div>
                              </CardContent>
                            </Card>
                          )
                        })}
                      </div>
                    )
                  })()}
                </TabsContent>

                <TabsContent value="summary" className="space-y-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">归档信息</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">归档时间</span>
                        <span className="font-medium">{new Date(data.archived_at).toLocaleString("zh-CN")}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">执行记录</span>
                        <span className="font-medium">{data.execution_count} 个已归档</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">提取经验</span>
                        <span className="font-medium">{data.extracted_experiences} 个</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">安装 Skill</span>
                        <span className="font-medium">{data.extracted_skills} 个</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">文件清理</span>
                        <span className="font-medium">已删除</span>
                      </div>
                    </CardContent>
                  </Card>
                </TabsContent>

                <TabsContent value="experiences">
                  {!metadata?.allExperiences?.length ? (
                    <div className="text-center py-8 text-muted-foreground">无经验记录</div>
                  ) : (
                    <div className="space-y-2">
                      {(["add", "update", "delete"] as const).map((action) => {
                        const group = metadata.allExperiences!.filter(e => (e.action ?? "add") === action)
                        if (group.length === 0) return null
                        const label = action === "add" ? "新增" : action === "update" ? "修改" : "删除"
                        const icon = action === "add" ? "🟢" : action === "update" ? "🟡" : "🔴"
                        return (
                          <div key={action}>
                            <h4 className="text-sm font-medium mb-2">{icon} {label} ({group.length})</h4>
                            <div className="space-y-2">
                              {group.map((exp) => {
                                const adopted = adoptedExpIds.has(exp.id)
                                return (
                                  <Card key={exp.id}>
                                    <CardContent className="pt-4">
                                      <div className="flex items-start gap-3">
                                        {adopted ? (
                                          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30 shrink-0 mt-0.5">
                                            <Check className="h-3 w-3 text-green-600" />
                                          </div>
                                        ) : (
                                          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-muted shrink-0 mt-0.5" />
                                        )}
                                        <div className="flex-1">
                                          <p className="text-sm">{exp.text}</p>
                                          <div className="flex items-center gap-2 mt-2">
                                            {exp.scope && (
                                              <Badge variant="outline" className="text-xs">{exp.scope}: {exp.target ?? "all"}</Badge>
                                            )}
                                            {exp.confidence != null && (
                                              <Badge variant="secondary" className="text-xs">置信度: {(exp.confidence * 100).toFixed(0)}%</Badge>
                                            )}
                                            {adopted && <Badge className="text-xs bg-green-600">已采纳</Badge>}
                                          </div>
                                        </div>
                                      </div>
                                    </CardContent>
                                  </Card>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="skills">
                  {!metadata?.allSkills?.length ? (
                    <div className="text-center py-8 text-muted-foreground">无 Skill 记录</div>
                  ) : (
                    <div className="space-y-2">
                      {metadata.allSkills.map((skill) => {
                        const adopted = adoptedSkillNames.has(skill.name)
                        return (
                          <Card key={skill.name}>
                            <CardContent className="pt-4">
                              <div className="flex items-start gap-3">
                                {adopted ? (
                                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30 shrink-0 mt-0.5">
                                    <Check className="h-3 w-3 text-green-600" />
                                  </div>
                                ) : (
                                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-muted shrink-0 mt-0.5" />
                                )}
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-1">
                                    <Package className="h-4 w-4" />
                                    <h4 className="font-semibold">{skill.name}</h4>
                                    {skill.auto_discovered ? (
                                      <Badge variant="default" className="text-xs"><FileText className="h-3 w-3 mr-1" />自动发现</Badge>
                                    ) : (
                                      <Badge variant="secondary" className="text-xs">LLM 生成</Badge>
                                    )}
                                    {adopted && <Badge className="text-xs bg-green-600">已安装</Badge>}
                                  </div>
                                  <p className="text-sm text-muted-foreground">{skill.description}</p>
                                  {skill.reason && (
                                    <p className="text-xs text-muted-foreground mt-1"><strong>提取原因:</strong> {skill.reason}</p>
                                  )}
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        )
                      })}
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">无归档记录</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
