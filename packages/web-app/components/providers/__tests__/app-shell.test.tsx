import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

vi.mock('@/components/shell/desktop', () => ({
  Desktop: () => <div data-testid="desktop-shell" />,
}))
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }))
vi.mock('@/hooks/use-server-health', () => ({
  useServerHealth: () => ({
    status: 'online',
    serverUrl: 'http://localhost:3001',
    detail: null,
    failures: 0,
    lastOnlineAt: null,
    retry: vi.fn(),
  }),
}))
vi.mock('@/hooks/useAgentSessions', () => ({
  useAgentSessions: () => ({
    sessions: [],
    activeSessionId: null,
    setActiveSessionId: vi.fn(),
    loading: false,
    error: null,
    createNewSession: vi.fn(),
    renameSession: vi.fn(),
    removeSession: vi.fn(),
    updateSessionTitle: vi.fn(),
    refetch: vi.fn(),
  }),
}))

import { AppShell } from '../app-shell'

describe('AppShell desktop providers', () => {
  it('mounts the desktop shell inside the navigation, chat-session and window providers', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppShell />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('desktop-shell')).toBeInTheDocument()
  })
})
