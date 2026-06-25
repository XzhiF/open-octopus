"use client"

import { useState, useEffect } from "react"

export function useLiveTimer(startedAt: string | undefined | null): number | undefined {
  const [elapsedSeconds, setElapsedSeconds] = useState<number | undefined>(
    startedAt ? (Date.now() - new Date(startedAt).getTime()) / 1000 : undefined
  )

  useEffect(() => {
    if (!startedAt) {
      setElapsedSeconds(undefined)
      return
    }

    const compute = () => {
      setElapsedSeconds((Date.now() - new Date(startedAt).getTime()) / 1000)
    }

    compute()
    const interval = setInterval(compute, 1000)
    return () => clearInterval(interval)
  }, [startedAt])

  return elapsedSeconds
}