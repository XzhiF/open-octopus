"use client"

import { useCallback, useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

const MIN_ROWS = 1
const MAX_ROWS = 4
const LINE_HEIGHT = 24

interface AutoResizeTextareaProps extends Omit<React.ComponentProps<"textarea">, "rows"> {
  /** 静止高度（默认 1 行）：输入框空着也占 minRows 行，避免单行框一打字就跳高。 */
  minRows?: number
  maxRows?: number
}

export function AutoResizeTextarea({
  className,
  value,
  minRows = MIN_ROWS,
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
    const minHeight = minRows * LINE_HEIGHT + padY
    const maxHeight = maxRows * LINE_HEIGHT + padY
    // 空框恒占 minRows 行（v21 四轮）：窄窗里 placeholder 折行会被 Chromium
    // 算进 scrollHeight，把「默认一行」的输入框撑成两行。高度只认真实内容。
    const empty = el.value.length === 0
    const newHeight = empty
      ? minHeight
      : Math.min(Math.max(el.scrollHeight, minHeight), maxHeight)
    el.style.height = `${newHeight}px`
    el.style.overflowY = !empty && el.scrollHeight > maxHeight ? "auto" : "hidden"
  }, [minRows, maxRows])

  // Adjust on mount and whenever value changes
  useEffect(() => {
    adjustHeight()
  }, [adjustHeight, value])

  // 宽度变化重新量一次（v21 四轮）：通讯台首帧几何未落定（窗宽 ~190px）时
  // 占位文案会折行，Chromium 把折行高度算进 scrollHeight → 框被撑成两行且
  // 只有下次输入才回缩。宽度一稳就重算，静止高度回到 minRows 行。
  // 只认宽度变化：adjustHeight 改的是高度，不会自激。
  const lastWidthRef = useRef(-1)
  useEffect(() => {
    const el = textareaRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth
      if (width === lastWidthRef.current) return
      lastWidthRef.current = width
      adjustHeight()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [adjustHeight])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    adjustHeight()
    props.onChange?.(e)
  }, [adjustHeight, props.onChange])

  return (
    <textarea
      ref={textareaRef}
      rows={minRows}
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