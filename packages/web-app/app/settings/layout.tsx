"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { X } from "lucide-react"
import { SettingsSidebar } from "@/components/settings/settings-sidebar"

interface SettingsTab {
  id: string
  label: string
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const [activeMenuItem, setActiveMenuItem] = useState("log-analysis")
  const [tabs, setTabs] = useState<SettingsTab[]>([
    { id: "log-analysis", label: "日志分析" },
  ])
  const [activeTabId, setActiveTabId] = useState("log-analysis")

  const handleMenuItemClick = (menuId: string) => {
    const existing = tabs.find(t => t.id === menuId)
    if (!existing) {
      setTabs(prev => [...prev, { id: menuId, label: "日志分析" }])
    }
    setActiveMenuItem(menuId)
    setActiveTabId(menuId)
  }

  const handleTabClick = (tabId: string) => {
    setActiveTabId(tabId)
    setActiveMenuItem(tabId)
  }

  const handleCloseTab = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (tabs.length <= 1) return
    const newTabs = tabs.filter(t => t.id !== tabId)
    setTabs(newTabs)
    if (activeTabId === tabId) {
      const idx = tabs.findIndex(t => t.id === tabId)
      const newActive = newTabs[Math.max(0, idx - 1)]
      setActiveTabId(newActive.id)
      setActiveMenuItem(newActive.id)
    }
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
      {/* Left: Sidebar menu */}
      <SettingsSidebar activeItem={activeMenuItem} onItemClick={handleMenuItemClick} />

      {/* Right: Multi-tab content area */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Tab bar */}
        {tabs.length > 0 && (
          <div className="flex items-center border-b border-border bg-background shrink-0 px-2">
            <div className="flex flex-1 overflow-x-auto">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 text-sm border-b-2 transition-colors whitespace-nowrap shrink-0",
                    activeTabId === tab.id
                      ? "border-primary text-primary font-medium bg-muted/50"
                      : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/30"
                  )}
                  onClick={() => handleTabClick(tab.id)}
                >
                  <span>{tab.label}</span>
                  {tabs.length > 1 && (
                    <span
                      className="ml-1 rounded p-0.5 hover:bg-muted"
                      onClick={(e) => handleCloseTab(tab.id, e)}
                    >
                      <X className="h-3 w-3" />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Tab content */}
        <div className="flex-1 overflow-hidden">
          {children}
        </div>
      </div>
    </div>
  )
}
