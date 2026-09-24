'use client'

import { useTheme } from 'next-themes'
import { Toaster as Sonner, ToasterProps } from 'sonner'

const Toaster = ({ ...props }: ToasterProps) => {
  // 全站暗黑 TUI：无 ThemeProvider 时 useTheme 返回 undefined，兜底 'dark'
  // 使 richColors 成功/错误 toast 走 sonner 深色底，而非跟随 OS 浅色。
  const { theme = 'dark' } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--pop-paper)',
          '--normal-text': 'var(--pop-ink)',
          '--normal-border': 'var(--pop-bd)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
