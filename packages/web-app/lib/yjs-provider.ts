"use client"
import { useEffect, useRef, useState } from "react"
import * as Y from "yjs"
import { WebsocketProvider } from "y-websocket"
import { getServerUrl } from "@/lib/server-config"

function getWsUrl(): string {
  const serverUrl = getServerUrl()
  const protocol = serverUrl.startsWith("https") ? "wss" : "ws"
  return serverUrl.replace(/^https?/, protocol)
}

interface UseYDocResult {
  doc: Y.Doc | null
  provider: WebsocketProvider | null
  connected: boolean
  synced: boolean
}

export function useYDoc(workspaceId: string): UseYDocResult {
  const [doc, setDoc] = useState<Y.Doc | null>(null)
  const [connected, setConnected] = useState(false)
  const [synced, setSynced] = useState(false)
  const providerRef = useRef<WebsocketProvider | null>(null)

  useEffect(() => {
    const doc = new Y.Doc()
    const provider = new WebsocketProvider(getWsUrl(), `workspace:${workspaceId}`, doc)

    setDoc(doc)
    providerRef.current = provider

    provider.on("status", (event: { status: string }) => {
      setConnected(event.status === "connected")
    })

    provider.on("sync", (isSynced: boolean) => {
      setSynced(isSynced)
    })

    return () => {
      provider.disconnect()
      doc.destroy()
      setDoc(null)
      providerRef.current = null
      setConnected(false)
      setSynced(false)
    }
  }, [workspaceId])

  return { doc, provider: providerRef.current, connected, synced }
}

interface UseYMapResult {
  map: Y.Map<unknown> | null
  version: number
}

export function useYMap(doc: Y.Doc | null, name: string): UseYMapResult {
  const [state, setState] = useState<UseYMapResult>({ map: null, version: 0 })

  useEffect(() => {
    if (!doc) {
      setState({ map: null, version: 0 })
      return
    }

    const m = doc.getMap(name)
    setState(prev => ({ map: m, version: prev.version + 1 }))

    const observer = () => {
      setState(prev => ({ map: prev.map, version: prev.version + 1 }))
    }

    m.observeDeep(observer)
    return () => m.unobserveDeep(observer)
  }, [doc, name])

  return state
}