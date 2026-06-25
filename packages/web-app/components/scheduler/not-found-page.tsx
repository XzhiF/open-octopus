"use client"

import Link from "next/link"
import { FileX } from "lucide-react"
import { Button } from "@/components/ui/button"

export function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <FileX className="size-16 text-muted-foreground/50" />
      <h2 className="text-xl font-semibold">该调度任务不存在或已被删除</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        请检查链接是否正确，或该任务已被其他用户删除。
      </p>
      <Button asChild variant="outline" className="mt-2">
        <Link href="/scheduler">返回调度列表</Link>
      </Button>
    </div>
  )
}
