import { Hono } from "hono"
import { WorkspaceDAO } from "../db/dao"
import { FileService } from "../services/file-service"
import os from "os"
import fs from "fs"
import path from "path"
import * as Y from "yjs"

export function createFileRoutes(workspaceDAO: WorkspaceDAO): Hono {
  const fileRoutes = new Hono()

  function getFileService(c: any): FileService | null {
    const id = c.req.param("id")
    const wsPath = workspaceDAO.findPathById(id)
    if (!wsPath) return null
    return new FileService(wsPath.replace(/^~/, os.homedir()))
  }

  fileRoutes.post("/", async (c) => {
    const fsvc = getFileService(c)
    if (!fsvc) return c.json({ error: "Workspace not found" }, 404)

    const body = await c.req.json<{ path: string; type: "file" | "directory"; content?: string }>()
    if (!body.path || !body.type) {
      return c.json({ error: "path and type required" }, 400)
    }

    try {
      if (body.type === "directory") {
        return c.json(fsvc.createDirectory(body.path), 201)
      }
      return c.json(fsvc.createFile(body.path, body.content ?? ""), 201)
    } catch (err: any) {
      return c.json({ error: err.message }, 400)
    }
  })

  fileRoutes.put("/", async (c) => {
    const fsvc = getFileService(c)
    if (!fsvc) return c.json({ error: "Workspace not found" }, 404)

    const body = await c.req.json<{ path: string; content: string; originalContent?: string; force?: boolean }>()
    if (!body.path) {
      return c.json({ error: "path required" }, 400)
    }

    try {
      if (body.force) {
        return c.json(fsvc.saveFile(body.path, body.content ?? ""))
      }

      const diskContent = fsvc.readFile(body.path).content

      if (diskContent === body.content) {
        return c.json(fsvc.saveFile(body.path, body.content ?? ""))
      }

      if (body.originalContent !== undefined) {
        if (body.originalContent === diskContent) {
          return c.json(fsvc.saveFile(body.path, body.content ?? ""))
        }
        return c.json({ conflict: true, path: body.path, externalContent: diskContent }, 409)
      }

      return c.json({ conflict: true, path: body.path, externalContent: diskContent }, 409)
    } catch (err: any) {
      return c.json({ error: err.message }, 400)
    }
  })

  fileRoutes.delete("/", async (c) => {
    const fsvc = getFileService(c)
    if (!fsvc) return c.json({ error: "Workspace not found" }, 404)

    const body = await c.req.json<{ path: string }>()
    if (!body.path) {
      return c.json({ error: "path required" }, 400)
    }

    try {
      return c.json(fsvc.deleteFile(body.path))
    } catch (err: any) {
      return c.json({ error: err.message }, 404)
    }
  })

  fileRoutes.get("/", (c) => {
    const fsvc = getFileService(c)
    if (!fsvc) return c.json({ error: "Workspace not found" }, 404)

    const filePath = c.req.query("path")
    if (!filePath) return c.json({ error: "path query required" }, 400)

    try {
      return c.json(fsvc.readFile(filePath))
    } catch (err: any) {
      return c.json({ error: err.message }, 404)
    }
  })

  fileRoutes.patch("/", async (c) => {
    const fsvc = getFileService(c)
    if (!fsvc) return c.json({ error: "Workspace not found" }, 404)

    const body = await c.req.json<{ path: string; newName: string }>()
    if (!body.path || !body.newName) {
      return c.json({ error: "path and newName required" }, 400)
    }

    try {
      return c.json(fsvc.renameFile(body.path, body.newName))
    } catch (err: any) {
      return c.json({ error: err.message }, 400)
    }
  })

  fileRoutes.post("/refresh", async (c) => {
    const id = c.req.param("id")
    const wsPath = workspaceDAO.findPathById(id)
    if (!wsPath) return c.json({ error: "Workspace not found" }, 404)

    try {
      const { docs } = require("../routes/yjs-ws")
      const roomName = `workspace:${id}`
      const room = docs.get(roomName)
      if (!room) return c.json({ error: "WS room not active" }, 404)

      const resolvedPath = wsPath.replace(/^~/, os.homedir())
      const tree = room.doc.getMap("fileTree")
      const { populateFromDisk } = require("../services/yjs")

      Y.transact(room.doc, () => {
        populateFromDisk(resolvedPath, tree)
      })

      return c.json({ ok: true })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  fileRoutes.post("/debug-log", (c) => {
    try {
      const logPath = path.join(os.homedir(), ".octopus", "debug", "tree-debug.log")
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      const msg = new Date().toISOString() + " " + (c.req.query("msg") ?? "") + "\n"
      fs.appendFileSync(logPath, msg, "utf-8")
      return c.json({ ok: true })
    } catch {
      return c.json({ ok: false })
    }
  })

  return fileRoutes
}

export default createFileRoutes
