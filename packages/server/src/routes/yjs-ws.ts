import http from "http"
import WebSocket from "ws"
import * as Y from "yjs"
import * as encoding from "lib0/encoding"
import * as decoding from "lib0/decoding"
import * as syncProtocol from "y-protocols/sync"
import * as awarenessProtocol from "y-protocols/awareness"
import os from "os"
import { WorkspaceDAO } from "../db/dao"
import { populateFromDisk, startWatch, closeWorkspace } from "../services/yjs"

const messageSync = 0
const messageAwareness = 1
const messageQueryAwareness = 3

interface Room {
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  conns: Map<WebSocket, Set<number>>
}

const docs = new Map<string, Room>()

let _workspaceDAO: WorkspaceDAO | null = null

export function setYjsWorkspaceDAO(dao: WorkspaceDAO): void {
  _workspaceDAO = dao
}

function initWorkspaceRoom(roomName: string, doc: Y.Doc): void {
  const wsPrefix = "workspace:"
  if (!roomName.startsWith(wsPrefix)) return

  const workspaceId = roomName.slice(wsPrefix.length)
  try {
    if (!_workspaceDAO) return
    const wsPath = _workspaceDAO.findPathById(workspaceId)
    if (!wsPath) return

    const resolvedPath = wsPath.replace(/^~/, os.homedir())
    const tree = doc.getMap("fileTree")
    if (tree.size === 0) {
      populateFromDisk(resolvedPath, tree)
    }
    startWatch(workspaceId, resolvedPath, doc)
  } catch {
    // DB may not be ready during startup
  }
}

function getRoom(roomName: string): Room {
  let room = docs.get(roomName)
  if (!room) {
    const doc = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(doc)
    awareness.setLocalState(null)
    const conns = new Map<WebSocket, Set<number>>()

    initWorkspaceRoom(roomName, doc)

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.writeUpdate(encoder, update)
      const msg = encoding.toUint8Array(encoder)
      let sent = 0
      for (const [conn] of conns) {
        if (conn !== origin && conn.readyState === WebSocket.OPEN) {
          send(conn, msg)
          sent++
        }
      }
      })

    const awarenessChangeHandler = ({ added, updated, removed }: any, conn: unknown) => {
      const changedClients = added.concat(updated, removed)
      if (conn !== null) {
        const controlled = conns.get(conn as WebSocket)
        if (controlled) {
          for (const id of added) controlled.add(id)
          for (const id of removed) controlled.delete(id)
        }
      }
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients))
      const msg = encoding.toUint8Array(encoder)
      for (const [c] of conns) {
        if (c !== conn && c.readyState === WebSocket.OPEN) {
          send(c, msg)
        }
      }
    }
    awareness.on("update", awarenessChangeHandler)

    room = { doc, awareness, conns }
    docs.set(roomName, room)
  }
  return room
}

function send(conn: WebSocket, msg: Uint8Array): void {
  if (conn.readyState === WebSocket.OPEN) {
    try {
      conn.send(msg)
    } catch {
      // ignore
    }
  }
}

export function createYjsWebSocketServer(server: http.Server): void {
  // ponytail: reduced maxPayload from 100MB to 4MB — DoS prevention
  const wss = new WebSocket.Server({ server, maxPayload: 4 * 1024 * 1024 })

  wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
    // Origin check — reject connections from untrusted origins
    const origin = req.headers.origin ?? req.headers.referer
    if (origin) {
      try {
        const { hostname } = new URL(origin)
        const localIps = new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map(i => i!.address))
        const trusted = hostname === "localhost" || hostname === "127.0.0.1" || localIps.has(hostname)
          || (process.env.OCTOPUS_FRONTEND_URL && origin === process.env.OCTOPUS_FRONTEND_URL)
        if (!trusted) {
          ws.close(1008, "Origin not allowed")
          return
        }
      } catch {
        ws.close(1008, "Invalid origin")
        return
      }
    }

    const url = new URL(req.url ?? "/", "http://localhost")
    const roomName = url.pathname.slice(1) || "default"

    const room = getRoom(roomName)
    room.conns.set(ws, new Set())

    // Send sync step 1
    const syncEncoder = encoding.createEncoder()
    encoding.writeVarUint(syncEncoder, messageSync)
    syncProtocol.writeSyncStep1(syncEncoder, room.doc)
    send(ws, encoding.toUint8Array(syncEncoder))

    // Send existing awareness states
    const awarenessStates = room.awareness.getStates()
    if (awarenessStates.size > 0) {
      const awarenessEncoder = encoding.createEncoder()
      encoding.writeVarUint(awarenessEncoder, messageAwareness)
      encoding.writeVarUint8Array(awarenessEncoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(awarenessStates.keys())))
      send(ws, encoding.toUint8Array(awarenessEncoder))
    }

    ws.on("message", (data: WebSocket.Data) => {
      try {
        const buf = Buffer.isBuffer(data) ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer)
        const messageEncoder = encoding.createEncoder()
        const decoder = decoding.createDecoder(buf)
        const messageType = decoding.readVarUint(decoder)

        switch (messageType) {
          case messageSync: {
            encoding.writeVarUint(messageEncoder, messageSync)
            syncProtocol.readSyncMessage(decoder, messageEncoder, room.doc, ws)
            break
          }
          case messageAwareness: {
            awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), ws)
            break
          }
          case messageQueryAwareness: {
            encoding.writeVarUint(messageEncoder, messageAwareness)
            encoding.writeVarUint8Array(messageEncoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(room.awareness.getStates().keys())))
            break
          }
        }

        const reply = encoding.toUint8Array(messageEncoder)
        if (reply.byteLength > 1) {
          send(ws, reply)
        }
      } catch (err) {
        console.error("[yjs] message error:", err)
      }
    })

    ws.on("close", () => {
      const controlledIds = room.conns.get(ws)
      room.conns.delete(ws)
      if (controlledIds && controlledIds.size > 0) {
        awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(controlledIds), null)
      }
      if (room.conns.size === 0) {
        const wsPrefix = "workspace:"
        if (roomName.startsWith(wsPrefix)) {
          closeWorkspace(roomName.slice(wsPrefix.length))
        }
        room.doc.destroy()
        docs.delete(roomName)
      }
    })
  })
}

export function getOrCreateYDoc(roomName: string): Y.Doc {
  return getRoom(roomName).doc
}

export { docs }