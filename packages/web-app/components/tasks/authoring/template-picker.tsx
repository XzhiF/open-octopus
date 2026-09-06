// packages/web-app/components/tasks/authoring/template-picker.tsx
//
// 新建任务模板页（v4-only 改版）。渲染于 TaskModal task===null（[+新建]）。
// task-phase-redesign 契约修复后本页面只做一件事：
//   1. 展示 v4 直通流程说明（task-author 对话拆 Phase）
//   2. 采集 codebase 语境（org + projects — 恢复票 11 下线的项目选择）：
//      project 语境既进 task home 的 context.md（领域阅读路由键），也是
//      执行期 workspace 的 repo 绑定来源。
// 然后 开始编写 → onCreate({org?, projects})。父层（TaskModal）跑 D15 创建序列
// （session-first → POST /api/tasks 直建 v4 draft：task_spec:{format:"v4"} +
// project_ids）并进入 AuthoringWorkspace。
//
// 已退役（v4 UI 收敛）：类型卡（coding/generic 二选一 — generic 入口移除）、
// skill 组勾选（matt 技能族随 task-author clone 自动就位，票 09/K15）、
// goal/ac 任何痕迹（v4 起草不写）。任务名不在本页采集 — EditableTitle 事后改 +
// autosave 智能标题机制不变。

"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Lock } from "lucide-react"
import { ProjectSelector, type SelectedProject } from "@/components/scheduler/project-selector"
import { useOrgs } from "@/hooks/useOrgs"

export interface TemplatePickerValue {
  org?: string
  projects: string[]
}

export interface TemplatePickerProps {
  onCreate: (value: TemplatePickerValue) => void
  /** Disable the create button while the parent runs the create sequence. */
  busy?: boolean
}

export function TemplatePicker({ onCreate, busy }: TemplatePickerProps) {
  const { orgs } = useOrgs()
  const [org, setOrg] = useState<string>(orgs[0]?.name ?? "")
  const [projects, setProjects] = useState<SelectedProject[]>([])

  // Sync org when orgs list loads.
  useEffect(() => {
    if (orgs.length > 0 && !org) setOrg(orgs[0].name)
  }, [orgs, org])

  // Projects are optional at creation — the conversation can still bind
  // spec-field(projects) later, and the workspace 预设 button stays available
  // (non-empty locks it, same discipline as the authoring workspace).
  const canCreate = true

  const handleCreate = () => {
    if (!canCreate) return
    onCreate({ org, projects: projects.map((p) => p.name) })
  }

  return (
    <div className="h-full overflow-y-auto" data-template-picker>
      <div className="max-w-lg mx-auto py-8 px-4 space-y-6">
        <div>
          <h2 className="text-lg font-semibold">新建开发任务</h2>
          <p className="text-xs text-muted-foreground mt-1">
            直通 spec agent（matt 技能族自动就位）：对话澄清 → 拆 Phase 交付，
            每个 Phase 一份可验收的 Batch 产物（spec + 票 + 绑定工作流）。
            项目语境可现在选，也可对话中补 <Lock className="inline size-3" />（选定后锁定）。
          </p>
        </div>

        {/* ── codebase 语境（org + projects；US14/D13 恢复）── */}
        <section data-preset-context>
          <div className="text-xs font-medium mb-2">
            codebase <span className="text-muted-foreground font-normal">（领域阅读路由键；执行技能归 workflow.requires）</span>
          </div>
          {orgs.length > 1 ? (
            <select
              className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs mb-2"
              value={org}
              onChange={(e) => { setOrg(e.target.value); setProjects([]) }}
            >
              {orgs.map((o) => (
                <option key={o.name} value={o.name}>{o.name}</option>
              ))}
            </select>
          ) : (
            <div className="text-xs text-muted-foreground mb-2">{org || "未配置组织"}</div>
          )}
          {org ? (
            <ProjectSelector org={org} value={projects} onChange={setProjects} />
          ) : (
            <p className="text-xs text-muted-foreground">未配置组织 — 请先运行 octopus setup。</p>
          )}
        </section>

        <Button className="w-full" onClick={handleCreate} disabled={!canCreate || busy} data-template-create>
          {busy ? "创建中…" : "开始编写 →"}
        </Button>
      </div>
    </div>
  )
}
