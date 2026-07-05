"use client"

import { useState, useCallback } from "react"
import Link from "next/link"
import { useTrustSources } from "@/hooks/use-trust-sources"
import { TrustListSection } from "@/components/resources/trust-list-section"
import { AddTrustDialog } from "@/components/resources/add-trust-dialog"
import { AddBlockDialog } from "@/components/resources/add-block-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ArrowLeft, RotateCcw, Shield } from "lucide-react"
import { toast } from "sonner"

export function TrustPage() {
  const { trusted, blocked, loading, error, refetch, addTrust, removeTrust, addBlock, removeBlock } = useTrustSources()

  const [addTrustOpen, setAddTrustOpen] = useState(false)
  const [addBlockOpen, setAddBlockOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<{ type: "trust" | "block"; protocol: string; location: string } | null>(null)

  const handleRemoveConfirm = useCallback(async () => {
    if (!removeTarget) return
    const { type, protocol, location } = removeTarget
    setRemoveTarget(null)

    try {
      if (type === "trust") {
        await removeTrust(protocol, location)
        toast.success("已移除信任来源")
      } else {
        await removeBlock(protocol, location)
        toast.success("已移除阻止来源")
      }
    } catch {
      toast.error("移除失败")
    }
  }, [removeTarget, removeTrust, removeBlock])

  const handleAddTrust = useCallback(async (protocol: string, pkg: string) => {
    await addTrust(protocol, pkg)
    toast.success(`已添加信任来源 ${protocol}:${pkg}`)
  }, [addTrust])

  const handleAddBlock = useCallback(async (protocol: string, pkg: string, reason?: string) => {
    await addBlock(protocol, pkg, reason)
    toast.success(`已添加阻止来源 ${protocol}:${pkg}`)
  }, [addBlock])

  return (
    <div className="container mx-auto space-y-6 px-4 py-6 lg:px-6">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex items-center gap-2 mb-2">
          <Button variant="ghost" size="sm" asChild className="gap-1.5 -ml-2">
            <Link href="/resources">
              <ArrowLeft className="size-3.5" />
              资源管理
            </Link>
          </Button>
        </div>
        <h1 className="text-2xl font-bold tracking-tight">信任管理</h1>
        <p className="text-muted-foreground">管理资源来源的信任策略</p>
      </div>

      {/* Error */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center gap-2">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={refetch} className="gap-1.5 ml-auto">
              <RotateCcw className="size-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Loading */}
      {loading && (
        <div className="space-y-8">
          <div className="space-y-3">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-32 w-full" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-32 w-full" />
          </div>
        </div>
      )}

      {/* Content */}
      {!loading && !error && (
        <TrustListSection
          trusted={trusted}
          blocked={blocked}
          onAddTrust={() => setAddTrustOpen(true)}
          onAddBlock={() => setAddBlockOpen(true)}
          onRemoveTrust={(protocol, location) => setRemoveTarget({ type: "trust", protocol, location })}
          onRemoveBlock={(protocol, location) => setRemoveTarget({ type: "block", protocol, location })}
        />
      )}

      {/* Add trust dialog */}
      <AddTrustDialog
        open={addTrustOpen}
        onOpenChange={setAddTrustOpen}
        onConfirm={handleAddTrust}
      />

      {/* Add block dialog */}
      <AddBlockDialog
        open={addBlockOpen}
        onOpenChange={setAddBlockOpen}
        onConfirm={handleAddBlock}
      />

      {/* Remove confirmation */}
      <AlertDialog open={!!removeTarget} onOpenChange={(open) => { if (!open) setRemoveTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              确认移除{removeTarget?.type === "trust" ? "信任" : "阻止"}来源？
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget?.type === "trust" ? (
                <>
                  移除信任来源 <code className="text-foreground font-mono">{removeTarget?.protocol}:{removeTarget?.location}</code> 后，
                  从该来源安装资源时将重新触发信任确认。
                </>
              ) : (
                <>
                  移除阻止来源 <code className="text-foreground font-mono">{removeTarget?.protocol}:{removeTarget?.location}</code> 后，
                  该来源的资源将可以被注册和安装。
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemoveConfirm}>确认移除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
