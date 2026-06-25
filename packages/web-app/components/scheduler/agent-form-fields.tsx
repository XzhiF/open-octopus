"use client"

import type { Control } from "react-hook-form"
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface AgentFieldsProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control: Control<any>
  submitting: boolean
  promptValue: string
}

export function AgentFields({ control, submitting, promptValue }: AgentFieldsProps) {
  return (
    <>
      <FormField
        control={control}
        name="prompt"
        render={({ field }) => (
          <FormItem>
            <FormLabel className="flex items-center justify-between">
              <span>Prompt</span>
              <span className="text-xs font-normal text-muted-foreground">
                {(promptValue ?? "").length}/10000
              </span>
            </FormLabel>
            <FormControl>
              <Textarea
                {...field}
                placeholder="输入 Agent 执行的任务描述..."
                disabled={submitting}
                maxLength={10000}
                className="min-h-[120px]"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="grid grid-cols-3 gap-3">
        <FormField
          control={control}
          name="model"
          render={({ field }) => (
            <FormItem>
              <FormLabel>模型</FormLabel>
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={submitting}
              >
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="default">默认</SelectItem>
                  <SelectItem value="high-performance">高性能</SelectItem>
                  <SelectItem value="economical">经济</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="timeout"
          render={({ field }) => (
            <FormItem>
              <FormLabel>超时 (秒)</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  {...field}
                  min={10}
                  max={3600}
                  disabled={submitting}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name="retry_attempts"
          render={({ field }) => (
            <FormItem>
              <FormLabel>重试次数</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  {...field}
                  min={0}
                  max={5}
                  disabled={submitting}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </>
  )
}
