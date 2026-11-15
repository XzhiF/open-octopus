'use client'

// 对话首页内容。既被 / 页面直接渲染（测试/直链），也被 AppShell 的应用级
// 常驻实例渲染；后者保证离开对话页时 ChatTab 不卸载、SSE 不断。
//
// AI-native：所有 agent 活动都从这里的统一会话开始 —— 任务草稿也由
// 「新建任务」的 task-author 会话创建，不再挂独立弹窗。
//
// 2026-11-13：作战舱收进桌面壳（按 index.html 原型）。同一块对话区在三种
// 上下文间切换，不改路由：
//   · 普通对话（ChatTab，左栏含「作战舱」三段 + 新建舱草稿行）
//   · 新建作战舱（ChatTab 内的 CabinCreateHero —— 大输入框 + 她取名）
//   · 舱内对话（CabinDesktopHost：同一套 CabinProvider/ChatHost，桌面顶栏保留）
// /cabin/:id 仍由 AppShell 的兄弟壳承接，作为深链兜底。

import { ChatTab, type ChatTabCabinBridge } from '@/components/agent/chat/ChatTab'
import { CabinDesktopHost } from '@/components/cabin/CabinDesktopHost'
import { useCabinMode, type CabinModeValue } from '@/components/cabin/cabin-mode'
import { useCabins } from '@/hooks/use-cabins'
import { useCabinRowActions } from '@/hooks/use-cabin-row-actions'

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
  const { cabins, refresh } = useCabins()
  // 舱行「⋯」：重命名 / 删除（跟任务行同一套；桌面这边没有「当前舱」要收尾）。
  const { renameCabin, deleteCabinRow } = useCabinRowActions({ refresh })
  const bridge: ChatTabCabinBridge = {
    cabins,
    draft: mode.draft,
    draftOpen: mode.draftOpen,
    onSelectCabin: mode.openCabin,
    onCreateCabin: mode.startDraft,
    onUpdateDraft: mode.updateDraft,
    onCloseDraft: mode.closeDraft,
    onCancelDraft: mode.cancelDraft,
    onRenameCabin: renameCabin,
    onDeleteCabin: deleteCabinRow,
    // 建好 / 打开已有舱 → 草稿行换成正式舱行（草稿被消费掉），并立刻刷新左栏。
    onCabinCreated: (id) => {
      mode.cancelDraft()
      mode.openCabin(id)
      void refresh()
    },
  }
  return <ChatTab cabinBridge={bridge} />
}
