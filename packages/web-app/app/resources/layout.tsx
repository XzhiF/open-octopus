import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "资源管理 - Octopus",
  description: "管理 skill、agent 和 workflow 资源的安装、卸载、漂移检测与审计",
}

export default function ResourcesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
