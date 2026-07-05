"use client"

import { useCallback, useRef, useEffect, useState } from "react"
import { Input } from "@/components/ui/input"
import { Search as SearchIcon } from "lucide-react"

interface ResourceSearchProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  debounceMs?: number
}

export function ResourceSearch({
  value,
  onChange,
  placeholder = "搜索资源...",
  debounceMs = 300,
}: ResourceSearchProps) {
  const [localValue, setLocalValue] = useState(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync external value changes
  useEffect(() => {
    setLocalValue(value)
  }, [value])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value
      setLocalValue(newValue)

      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        onChange(newValue)
      }, debounceMs)
    },
    [onChange, debounceMs]
  )

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return (
    <div className="relative w-full sm:w-64">
      <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
      <Input
        placeholder={placeholder}
        className="pl-8"
        value={localValue}
        onChange={handleChange}
        aria-label="搜索资源"
      />
    </div>
  )
}
