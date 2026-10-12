import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '知识词条 - Octopus',
  description: 'LLM-WIKI 知识词条只读浏览：域树 / 词条渲染 / 全文检索 / 溯源',
}

export default function WikiLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
