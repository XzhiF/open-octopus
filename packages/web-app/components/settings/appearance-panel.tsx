"use client"

// 设置 → 外观。第一项是作业坞（任务浮窗右侧竖栏）的文字标签开关：
// 默认在图标下方常驻显示；关掉后退回「只显示图标 + hover 提示」。
// 偏好存 localStorage，已打开的坞和别的标签页都会实时跟着切换。

import { LayoutGrid } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { useDockLabelsVisible } from "@/hooks/use-dock-labels"
import { setDockLabelsVisible } from "@/lib/ui-preferences"

export function AppearancePanel() {
  const dockLabels = useDockLabelsVisible()

  return (
    <div className="flex h-full flex-col" data-testid="appearance-panel">
      <div className="border-b border-border bg-background px-6 py-4">
        <h1 className="text-lg font-semibold tracking-tight">外观</h1>
        <p className="text-sm text-muted-foreground">界面显示与作业坞</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <section className="max-w-2xl" data-appearance-section="dock">
          <h2 className="mb-3 text-sm font-medium">作业坞</h2>

          <div className="flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3.5">
            <LayoutGrid className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <label
                htmlFor="dock-labels"
                className="block cursor-pointer text-sm font-medium"
              >
                图标下方常驻显示文字
              </label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                关闭后作业坞只显示图标，鼠标悬停时仍可看到名称。
              </p>
            </div>
            <Switch
              id="dock-labels"
              data-testid="dock-labels-switch"
              checked={dockLabels}
              onCheckedChange={setDockLabelsVisible}
              aria-label="图标下方常驻显示文字"
            />
          </div>
        </section>
      </div>
    </div>
  )
}
