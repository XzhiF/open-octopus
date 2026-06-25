import fs from "fs"
import path from "path"
import os from "os"

export class FileService {
  private workspacePath: string

  constructor(workspacePath: string) {
    this.workspacePath = path.resolve(workspacePath.replace(/^~/, os.homedir()))
  }

  private resolve(relPath: string): string {
    const resolved = path.resolve(this.workspacePath, relPath.startsWith("/") ? relPath.slice(1) : relPath)
    if (!resolved.startsWith(this.workspacePath)) {
      throw new Error("Path traversal denied")
    }
    return resolved
  }

  createFile(relPath: string, content = ""): { path: string } {
    const fullPath = this.resolve(relPath)
    const dir = path.dirname(fullPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(fullPath, content, "utf-8")
    return { path: relPath }
  }

  createDirectory(relPath: string): { path: string } {
    const fullPath = this.resolve(relPath)
    fs.mkdirSync(fullPath, { recursive: true })
    return { path: relPath }
  }

  saveFile(relPath: string, content: string): { path: string } {
    const fullPath = this.resolve(relPath)
    if (!fs.existsSync(fullPath)) {
      throw new Error("File not found")
    }
    fs.writeFileSync(fullPath, content, "utf-8")
    return { path: relPath }
  }

  deleteFile(relPath: string): { path: string } {
    const fullPath = this.resolve(relPath)
    if (!fs.existsSync(fullPath)) {
      throw new Error("Not found")
    }
    const stat = fs.statSync(fullPath)
    if (stat.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true })
    } else {
      fs.unlinkSync(fullPath)
    }
    return { path: relPath }
  }

  renameFile(relPath: string, newName: string): { path: string; newPath: string } {
    const fullPath = this.resolve(relPath)
    if (!fs.existsSync(fullPath)) {
      throw new Error("Not found")
    }
    const parentDir = path.dirname(relPath)
    const newRelPath = parentDir === "/" ? `/${newName}` : `${parentDir}/${newName}`
    const fullNewPath = this.resolve(newRelPath)
    if (fs.existsSync(fullNewPath)) {
      throw new Error(`"${newName}" already exists`)
    }
    fs.renameSync(fullPath, fullNewPath)
    return { path: relPath, newPath: newRelPath }
  }

  readFile(relPath: string): { path: string; content: string } {
    const fullPath = this.resolve(relPath)
    if (!fs.existsSync(fullPath)) {
      throw new Error("File not found")
    }
    return {
      path: relPath,
      content: fs.readFileSync(fullPath, "utf-8"),
    }
  }
}