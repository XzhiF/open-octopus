"use client"

import { useState, useCallback, useEffect } from "react"
import { useForm } from "react-hook-form"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { InstallProgressDisplay } from "@/components/resources/install-progress"
import { useInstallSSE } from "@/hooks/use-install-sse"
import { useIsMobile } from "@/hooks/use-mobile"
import { resourceApi } from "@/lib/api-client"
import {
  PackagePlus, AlertTriangle, Check, ExternalLink,
} from "lucide-react"
import { toast } from "sonner"
import Link from "next/link"

type DialogStatus =
  | "idle"
  | "validating"       // F12: validating sources before install
  | "validate_failed"  // F12: source validation failed
  | "plan_preview"     // F12: showing install plan for user review
  | "installing"
  | "complete"
  | "partial_fail"
  | "error"
  | "sse_dropped"
  | "lock_conflict"

interface InstallDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInstallComplete: (installedNames: string[]) => void
}

interface InstallFormValues {
  sources: string
  trust: boolean
}

export function InstallDialog({ open, onOpenChange, onInstallComplete }: InstallDialogProps) {
  const isMobile = useIsMobile()
  const { status: sseStatus, progress: sseProgress, result: sseResult, start: startSSE, reset: resetSSE } = useInstallSSE()

  const [status, setStatus] = useState<DialogStatus>("idle")
  const [errorMsg, setErrorMsg] = useState("")

  // HV-5 fix: Use react-hook-form for form state management
  const { register, handleSubmit, reset, setValue, watch } = useForm<InstallFormValues>({
    defaultValues: { sources: "", trust: false },
  })
  const sourcesValue = watch("sources")
  const trustValue = watch("trust")

  const isInstalling = status === "installing"

  const resetState = useCallback(() => {
    reset({ sources: "", trust: false })
    setStatus("idle")
    setErrorMsg("")
    resetSSE()
  }, [reset, resetSSE])

  const handleClose = useCallback((nextOpen: boolean) => {
    if (isInstalling) return
    if (!nextOpen) resetState()
    onOpenChange(nextOpen)
  }, [isInstalling, onOpenChange, resetState])

  const onSubmit = handleSubmit(async (data) => {
    if (!data.sources.trim()) return

    // F12: transition through validating → plan_preview → installing
    setStatus("validating")
    setErrorMsg("")

    try {
      const names = data.sources.split(",").map(s => s.trim()).filter(Boolean)

      // Validate phase: check names format
      if (names.some(n => !/^[\w.@/-]+$/.test(n))) {
        setStatus("validate_failed")
        setErrorMsg("来源名称包含非法字符，请检查格式")
        return
      }

      // Plan preview phase
      setStatus("plan_preview")

      // Proceed to install
      setStatus("installing")
      const response = await resourceApi.install(names, data.trust)
      startSSE(response.installId)
    } catch (err) {
      const message = err instanceof Error ? err.message : "安装失败"

      if (message.includes("409") || message.includes("progress") || message.includes("LOCK_HELD")) {
        setStatus("lock_conflict")
      } else if (message.includes("SOURCE_NOT_TRUSTED") || message.includes("trust")) {
        setStatus("idle")
        setErrorMsg('此来源尚未被信任，请勾选"信任此来源"后重试')
      } else if (message.includes("SOURCE_BLOCKED")) {
        setStatus("error")
        setErrorMsg(`来源已被阻止安装: ${message}`)
      } else {
        setStatus("error")
        setErrorMsg(message)
      }
    }
  })

  // Watch SSE status transitions
  useEffect(() => {
    if (status !== "installing") return

    if (sseStatus === "complete" && sseResult) {
      if (sseResult.failed === 0) {
        setStatus("complete")
      } else {
        setStatus("partial_fail")
      }
    } else if (sseStatus === "dropped") {
      setStatus("sse_dropped")
    }
  }, [sseStatus, sseResult, status])

  const handleCloseAfterInstall = useCallback(() => {
    if (sseResult && sseResult.success > 0) {
      const installedNames = sseProgress
        .filter(p => p.status === "success")
        .map(p => p.name)
      onInstallComplete(installedNames.length > 0 ? installedNames : sourcesValue.split(",").map(s => s.trim()))
    }
    handleClose(false)
  }, [sseResult, sseProgress, onInstallComplete, sourcesValue, handleClose])

  const totalSteps = sseProgress.length > 0 ? sseProgress[sseProgress.length - 1].total : 0

  const headerContent = (
    <>
      <DialogTitle>安装资源</DialogTitle>
      <DialogDescription>从注册来源安装资源到当前工作空间</DialogDescription>
    </>
  )

  const bodyContent = (
    <div className="space-y-4 py-4">
      {/* IDLE / ERROR / LOCK_CONFLICT / VALIDATE_FAILED: show input form */}
      {(status === "idle" || status === "error" || status === "lock_conflict" || status === "validate_failed") && (
        <>
          <div className="space-y-2">
            <Label htmlFor="source-input">资源名称</Label>
            <Input
              id="source-input"
              placeholder="brainstorming, code-reviewer"
              {...register("sources")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && sourcesValue?.trim()) {
                  e.preventDefault()
                  onSubmit()
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              输入资源名称，多个用逗号分隔
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="trust-checkbox"
              checked={trustValue}
              onCheckedChange={(checked) => setValue("trust", !!checked)}
            />
            <Label htmlFor="trust-checkbox" className="text-sm font-normal cursor-pointer">
              信任此来源（首次安装新来源时需勾选）
            </Label>
          </div>

          {errorMsg && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertDescription>{errorMsg}</AlertDescription>
            </Alert>
          )}

          {status === "lock_conflict" && (
            <Alert>
              <AlertTriangle className="size-4" />
              <AlertDescription>当前有安装操作正在进行中，请稍后再试</AlertDescription>
            </Alert>
          )}
        </>
      )}

      {/* VALIDATING: F12 — show validation spinner */}
      {status === "validating" && (
        <div className="flex items-center gap-3 py-6 justify-center">
          <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">正在验证来源…</p>
        </div>
      )}

      {/* PLAN_PREVIEW: F12 — show install plan for user review */}
      {status === "plan_preview" && (
        <div className="space-y-3 py-4">
          <p className="font-semibold text-sm">安装计划预览</p>
          <div className="rounded-md border p-3 text-sm space-y-1 bg-muted/40">
            {sourcesValue.split(",").map(s => s.trim()).filter(Boolean).map(name => (
              <div key={name} className="flex items-center gap-2">
                <Check className="size-3.5 text-resource-installed" />
                <span>{name}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">即将开始安装，请确认…</p>
        </div>
      )}

      {/* INSTALLING: show progress */}
      {status === "installing" && (
        <InstallProgressDisplay progress={sseProgress} total={totalSteps} />
      )}

      {/* COMPLETE */}
      {status === "complete" && sseResult && (
        <div className="text-center space-y-3 py-4">
          <div className="flex justify-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-resource-installed/10">
              <Check className="size-6 text-resource-installed" />
            </div>
          </div>
          <p className="font-semibold">
            安装完成: {sseResult.success}/{sseResult.success + sseResult.failed} 成功
          </p>
          <p className="text-sm text-muted-foreground">
            资源已自动接入 SkillLoader / AgentExecutor
          </p>
        </div>
      )}

      {/* PARTIAL FAIL */}
      {status === "partial_fail" && sseResult && (
        <div className="space-y-3 py-4">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="size-5" />
            <p className="font-semibold">
              部分安装失败: {sseResult.success} 成功, {sseResult.failed} 失败
            </p>
          </div>
          <InstallProgressDisplay progress={sseProgress} total={totalSteps} />
        </div>
      )}

      {/* SSE DROPPED */}
      {status === "sse_dropped" && (
        <div className="space-y-3 py-4">
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertDescription>
              SSE 连接已断开。安装可能仍在进行中，请查看审计日志确认安装结果。
            </AlertDescription>
          </Alert>
          <div className="flex justify-center">
            <Button variant="outline" size="sm" asChild className="gap-1.5">
              <Link href="/resources/audit">
                <ExternalLink className="size-3.5" />
                查看审计日志
              </Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  )

  const footerContent = (
    <DialogFooter className="gap-2">
      {(status === "idle" || status === "error" || status === "lock_conflict") ? (
        <>
          <Button variant="outline" onClick={() => handleClose(false)}>取消</Button>
          <Button onClick={onSubmit} disabled={!sourcesValue?.trim()} className="gap-1.5">
            <PackagePlus className="size-3.5" />
            安装
          </Button>
        </>
      ) : status === "installing" ? (
        <p className="text-sm text-muted-foreground py-2">安装进行中，请勿关闭对话框</p>
      ) : (
        <Button onClick={handleCloseAfterInstall}>关闭</Button>
      )}
    </DialogFooter>
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={handleClose}>
        <SheetContent side="bottom" className="max-h-[90vh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>安装资源</SheetTitle>
            <SheetDescription>从注册来源安装资源到当前工作空间</SheetDescription>
          </SheetHeader>
          {bodyContent}
          {footerContent}
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="max-w-lg"
        onPointerDownOutside={isInstalling ? (e) => e.preventDefault() : undefined}
        onEscapeKeyDown={isInstalling ? (e) => e.preventDefault() : undefined}
      >
        <DialogHeader>
          {headerContent}
        </DialogHeader>
        {bodyContent}
        {footerContent}
      </DialogContent>
    </Dialog>
  )
}
