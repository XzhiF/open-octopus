import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Agent - Octopus',
  description: 'AI Agent 管理面板：对话、记忆、SKILL、分身、任务、配置',
}

export default function AgentRootLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
