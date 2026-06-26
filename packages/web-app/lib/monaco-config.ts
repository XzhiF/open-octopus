import { loader } from "@monaco-editor/react"

// Use locally installed monaco-editor instead of CDN (jsdelivr).
// CDN is often unreachable behind firewalls/proxies, causing "Monaco initialization: error: {}"
// Guard against SSR — monaco-editor requires window
if (typeof window !== "undefined") {
  import("monaco-editor").then((monaco) => {
    loader.config({ monaco })
  })
}
