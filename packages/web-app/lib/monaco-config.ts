// Monaco editor configuration - must only be called on client side
let configured = false

export function configureMonaco() {
  if (configured || typeof window === "undefined") return
  configured = true

  // Dynamic imports - bundler will resolve these at build time
  Promise.all([
    import("@monaco-editor/react").then(m => m.loader),
    import("monaco-editor"),
  ]).then(([loader, monaco]) => {
    loader.config({ monaco })
  }).catch(error => {
    console.warn("Failed to configure Monaco:", error)
    configured = false
  })
}
