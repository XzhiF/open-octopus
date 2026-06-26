import { loader } from "@monaco-editor/react"

// Use locally installed monaco-editor instead of CDN (jsdelivr).
// CDN is often unreachable behind firewalls/proxies, causing "Monaco initialization: error: {}"
import * as monaco from "monaco-editor"

loader.config({ monaco })
