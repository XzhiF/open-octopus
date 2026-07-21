import fs from "fs"
import path from "path"
import os from "os"

const MIME_TYPES: Record<string, string> = {
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  bmp: "image/bmp",
  tiff: "image/tiff",
  tif: "image/tiff",
  svg: "image/svg+xml",
  avif: "image/avif",
  // Fonts
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  eot: "application/vnd.ms-fontobject",
  otf: "font/otf",
  // Media
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  // Documents
  pdf: "application/pdf",
  // Archives
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  // Data
  json: "application/json",
  xml: "application/xml",
  wasm: "application/wasm",
}

export const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff", "tif", "avif",
  "svg",
  "woff", "woff2", "ttf", "eot", "otf",
  "mp3", "wav", "mp4", "webm", "avi", "mov",
  "pdf",
  "zip", "tar", "gz",
  "class", "jar", "war", "ear", "o", "so", "dll", "exe", "pyc", "rbc", "beam", "node", "wasm",
])

export function getMimeType(filename: string): string {
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : ""
  return MIME_TYPES[ext] ?? "application/octet-stream"
}

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

  readFileRaw(relPath: string): { buffer: Buffer; mimeType: string; size: number } {
    const fullPath = this.resolve(relPath)
    if (!fs.existsSync(fullPath)) {
      throw new Error("File not found")
    }
    const stat = fs.statSync(fullPath)
    if (stat.isDirectory()) {
      throw new Error("Cannot read directory as binary")
    }
    const buffer = fs.readFileSync(fullPath)
    const mimeType = getMimeType(path.basename(fullPath))
    return { buffer, mimeType, size: stat.size }
  }
}