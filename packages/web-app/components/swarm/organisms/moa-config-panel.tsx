"use client"

import { useReducer, useCallback, useState, useEffect } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { ModelResolveBadge } from "../atoms/model-resolve-badge"
import { ExpertAvatar } from "../atoms/expert-avatar"
import { YamlSyncModal } from "../molecules/yaml-sync-modal"
import { Plus, Trash2, Download, Upload } from "lucide-react"
import { toast } from "sonner"
import { fetchModelAliasConfig, validateWorkflow } from "@/lib/api-client"

// ── Types ──

interface MoaExpert {
  id: string
  role: string
  model: string
  prompt: string
}

interface MoaAggregator {
  model: string
  prompt: string
  rounds: number
}

interface MoaConfigState {
  experts: MoaExpert[]
  aggregator: MoaAggregator
  mode: string
}

type MoaConfigAction =
  | { type: "add_expert" }
  | { type: "remove_expert"; id: string }
  | { type: "update_expert"; id: string; field: keyof MoaExpert; value: string }
  | { type: "update_aggregator"; field: keyof MoaAggregator; value: string | number }
  | { type: "import_config"; config: Partial<MoaConfigState> }

let expertCounter = 0
function nextExpertId() {
  return `expert-${++expertCounter}`
}

function moaConfigReducer(state: MoaConfigState, action: MoaConfigAction): MoaConfigState {
  switch (action.type) {
    case "add_expert":
      return {
        ...state,
        experts: [...state.experts, { id: nextExpertId(), role: "", model: "", prompt: "" }],
      }
    case "remove_expert":
      return { ...state, experts: state.experts.filter((e) => e.id !== action.id) }
    case "update_expert":
      return {
        ...state,
        experts: state.experts.map((e) =>
          e.id === action.id ? { ...e, [action.field]: action.value } : e,
        ),
      }
    case "update_aggregator":
      return { ...state, aggregator: { ...state.aggregator, [action.field]: action.value } }
    case "import_config":
      return {
        mode: action.config.mode ?? state.mode,
        experts: (action.config.experts as MoaExpert[]) ?? state.experts,
        aggregator: (action.config.aggregator as MoaAggregator) ?? state.aggregator,
      }
    default:
      return state
  }
}

const initialState: MoaConfigState = {
  mode: "moa",
  experts: [],
  aggregator: { model: "", prompt: "", rounds: 1 },
}

// ── Component ──

export interface MoaConfigPanelProps {
  workspaceId: string
  onSave?: (config: MoaConfigState) => void
  onCancel?: () => void
  initialConfig?: Partial<MoaConfigState>
}

export function MoaConfigPanel({
  workspaceId,
  onSave,
  onCancel,
  initialConfig,
}: MoaConfigPanelProps) {
  const [state, dispatch] = useReducer(moaConfigReducer, { ...initialState, ...initialConfig })
  const [saving, setSaving] = useState(false)
  const [yamlModalOpen, setYamlModalOpen] = useState(false)
  const [yamlModalMode, setYamlModalMode] = useState<"export" | "import">("export")
  const [tierMap, setTierMap] = useState<Record<string, Record<string, string>>>({})
  const providerType = "pi"

  useEffect(() => {
    fetchModelAliasConfig(workspaceId)
      .then((cfg) => setTierMap(cfg.providers ?? {}))
      .catch(() => {})
  }, [workspaceId])

  const modelOptions = Object.keys(tierMap[providerType] ?? {})

  const canSave =
    state.experts.length >= 2 &&
    state.experts.every((e) => e.role && e.model) &&
    state.aggregator.model &&
    state.aggregator.prompt

  const duplicateRoles = state.experts.filter(
    (e, i) => state.experts.findIndex((o) => o.role === e.role) !== i && e.role,
  )

  const generateYaml = useCallback(() => {
    const lines: string[] = [
      "type: swarm",
      "mode: moa",
      "experts:",
    ]
    for (const e of state.experts) {
      lines.push(`  - role: "${e.role}"`)
      lines.push(`    model: "${e.model}"`)
      lines.push(`    prompt: "${e.prompt.replace(/"/g, '\\"')}"`)
    }
    lines.push("aggregator:")
    lines.push(`  model: "${state.aggregator.model}"`)
    lines.push(`  prompt: "${state.aggregator.prompt.replace(/"/g, '\\"')}"`)
    lines.push(`rounds: ${state.aggregator.rounds}`)
    return lines.join("\n")
  }, [state])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const yamlStr = generateYaml()
      const result = await validateWorkflow(workspaceId, yamlStr)
      if (!result.valid) {
        toast.error(`校验失败: ${result.errors.map((e) => e.message).join(", ")}`)
        return
      }
      onSave?.(state)
      toast.success("节点配置已保存")
    } catch (err) {
      toast.error(`保存失败: ${err instanceof Error ? err.message : "未知错误"}`)
    } finally {
      setSaving(false)
    }
  }, [workspaceId, state, generateYaml, onSave])

  const handleImport = useCallback((parsed: Record<string, unknown>) => {
    const experts = ((parsed.experts as Array<Record<string, string>>) ?? []).map((e) => ({
      id: nextExpertId(),
      role: e.role ?? "",
      model: e.model ?? "",
      prompt: e.prompt ?? "",
    }))
    const agg = parsed.aggregator as Record<string, string> | undefined
    dispatch({
      type: "import_config",
      config: {
        mode: "moa",
        experts,
        aggregator: {
          model: agg?.model ?? "",
          prompt: agg?.prompt ?? "",
          rounds: typeof parsed.rounds === "number" ? parsed.rounds : 1,
        },
      },
    })
  }, [])

  return (
    <div className="flex flex-col h-full" role="dialog" aria-label="MOA 节点配置">
      <ScrollArea className="flex-1">
        <div className="space-y-4 p-1">
          {/* Expert list */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">Experts ({state.experts.length})</Label>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => dispatch({ type: "add_expert" })}
                className="gap-1 h-7"
              >
                <Plus className="h-3.5 w-3.5" />
                添加 Expert
              </Button>
            </div>

            {state.experts.length === 0 && (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                点击「添加 Expert」开始配置 MOA 专家
              </div>
            )}

            {state.experts.map((expert, index) => (
              <div
                key={expert.id}
                className="rounded-lg border border-border p-3 space-y-2"
                role="listitem"
                aria-label={`Expert: ${expert.role || `#${index + 1}`}`}
              >
                <div className="flex items-center gap-2">
                  <ExpertAvatar role={expert.role || "expert"} size="sm" status="pending" />
                  <Input
                    placeholder="角色名 (e.g. security)"
                    value={expert.role}
                    onChange={(e) =>
                      dispatch({ type: "update_expert", id: expert.id, field: "role", value: e.target.value })
                    }
                    className={cn(
                      "flex-1 h-8 text-sm",
                      duplicateRoles.includes(expert) && "border-destructive",
                    )}
                  />
                  <Select
                    value={expert.model}
                    onValueChange={(v) =>
                      dispatch({ type: "update_expert", id: expert.id, field: "model", value: v })
                    }
                  >
                    <SelectTrigger className="w-[180px] h-8">
                      <SelectValue placeholder="选择模型" />
                    </SelectTrigger>
                    <SelectContent>
                      {modelOptions.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <ModelResolveBadge
                    modelId={expert.model}
                    providerType={providerType}
                    tierMap={tierMap}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => dispatch({ type: "remove_expert", id: expert.id })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <Textarea
                  placeholder="Expert prompt..."
                  value={expert.prompt}
                  onChange={(e) =>
                    dispatch({ type: "update_expert", id: expert.id, field: "prompt", value: e.target.value })
                  }
                  className="text-sm min-h-[60px] resize-y"
                  rows={2}
                />
              </div>
            ))}
          </div>

          <Separator />

          {/* Aggregator */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold text-moa-aggregator">Aggregator</Label>
            <div className="rounded-lg border border-moa-aggregator/30 bg-moa-aggregator-light p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Select
                  value={state.aggregator.model}
                  onValueChange={(v) =>
                    dispatch({ type: "update_aggregator", field: "model", value: v })
                  }
                >
                  <SelectTrigger className="w-[180px] h-8">
                    <SelectValue placeholder="选择模型" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ModelResolveBadge
                  modelId={state.aggregator.model}
                  providerType={providerType}
                  tierMap={tierMap}
                />
                <div className="flex items-center gap-1.5 ml-auto">
                  <Label className="text-xs text-muted-foreground">Rounds</Label>
                  <Input
                    type="number"
                    min={0}
                    max={5}
                    value={state.aggregator.rounds}
                    onChange={(e) => {
                      const v = Math.max(0, Math.min(5, parseInt(e.target.value) || 0))
                      dispatch({ type: "update_aggregator", field: "rounds", value: v })
                    }}
                    className="w-16 h-8 text-center"
                  />
                </div>
              </div>
              <Textarea
                placeholder="Aggregator prompt (聚合指令)..."
                value={state.aggregator.prompt}
                onChange={(e) =>
                  dispatch({ type: "update_aggregator", field: "prompt", value: e.target.value })
                }
                className="text-sm min-h-[60px] resize-y"
                rows={2}
              />
            </div>
          </div>
        </div>
      </ScrollArea>

      {/* Validation messages */}
      {state.experts.length > 0 && state.experts.length < 2 && (
        <p className="text-xs text-destructive mt-2 px-1">MOA 模式至少需要 2 个 Expert</p>
      )}
      {duplicateRoles.length > 0 && (
        <p className="text-xs text-destructive mt-1 px-1">
          Expert role 重复: {duplicateRoles.map((e) => e.role).join(", ")}
        </p>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-3 border-t">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={() => { setYamlModalMode("import"); setYamlModalOpen(true) }}
          >
            <Upload className="h-3.5 w-3.5" />
            导入 YAML
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            onClick={() => { setYamlModalMode("export"); setYamlModalOpen(true) }}
          >
            <Download className="h-3.5 w-3.5" />
            导出 YAML
          </Button>
        </div>
        <div className="flex gap-2">
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>
          )}
          <Button size="sm" disabled={!canSave || saving} onClick={handleSave}>
            {saving ? "保存中..." : "保存"}
          </Button>
        </div>
      </div>

      <YamlSyncModal
        open={yamlModalOpen}
        onOpenChange={setYamlModalOpen}
        mode={yamlModalMode}
        yamlContent={generateYaml()}
        onImport={handleImport}
      />
    </div>
  )
}
