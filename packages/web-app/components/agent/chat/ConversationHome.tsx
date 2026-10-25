'use client'

// 对话首页内容。既被 / 页面直接渲染（测试/直链），也被 AppShell 的应用级
// 常驻实例渲染；后者保证离开对话页时 ChatTab 不卸载、SSE 不断。
//
// AI-native：所有 agent 活动都从这里的统一会话开始 —— 任务草稿也由
// 「新建任务」的 task-author 会话创建，不再挂独立弹窗。

import { ChatTab } from '@/components/agent/chat/ChatTab'

export function ConversationHome() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <ChatTab />
      </div>
    </div>
  )
}
