// packages/web-app/components/tasks/authoring/template-picker.tsx
//
// The v3 two-phase-flow template page (ticket 09, US1/US2/US14/D2/D3/D13).
// Rendered inside TaskModal when task===null ([+新建]). The user picks:
//   1. task type (coding | generic) — D13
//   2. skill groups (multi-select, LOCKED at creation per ADR-0012) — D2/D3
//   3. authoring context (org + projects; coding template only) — US14/D13
// Then 开始编写 → onCreate({task_type, skill_groups, preset{org,projects}}).
// The parent (TaskModal) runs the D15 create sequence (session-first, then
// POST /api/tasks with these fields) and transitions to the AuthoringWorkspace.
//
// Interaction reference: prototype VariantL template phase
// (app/tasks/prototype/page.tsx:3079) — code rewritten, not copied.

"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Check, Code2, FileText, Lock } from "lucide-react"
import { listSkillGroups, type SkillGroup } from "@/lib/skill-groups-api"
import { ProjectSelector, type SelectedProject } from "@/components/scheduler/project-selector"
import { useOrgs } from "@/hooks/useOrgs"

/** The built-in empty-marker group name (D17 — selecting it = use only the
 *  built-in spec-field flow + shared skills; the plugin-materializer skips
 *  it so re-materializing would cause the SDK to discover duplicates). */
const DEFAULT_SKILL_GROUP = "default"

export type TaskType = "coding" | "generic"

export interface TemplatePickerValue {
  task_type: TaskType
  skill_groups: string[]
  preset: { org?: string; projects: string[] }
}

export interface TemplatePickerProps {
  onCreate: (value: TemplatePickerValue) => void
  /** Disable the create button while the parent runs the create sequence. */
  busy?: boolean
}

export function TemplatePicker({ onCreate, busy }: TemplatePickerProps) {
  const { orgs } = useOrgs()
  const [taskType, setTaskType] = useState<TaskType>("coding")
  const [groups, setGroups] = useState<SkillGroup[]>([])
  const [selectedGroups, setSelectedGroups] = useState<string[]>([])
  const [org, setOrg] = useState<string>(orgs[0]?.name ?? "")
  const [projects, setProjects] = useState<SelectedProject[]>([])

  useEffect(() => {
    let cancelled = false
    listSkillGroups()
      .then((data) => {
        if (cancelled) return
        setGroups(data.groups)
      })
      .catch(() => {
        // Network/registry failure — the group list stays empty; the user
        // can't proceed (the default group is still server-side, but the
        // checkbox wouldn't render). Best-effort: leave the picker usable
        // by not crashing.
        if (!cancelled) setGroups([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot fetch
  }, [])

  // Sync org when orgs list loads.
  useEffect(() => {
    if (orgs.length > 0 && !org) setOrg(orgs[0].name)
  }, [orgs, org])

  const toggleGroup = (group: string) => {
    const on = selectedGroups.includes(group)
    if (on) {
      setSelectedGroups(selectedGroups.filter((g) => g !== group))
    } else {
      setSelectedGroups([...selectedGroups, group])
    }
  }

  // Skill groups are optional — zero selection is fine (only the built-in
  // spec-field flow + shared skills will be available).
  const canCreate = true

  const handleCreate = () => {
    if (!canCreate) return
    onCreate({
      task_type: taskType,
      skill_groups: selectedGroups,
      preset: {
        // preset.org is only meaningful for the coding template, but the
        // server reads it regardless; sending it is harmless + keeps the
        // shape stable for the generic case (no projects).
        org: taskType === "coding" ? org : undefined,
        projects:
          taskType === "coding" ? projects.map((p) => p.name) : [],
      },
    })
  }

  return (
    <div className="h-full overflow-y-auto" data-template-picker>
      <div className="max-w-lg mx-auto py-8 px-4 space-y-6">
        <div>
          <h2 className="text-lg font-semibold">新建任务</h2>
          <p className="text-xs text-muted-foreground mt-1">
            类型 + Skill 组在创建后锁定 <Lock className="inline size-3" />。想换组合 = 新建任务（旧草稿保留）。
          </p>
        </div>

        {/* ── task type ── */}
        <section>
          <div className="text-xs font-medium mb-2">任务类型</div>
          <div className="grid grid-cols-2 gap-2">
            {([
              ["coding", "🛠 开发任务", "org + 项目语境，spec 驱动"],
              ["generic", "📄 通用任务", "对话澄清，轻量"],
            ] as const).map(([id, label, desc]) => (
              <button
                key={id}
                onClick={() => setTaskType(id)}
                data-task-type={id}
                className={`rounded-lg border p-3 text-left ${taskType === id ? "border-blue-400 bg-blue-500/5" : "border-border"}`}
              >
                <div className="text-sm font-medium">{label}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">{desc}</div>
              </button>
            ))}
          </div>
        </section>

        {/* ── skill groups (multi-select, locked at creation) ── */}
        <section>
          <div className="text-xs font-medium mb-2 flex items-center gap-1">
            Skill 组 <Lock className="size-3" />
            <span className="text-muted-foreground font-normal">可多选 · 创建后锁定</span>
          </div>
          {groups.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">
              未发现已安装 Skill 组（仅可选「默认通用」组）。
            </p>
          ) : null}
          <div className="space-y-1.5">
            {groups.map((g) => {
              const on = selectedGroups.includes(g.group)
              const isDefault = g.group === DEFAULT_SKILL_GROUP
              return (
                <button
                  key={g.group}
                  onClick={() => toggleGroup(g.group)}
                  aria-label={g.group}
                  data-skill-group={g.group}
                  data-selected={on ? "true" : "false"}
                  className={`w-full rounded-lg border px-3 py-2 text-left flex items-center gap-2 ${on ? "border-blue-400 bg-blue-500/5" : "border-border"}`}
                >
                  <span
                    className={`size-4 rounded border flex items-center justify-center shrink-0 ${on ? "bg-blue-500 border-blue-500 text-white" : "border-muted-foreground/40"}`}
                  >
                    {on && <Check className="size-3" />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium flex items-center gap-1">
                      {g.displayName}
                      {isDefault && (
                        <Badge variant="outline" className="text-[9px]">默认通用</Badge>
                      )}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {isDefault ? "不物化：仅用内置 spec-field 流程 + 共享 skills" : `${g.skills.length} 个命令`}
                    </div>
                    {!isDefault && g.skills.length > 0 && (
                      <div className="text-[10px] text-muted-foreground/70 mt-0.5 truncate">
                        {g.skills.map((s) => `/${s.name}`).join("  ")}
                      </div>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
          {selectedGroups.length > 1 && (
            <div className="mt-2 text-[10px] text-amber-600 bg-amber-500/10 rounded px-2 py-1.5">
              ⚠ 整合模式：{selectedGroups.length} 个组的命令都可用，产物按「登记不搬迁」各自索引。
            </div>
          )}
        </section>

        {/* ── authoring context (coding only; US14: skills NOT here) ── */}
        {taskType === "coding" && (
          <section>
            <div className="text-xs font-medium mb-2">
              编写语境 <span className="text-muted-foreground font-normal">（预设仅此两项；执行技能归 workflow.requires）</span>
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
        )}

        <Button className="w-full" onClick={handleCreate} disabled={!canCreate || busy} data-template-create>
          {busy ? "创建中…" : "开始编写 →"}
        </Button>
      </div>
    </div>
  )
}
