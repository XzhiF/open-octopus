"use client"

import { createContext, useContext, useState, useEffect, useCallback } from "react"
import { getServerUrl } from "@/lib/server-config"

interface User {
  id: string
  username: string
  email: string | null
}

interface AuthState {
  user: User | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string, email?: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  login: async () => {},
  register: async () => {},
  logout: async () => {},
})

export function useAuth() {
  return useContext(AuthContext)
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  // Check auth state on mount
  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch(`${getServerUrl()}/api/auth/me`, { credentials: "include" })
        if (res.ok) {
          const data = await res.json()
          if (data.authenticated && data.user) {
            setUser(data.user)
          }
        }
      } catch {
        // Not authenticated
      } finally {
        setLoading(false)
      }
    }
    checkAuth()
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    const res = await fetch(`${getServerUrl()}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ username, password }),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || "登录失败")
    }
    setUser(data.user)
  }, [])

  const register = useCallback(async (username: string, password: string, email?: string) => {
    const res = await fetch(`${getServerUrl()}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ username, password, email }),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || "注册失败")
    }
    setUser(data.user)
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch(`${getServerUrl()}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      })
    } catch { /* ignore */ }
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
