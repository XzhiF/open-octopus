import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "知识中心 - Octopus",
  description: "全局编译型知识库 — 浏览 · 检索 · 健康条（与策展人对话属票12）",
}

export default function KnowledgeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
