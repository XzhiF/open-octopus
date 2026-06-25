"use client"

import type { Control } from "react-hook-form"
import dynamic from "next/dynamic"
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { cn } from "@/lib/utils"

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex h-32 items-center justify-center rounded-md border bg-muted text-sm text-muted-foreground">
      加载编辑器...
    </div>
  ),
})

const DEFAULT_WORKFLOW_CONFIG = JSON.stringify(
  {
    schema_version: "2.0",
    type: "workflow",
    workspace_spec: {
      org: "your-org",
      projects: [
        {
          name: "project-name",
          source_path: "/path/to/repo",
          branch_prefix: "sched-project",
        },
      ],
    },
    workflow_chain: [
      {
        workflow_ref: "workflow.yaml",
        input_values: {},
      },
    ],
    max_retain: 10,
  },
  null,
  2
)

interface WorkflowFieldsProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control: Control<any>
  submitting: boolean
  configError?: string | null
  configValue: string
  onConfigChange: (value: string) => void
}

export function WorkflowFields({
  control,
  submitting,
  configError,
  configValue,
  onConfigChange,
}: WorkflowFieldsProps) {
  return (
    <>
      <FormField
        control={control}
        name="org"
        render={({ field }) => (
          <FormItem>
            <FormLabel>组织</FormLabel>
            <FormControl>
              <Input
                placeholder="例如: xzf"
                disabled={submitting}
                {...field}
              />
            </FormControl>
            <FormDescription>调度任务所属组织</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="space-y-2">
        <Label>工作流配置 (v2.0)</Label>
        <div
          className={cn(
            "overflow-hidden rounded-md border",
            configError && "border-destructive"
          )}
        >
          <MonacoEditor
            height="320px"
            language="json"
            theme="vs-dark"
            value={configValue || DEFAULT_WORKFLOW_CONFIG}
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
        {configError && (
          <p className="text-sm text-destructive">{configError}</p>
        )}
        <p className="text-xs text-muted-foreground">
          workspace_spec: 项目和分支前缀 | workflow_chain: 工作流链（依次执行）| max_retain: 最大保留空间数量
        </p>
      </div>

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
                      <Label htmlFor={`pp-${opt.value}`} className="cursor-pointer text-sm">
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
    </>
  )
}
