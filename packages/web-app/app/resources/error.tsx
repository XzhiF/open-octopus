"use client"

import { useEffect } from "react"

export default function ResourceError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[resource-error]", error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16">
      <h2 className="text-lg font-semibold">资源页面加载失败</h2>
      <p className="text-sm text-muted-foreground max-w-md text-center">
        {error.message || "加载资源时发生了未知错误，请重试。"}
      </p>
      <button
        onClick={reset}
        className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
      >
        重试
      </button>
    </div>
  )
}
