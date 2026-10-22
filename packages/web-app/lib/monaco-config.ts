// Monaco must be configured synchronously before @monaco-editor/react renders;
// the old async loader.config() could race into the CDN fallback.
import '@/lib/monaco-setup'

export function configureMonaco() {
  // Kept as the call-site seam; setup runs on module evaluation.
}
