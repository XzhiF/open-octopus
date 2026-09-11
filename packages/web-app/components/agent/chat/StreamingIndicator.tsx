'use client'

import { useState, useEffect } from 'react'

export function StreamingIndicator() {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setSeconds(s => s + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="flex items-center gap-2 text-sm font-bold text-pop-dim" role="status" aria-live="polite">
      <div className="flex gap-1">
        <span className="h-2 w-2 rounded-full border-[1.5px] border-pop-bd bg-pop-pink pop-jump" style={{ animationDelay: '0ms' }} />
        <span className="h-2 w-2 rounded-full border-[1.5px] border-pop-bd bg-pop-purple pop-jump" style={{ animationDelay: '150ms' }} />
        <span className="h-2 w-2 rounded-full border-[1.5px] border-pop-bd bg-pop-cyan pop-jump" style={{ animationDelay: '300ms' }} />
      </div>
      <span>Agent 思考中{seconds > 0 ? ` · ${seconds}s` : '...'}</span>
    </div>
  )
}
