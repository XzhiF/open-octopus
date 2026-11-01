// packages/server/src/services/chat/slash-commands.ts
//
// Per-session slash-command cache.
//
// The headless command set is discovered by the CLI at runtime (plugins +
// skills + built-ins) and arrives as `system:init.slash_commands`. It is not
// derivable from the DB, so the composer cannot hardcode it. We keep the last
// advertised list in memory, keyed by session, so a page reload can repaint
// the `/` menu without waiting for another turn. Process-local by design:
// losing it on restart only means the menu reappears after the next message.

const cache = new Map<string, string[]>()

export function rememberSlashCommands(sessionId: string, commands: string[]): void {
  if (!sessionId) return
  cache.set(sessionId, [...new Set(commands)])
}

export function getSlashCommands(sessionId: string): string[] {
  return cache.get(sessionId) ?? []
}

/** Test seam / session deletion hook. */
export function clearSlashCommands(sessionId: string): void {
  cache.delete(sessionId)
}
