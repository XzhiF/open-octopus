"use client"

import Link from "@/lib/app-navigation"
import { Button } from "@/components/ui/button"
import { Activity, Bell, Menu } from "lucide-react"

interface HeaderProps {
  onOpenNav?: () => void
}

export function Header({ onOpenNav }: HeaderProps) {
  return (
    <header className="z-50 w-full shrink-0 border-b-[1.5px] border-pop-bd bg-pop-paper">
      <div className="flex h-14 items-center px-4 lg:px-6">
        <Button
          variant="ghost"
          size="icon"
          className="mr-1 md:hidden"
          onClick={onOpenNav}
          aria-label="打开导航"
        >
          <Menu className="h-5 w-5" />
        </Button>

        {/* Logo — 赤陶贴纸 */}
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border-[1.5px] border-pop-bd bg-pop-pink text-pop-bg shadow-pop-sm">
            <Activity className="h-4 w-4" />
          </div>
          <span className="font-black text-lg tracking-tight text-pop-ink">Octopus</span>
        </Link>

        <div className="flex-1" />

        {/* Notifications — settings entry lives in the left rail */}
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="relative">
            <Bell className="h-4 w-4" />
            <span className="sr-only">通知</span>
          </Button>
        </div>
      </div>
    </header>
  )
}
