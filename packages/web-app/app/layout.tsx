import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Script from 'next/script'
import { AppShell } from '@/components/providers/app-shell'
import './globals.css'

export const metadata: Metadata = {
  title: 'Octopus - 工作流编排平台',
  description: 'Octopus CLI 可视化操作界面，支持工作流管理、执行监控和 AI 对话',
  generator: 'v0.app',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Force dynamic rendering so process.env is read at request time, not build time.
  // Without this, `next start` serves cached static HTML with the build-time fallback URL.
  await headers()

  // SERVER_URL (non-NEXT_PUBLIC_) is read at runtime by the Next.js server process.
  // Injected as window.__SERVER_URL__ before any client JS loads.
  // Set by dev.mjs / prod.mjs when starting the web-app.
  const serverUrl = process.env.SERVER_URL || 'http://localhost:3001'

  return (
    <html lang="zh-CN" className="bg-background">
      <head>
        <Script id="inject-server-url" strategy="beforeInteractive">
          {`window.__SERVER_URL__=${JSON.stringify(serverUrl)}`}
        </Script>
      </head>
      <body className="font-sans antialiased">
        <AppShell>
          <div className="relative flex min-h-screen flex-col">
            <main className="flex-1">{children}</main>
          </div>
        </AppShell>
      </body>
    </html>
  )
}