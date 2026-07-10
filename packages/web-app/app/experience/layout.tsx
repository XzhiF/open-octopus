import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '工作经验 - Octopus',
  description: '工作经验管理：用户偏好、经验库、审核队列',
}

export default function ExperienceLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
