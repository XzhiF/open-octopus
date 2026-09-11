'use client'

import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { cn } from '@/lib/utils'

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        // 🎪 墨边轨道:开=绿贴纸,关=idle 灰
        'peer data-[state=checked]:bg-pop-green data-[state=unchecked]:bg-pop-idle focus-visible:ring-pop-pink/50 inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-pop-bd shadow-pop-sm transition-all outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="bg-card border border-pop-bd pointer-events-none block size-3.5 rounded-full ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%+2px)] data-[state=unchecked]:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
