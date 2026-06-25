"use client"

import { useState, useEffect } from "react"
import dynamic from "next/dynamic"
import type { Control } from "react-hook-form"
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
  FormDescription,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { listOrgs } from "@/lib/api-client"
import {
  ProjectSelector,
  type SelectedProject,
} from "./project-selector"
import {
  WorkflowChainDialog,
  ChainSummary,
  type ChainStep,
} from "./workflow-chain-dialog"

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex h-32 items-center justify-center rounded-md border bg-muted text-sm text-muted-foreground">
      加载编辑器...
    </div>
  ),
})

interface WorkflowScheduleFormProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control: Control<any>
  submitting: boolean
  // Visual mode state
  projects: SelectedProject[]
  onProjectsChange: (projects: SelectedProject[]) => void
  chain: ChainStep[]
  onChainChange: (chain: ChainStep[]) => void
  maxRetain: number
  onMaxRetainChange: (val: number) => void
  branchPrefix: string
  onBranchPrefixChange: (val: string) => void
  orgValue: string
  // JSON mode
  jsonMode: boolean
  onJsonModeToggle: () => void
  configValue: string
  onConfigChange: (val: string) => void
  configError?: string | null
}

export function WorkflowScheduleForm({
  control,
  submitting,
  projects,
  onProjectsChange,
  chain,
  onChainChange,
  maxRetain,
  onMaxRetainChange,
  branchPrefix,
  onBranchPrefixChange,
  orgValue,
  jsonMode,
  onJsonModeToggle,
  configValue,
  onConfigChange,
  configError,
}: WorkflowScheduleFormProps) {
  const [chainDialogOpen, setChainDialogOpen] = useState(false)
  const [orgs, setOrgs] = useState<Array<{ name: string }>>([])

  useEffect(() => {
    listOrgs().then((data) => setOrgs(data.map((o) => ({ name: o.name })))).catch(() => {})
  }, [])

  return (
    <div className="space-y-5">
      {/* Mode toggle */}
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">编辑模式</Label>
        <div className="flex gap-1 rounded-lg bg-muted p-0.5">
          <button
            type="button"
            className={cn(
              "rounded-md px-3 py-1 text-xs font-medium transition-colors",
              !jsonMode ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => jsonMode && onJsonModeToggle()}
          >
            可视化
          </button>
          <button
            type="button"
            className={cn(
              "rounded-md px-3 py-1 text-xs font-medium transition-colors",
              jsonMode ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => !jsonMode && onJsonModeToggle()}
          >
            JSON
          </button>
        </div>
      </div>

      {jsonMode ? (
        /* ── JSON Mode ── */
        <div className="space-y-2">
          <FormField
            control={control}
            name="org"
            render={({ field }) => (
              <FormItem>
                <FormLabel>组织</FormLabel>
                <FormControl>
                  <Input placeholder="例如: xzf" disabled={submitting} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="space-y-1.5">
            <Label>工作流配置 (v2.0 JSON)</Label>
            <div className={cn("overflow-hidden rounded-md border", configError && "border-destructive")}>
              <MonacoEditor
                height="300px"
                language="json"
                theme="vs-dark"
                value={configValue}
                onChange={(val) => onConfigChange(val ?? "")}
                options={{
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  fontSize: 13,
                  tabSize: 2,
                  wordWrap: "on",
                  formatOnPaste: true,
                }}
              />
            </div>
            {configError && <p className="text-sm text-destructive">{configError}</p>}
          </div>
        </div>
      ) : (
        /* ── Visual Mode ── */
        <>
          {/* Workspace Config */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">工作空间配置</Label>

            <FormField
              control={control}
              name="org"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>组织</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={submitting}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="选择组织" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {orgs.map((o) => (
                        <SelectItem key={o.name} value={o.name}>
                          {o.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>用于加载项目列表</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-1.5">
              <Label>
                分支前缀
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  工作空间名和所有项目分支均按此规则命名: {branchPrefix || "前缀"}-{"{时间戳}"}
                </span>
              </Label>
              <Input
                value={branchPrefix}
                onChange={(e) => onBranchPrefixChange(e.target.value)}
                placeholder="例如: sched-mytask"
                disabled={submitting}
              />
            </div>

            <div className="space-y-1.5">
              <Label>项目</Label>
              <ProjectSelector
                org={orgValue}
                value={projects}
                onChange={onProjectsChange}
                disabled={submitting}
              />
            </div>
          </div>

          <Separator />

          {/* Workflow Chain */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">工作流链</Label>
            <ChainSummary chain={chain} onOpen={() => setChainDialogOpen(true)} />
            <WorkflowChainDialog
              open={chainDialogOpen}
              onOpenChange={setChainDialogOpen}
              value={chain}
              onChange={onChainChange}
            />
          </div>

          <Separator />

          {/* Retention */}
          <div className="space-y-1.5">
            <Label>最大保留空间数量</Label>
            <Input
              type="number"
              min={1}
              max={100}
              value={maxRetain}
              onChange={(e) => onMaxRetainChange(Number(e.target.value) || 10)}
              disabled={submitting}
            />
            <p className="text-xs text-muted-foreground">
              超过此数量的已完成空间将被自动淘汰
            </p>
          </div>
        </>
      )}

      {/* Shared fields */}
      <Separator />

      <FormField
        control={control}
        name="parallel_policy"
        render={({ field }) => (
          <FormItem>
            <FormLabel>并发策略</FormLabel>
            <FormControl>
              <RadioGroup
                onValueChange={field.onChange}
                value={field.value}
                className="flex gap-4"
                disabled={submitting}
              >
                {[
                  { value: "skip", label: "跳过", desc: "有执行在运行时跳过" },
                  { value: "wait", label: "等待", desc: "等待当前执行完成" },
                  { value: "allow", label: "允许", desc: "允许多个执行并行" },
                ].map((opt) => (
                  <div key={opt.value} className="flex items-start gap-2">
                    <RadioGroupItem value={opt.value} id={`pp-${opt.value}`} />
                    <div>
                      <Label
                        htmlFor={`pp-${opt.value}`}
                        className="cursor-pointer text-sm"
                      >
                        {opt.label}
                      </Label>
                      <p className="text-xs text-muted-foreground">{opt.desc}</p>
                    </div>
                  </div>
                ))}
              </RadioGroup>
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  )
}
