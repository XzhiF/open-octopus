"use client"

import { useState, useEffect, useCallback } from "react"

/**
 * Like useState, but syncs to localStorage so values survive
 * component unmounts (e.g. tab switches, screen navigation).
 *
 * Returns [state, setState, clear] where clear removes the
 * persisted value (call after a successful submit).
 *
 * @param key       localStorage key — must be unique per logical form
 * @param initial   default value when no persisted value exists
 */
export function usePersistedState<T>(
  key: string,
  initial: T | (() => T),
): [T, (value: T | ((prev: T) => T)) => void, () => void] {
  const resolveInitial = () => (initial instanceof Function ? initial() : initial)

  const [state, setState] = useState<T>(() => {
    if (typeof window === "undefined") return resolveInitial()
    try {
      const stored = localStorage.getItem(key)
      return stored !== null ? (JSON.parse(stored) as T) : resolveInitial()
    } catch {
      return resolveInitial()
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state))
    } catch {
      // quota exceeded or private mode — fail silently
    }
  }, [key, state])

  const clear = useCallback(() => {
    try {
      localStorage.removeItem(key)
    } catch {
      // ignore
    }
  }, [key])

  return [state, setState, clear]
}
