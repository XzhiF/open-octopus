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
import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Loader2, TrendingUp, DollarSign, AlertCircle, Lightbulb, Package } from "lucide-react"
import { previewArchive, archiveWorkspace } from "@/lib/archive-api"
import { toast } from "sonner"
import type { Workspace } from "@/lib/types"
import type { ArchivePreview, ExperienceCandidate, SkillCandidate } from "@/lib/archive-api"

interface ArchivePreviewDialogProps {
  workspace: Workspace | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onArchived: () => void
}

export function ArchivePreviewDialog({
  workspace,
  open,
  onOpenChange,
  onArchived,
}: ArchivePreviewDialogProps) {
  const [preview, setPreview] = useState<ArchivePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [selectedExperiences, setSelectedExperiences] = useState<string[]>([])
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState("analysis")

  useEffect(() => {
    if (open && workspace) {
      loadPreview()
    }
  }, [open, workspace])

  const loadPreview = async () => {
    if (!workspace) return
    setLoading(true)
    try {
      const result = await previewArchive(workspace.id)
      setPreview(result)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载预览失败")
    } finally {
      setLoading(false)
    }
  }

  const handleArchive = async () => {
    if (!workspace) return
    setArchiving(true)
    try {
      await archiveWorkspace(workspace.id, {
        extractExperiences: selectedExperiences,
        installSkills: selectedSkills,
      })
      toast.success(`"${workspace.name}" 已归档`)
      onOpenChange(false)
      onArchived()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "归档失败")
    } finally {
      setArchiving(false)
    }
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
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>归档工作空间预览</DialogTitle>
          <DialogDescription>
            查看 &ldquo;{workspace.name}&rdquo; 的归档分析结果，选择要提取的经验和 Skill
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <span className="ml-2 text-muted-foreground">正在分析工作空间...</span>
          </div>
        ) : preview ? (
          <div className="space-y-6">
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
                    成功率: {(preview.stats.success_rate * 100).toFixed(1)}%
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
                    {preview.experiences.length + preview.skills.length}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {preview.experiences.length} 经验, {preview.skills.length} Skill
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="analysis">分析报告</TabsTrigger>
                <TabsTrigger value="experiences">
                  经验 ({preview.experiences.length})
                </TabsTrigger>
                <TabsTrigger value="skills">Skill ({preview.skills.length})</TabsTrigger>
                <TabsTrigger value="summary">归档摘要</TabsTrigger>
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
                    <p className="text-sm text-muted-foreground">
                      {preview.analysis.cost_efficiency}
                    </p>
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

              <TabsContent value="experiences">
                {preview.experiences.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    未检测到可提取的经验
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between mb-4">
                      <p className="text-sm text-muted-foreground">
                        选择要提取到知识库的经验（已选 {selectedExperiences.length}）
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
                    {preview.experiences.map((exp) => (
                      <Card key={exp.id}>
                        <CardContent className="pt-4">
                          <div className="flex items-start gap-3">
                            <Checkbox
                              checked={selectedExperiences.includes(exp.id)}
                              onCheckedChange={() => toggleExperience(exp.id)}
                            />
                            <div className="flex-1">
                              <p className="text-sm">{exp.text}</p>
                              <div className="flex items-center gap-2 mt-2">
                                <Badge variant="outline" className="text-xs">
                                  {exp.scope}
                                </Badge>
                                <Badge variant="secondary" className="text-xs">
                                  置信度: {(exp.confidence * 100).toFixed(0)}%
                                </Badge>
                              </div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
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
                              </div>
                              <p className="text-sm text-muted-foreground mb-2">
                                {skill.description}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                <strong>提取原因:</strong> {skill.reason}
                              </p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="summary">
                <div className="space-y-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">归档操作摘要</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">执行记录</span>
                        <span className="font-medium">{preview.stats.execution_count} 个将被归档</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">文件目录</span>
                        <span className="font-medium">将被删除（释放磁盘空间）</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">统计数据</span>
                        <span className="font-medium">保留用于 Dashboard 分析</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">提取经验</span>
                        <span className="font-medium">{selectedExperiences.length} 个</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">安装 Skill</span>
                        <span className="font-medium">{selectedSkills.length} 个</span>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>
            </Tabs>
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">加载预览失败</div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={archiving}>
            取消
          </Button>
          <Button onClick={handleArchive} disabled={archiving || loading}>
            {archiving ? "归档中..." : "确认归档"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
