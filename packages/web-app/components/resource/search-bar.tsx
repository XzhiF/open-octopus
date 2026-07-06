"use client"

import { useState, useEffect, useRef } from "react"
import { Search, X } from "lucide-react"
import { Input } from "@/components/ui/input"

interface SearchBarProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

export function SearchBar({ value, onChange, placeholder = "搜索资源..." }: SearchBarProps) {
  const [local, setLocal] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync external value changes (e.g., URL param changes)
  useEffect(() => { setLocal(value) }, [value])

  // Debounce: 300ms
  useEffect(() => {
    const id = setTimeout(() => {
      if (local !== value) onChange(local)
    }, 300)
    return () => clearTimeout(id)
  }, [local, value, onChange])

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={placeholder}
        className="pl-9 pr-9"
        aria-label="搜索资源"
      />
      {local && (
        <button
          onClick={() => { setLocal(""); onChange("") }}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label="清除搜索"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
