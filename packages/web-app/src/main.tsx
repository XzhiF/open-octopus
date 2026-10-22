import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AppShell } from '@/components/providers/app-shell'
import '@/app/globals.css'

declare global {
  interface Window {
    __OCTOPUS_BOOT_ID__?: string
  }
}

window.__OCTOPUS_BOOT_ID__ = crypto.randomUUID()

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  </StrictMode>,
)
