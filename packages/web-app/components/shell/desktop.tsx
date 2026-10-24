'use client'

import { useCallback, useEffect, useMemo } from 'react'
import { ConversationHome } from '@/components/agent/chat/ConversationHome'
import { DesktopHeader } from '@/components/layout/desktop-header'
import { AppNavigationScope, createNavigationScopeValue, useAppNavigation } from '@/lib/app-navigation'
import {
  displayRect,
  useDesktopWindows,
  windowLabel,
  windowTitle,
  type WindowId,
} from '@/lib/desktop-windows'
import { missionLayout } from '@/lib/window-geometry'
import { AppWindow } from './app-window'
import { MissionControl, type MissionItem } from './mission-control'

export function Desktop() {
  const nav = useAppNavigation()
  const {
    state,
    stage,
    breakpoint,
    focusDesktop,
    focusWindow,
    restoreWindow,
    navigateWindow,
    setMissionControl,
    toggleMissionControl,
  } = useDesktopWindows()

  const narrow = breakpoint === 'narrow'
  const desktopFocused = state.focused === 'desktop'

  const chatScope = useMemo(
    () =>
      createNavigationScopeValue({
        pathname: '/',
        search: '',
        active: false,
        onNavigate: (target) => navigateWindow('desktop', target),
      }),
    [navigateWindow],
  )

  const missionItems = useMemo<MissionItem[]>(() => {
    if (!state.missionControl) return []
    const entries = [
      { id: 'desktop', rect: { x: 0, y: 0, w: stage.width, h: stage.height } },
      ...state.order.flatMap((id) => {
        const record = state.windows[id]
        if (!record) return []
        return [{ id, rect: displayRect(record, breakpoint, stage) }]
      }),
    ]
    const slots = missionLayout(entries, stage)
    return slots.map((slot) => {
      if (slot.id === 'desktop') {
        return {
          id: 'desktop',
          label: '对话',
          sublabel: '桌面',
          isDesktop: true,
          focused: desktopFocused,
          minimized: false,
          slot,
        }
      }
      const record = state.windows[slot.id as WindowId]
      const label = windowLabel(slot.id as WindowId)
      const title = record ? windowTitle(record) : undefined
      return {
        id: slot.id,
        label,
        sublabel: title && title !== label ? title : undefined,
        focused: state.focused === slot.id,
        minimized: record?.minimized ?? false,
        slot,
      }
    })
  }, [breakpoint, desktopFocused, stage, state.focused, state.missionControl, state.order, state.windows])

  const slotById = useMemo(
    () => new Map(missionItems.map((item) => [item.id, item.slot])),
    [missionItems],
  )

  const desktopSlot = slotById.get('desktop')
  const desktopTransform =
    state.missionControl && !narrow && desktopSlot
      ? `translate(${desktopSlot.tx}px, ${desktopSlot.ty}px) scale(${desktopSlot.scale})`
      : undefined

  const pickMissionItem = useCallback(
    (id: string) => {
      setMissionControl(false)
      if (id === 'desktop') {
        focusDesktop()
        return
      }
      const target = id as WindowId
      const record = state.windows[target]
      if (!record) return
      if (record.minimized) restoreWindow(target)
      else focusWindow(target)
    },
    [focusDesktop, focusWindow, restoreWindow, setMissionControl, state.windows],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const isMissionShortcut =
        event.key === 'F3' ||
        (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'ArrowUp')
      if (isMissionShortcut) {
        event.preventDefault()
        toggleMissionControl()
        return
      }
      if (event.key === 'Escape' && state.missionControl) {
        event.preventDefault()
        event.stopPropagation()
        setMissionControl(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [setMissionControl, state.missionControl, toggleMissionControl])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key !== 'k' && key !== 's' && key !== 'f') return
      const target = event.target as HTMLElement | null
      if (!target) return
      if (target.closest('[data-shell-chrome]')) return
      if (target.closest('[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]')) {
        return
      }
      const windowElement = target.closest('[data-window-id]') as HTMLElement | null
      if (windowElement) {
        if (windowElement.dataset.windowId !== state.focused) {
          event.preventDefault()
          event.stopImmediatePropagation()
        }
        return
      }
      const desktopElement = target.closest('[data-desktop-layer]')
      if (desktopElement) {
        if (state.focused !== 'desktop') {
          event.preventDefault()
          event.stopImmediatePropagation()
        }
        return
      }
      // body / document / portaled chrome: the focused surface's own window
      // listeners must run; hidden surfaces are gated by useIsActiveRoute.
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [state.focused])

  if (!nav) throw new Error('Desktop must be rendered inside AppNavProvider')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DesktopHeader />

      <div
        className="relative min-h-0 flex-1 overflow-hidden bg-pop-bg"
        data-testid="desktop-stage"
      >
        {state.missionControl && !narrow && (
          <div className="pointer-events-none absolute inset-0 z-0 bg-pop-bg/75" aria-hidden />
        )}

        <AppNavigationScope value={desktopFocused ? nav : chatScope}>
          <div
            className="absolute inset-0 z-[1] overflow-hidden bg-pop-bg"
            data-desktop-layer
            aria-label="对话桌面"
            inert={state.missionControl}
            style={{
              transform: desktopTransform,
              transformOrigin: 'top left',
              transition: state.missionControl
                ? 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)'
                : undefined,
              pointerEvents: state.missionControl ? 'none' : undefined,
            }}
            onPointerDownCapture={() => {
              if (!state.missionControl && state.focused !== 'desktop') focusDesktop()
            }}
          >
            <ConversationHome />
          </div>
        </AppNavigationScope>

        {state.order.map((id, index) => {
          const record = state.windows[id]
          if (!record) return null
          const focused = state.focused === id
          const hidden = state.missionControl && !narrow ? false : record.minimized || (narrow && !focused)
          const rect = displayRect(record, breakpoint, stage)
          const slot = slotById.get(id)
          const missionTransform =
            state.missionControl && !narrow && slot
              ? `translate(${slot.tx - rect.x}px, ${slot.ty - rect.y}px) scale(${slot.scale})`
              : undefined
          return (
            <AppWindow
              key={id}
              id={id}
              record={record}
              focused={focused}
              hidden={hidden}
              missionControl={state.missionControl && !narrow}
              missionTransform={missionTransform}
              zIndex={index + 2}
            />
          )
        })}

        {state.missionControl && (
          <MissionControl
            items={missionItems}
            narrow={narrow}
            onPick={pickMissionItem}
            onClose={() => setMissionControl(false)}
          />
        )}
      </div>
    </div>
  )
}
