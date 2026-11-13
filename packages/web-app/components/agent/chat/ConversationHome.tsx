'use client'

// 对话首页内容。既被 / 页面直接渲染（测试/直链），也被 AppShell 的应用级
// 常驻实例渲染；后者保证离开对话页时 ChatTab 不卸载、SSE 不断。
//
// AI-native：所有 agent 活动都从这里的统一会话开始 —— 任务草稿也由
// 「新建任务」的 task-author 会话创建，不再挂独立弹窗。
//
// 2026-11-13：工作舱收进桌面壳（按 index.html 原型）。同一块对话区在三种
// 上下文间切换，不改路由：
//   · 普通对话（ChatTab，左栏含「工作舱」三段 + pendingCabin hero）
//   · 新建工作舱（ChatTab 内的 CabinDraftPane）
//   · 舱内对话（CabinDesktopHost：同一套 CabinProvider/ChatHost，桌面顶栏保留）
// /cabin/:id 仍由 AppShell 的兄弟壳承接，作为深链兜底。

import { ChatTab, type ChatTabCabinBridge } from '@/components/agent/chat/ChatTab'
import { CabinDesktopHost } from '@/components/cabin/CabinDesktopHost'
import { useCabinMode, type CabinModeValue } from '@/components/cabin/cabin-mode'
import { useCabins } from '@/hooks/use-cabins'

export function ConversationHome() {
  const mode = useCabinMode()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {mode.activeCabinId ? (
          <CabinDesktopHost
            key={mode.activeCabinId}
            cabinId={mode.activeCabinId}
            onExit={mode.exitCabin}
            onSelectCabin={mode.openCabin}
            onCreateCabin={mode.startDraft}
          />
        ) : (
          <DesktopChat mode={mode} />
        )}
      </div>
    </div>
  )
}

function DesktopChat({ mode }: { mode: CabinModeValue }) {
  const { cabins } = useCabins()
  const bridge: ChatTabCabinBridge = {
    cabins,
    drafting: mode.drafting,
    onSelectCabin: mode.openCabin,
    onCreateCabin: mode.startDraft,
    onCancelDraft: mode.cancelDraft,
    onCabinCreated: mode.openCabin,
  }
  return <ChatTab cabinBridge={bridge} />
}
