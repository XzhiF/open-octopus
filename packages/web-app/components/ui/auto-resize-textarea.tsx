"use client"

import { useCallback, useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

const MAX_ROWS = 4
const LINE_HEIGHT = 24

interface AutoResizeTextareaProps extends Omit<React.ComponentProps<"textarea">, "rows"> {
  maxRows?: number
}

export function AutoResizeTextarea({
  className,
  value,
  maxRows = MAX_ROWS,
  ...props
}: AutoResizeTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    // 行高上限要算上垂直 padding（scrollHeight 含 padding）—— 否则「3 行」
    // 实际只露出 ~2.5 行就开始内滚。
    const cs = getComputedStyle(el)
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    const maxHeight = maxRows * LINE_HEIGHT + padY
    const newHeight = Math.min(el.scrollHeight, maxHeight)
    el.style.height = `${newHeight}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden"
  }, [maxRows])

  // Adjust on mount and whenever value changes
  useEffect(() => {
    adjustHeight()
  }, [adjustHeight, value])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    adjustHeight()
    props.onChange?.(e)
  }, [adjustHeight, props.onChange])

  return (
    <textarea
      ref={textareaRef}
      rows={1}
      value={value}
      onChange={handleInput}
      className={cn(
        "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50",
        "flex w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs",
        "transition-[color,box-shadow,height] outline-none focus-visible:ring-[3px]",
        "resize-none overflow-hidden",
        className,
      )}
      style={{ lineHeight: `${LINE_HEIGHT}px`, height: "auto" }}
      {...props}
    />
  )
}