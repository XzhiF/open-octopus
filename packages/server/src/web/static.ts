import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

function send(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS })
  res.end(body)
}

function cacheControl(pathname: string): string {
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  return 'no-cache'
}

/**
 * SPA static hosting for production/desktop. Returns true when the request is
 * handled here; `/api/*` and non-GET/HEAD fall through to Hono.
 */
export function createWebStaticHandler(
  rootDir: string | undefined,
): ((req: IncomingMessage, res: ServerResponse) => boolean) | null {
  if (!rootDir) return null
  const root = path.resolve(rootDir)
  const indexPath = path.join(root, 'index.html')
  if (!fs.existsSync(indexPath)) {
    console.warn(`[web] OCTOPUS_WEB_DIR has no index.html: ${indexPath}`)
    return null
  }

  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false

    let url: URL
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    } catch {
      return false
    }
    if (url.pathname.startsWith('/api/')) return false

    let pathname: string
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      send(res, 400, 'Bad Request')
      return true
    }

    const target = path.resolve(root, `.${pathname}`)
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      send(res, 403, 'Forbidden')
      return true
    }

    let filePath = target
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      const isStaticAsset = pathname.startsWith('/assets/') || pathname.startsWith('/prototype/')
      if (isStaticAsset || pathname === '/index.html') {
        send(res, 404, 'Not Found')
        return true
      }
      filePath = indexPath
    }

    const ext = path.extname(filePath).toLowerCase()
    const data = fs.readFileSync(filePath)
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': data.byteLength,
      'Cache-Control': cacheControl(pathname),
      ...SECURITY_HEADERS,
    })
    if (req.method === 'HEAD') res.end()
    else res.end(data)
    return true
  }
}
