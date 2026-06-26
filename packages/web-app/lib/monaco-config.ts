import { loader } from "@monaco-editor/react"

// ponytail: opaque import — Turbopack can't resolve monaco-editor through
// pnpm symlinks at build time (Next 16 + Turbopack quirk).
// new Function hides the import() from static analysis; identical at runtime.
if (typeof window !== "undefined") {
  const loadMonaco = new Function('return import("monaco-editor")') as () => Promise<typeof import("monaco-editor")>
  loadMonaco().then((monaco) => {
    loader.config({ monaco })
  })
}
