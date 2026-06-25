import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "调度管理 - Octopus",
  description: "管理定时调度任务、Workflow 和 Agent 的自动化执行",
}

export default function SchedulerLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
