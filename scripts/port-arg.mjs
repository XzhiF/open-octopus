/**
 * Shared parser for the `--port` flag used by dev.mjs and prod.mjs.
 *
 * Format: "<web>,<server>" — web port first, server port second.
 * Returns { web, server } or null when the value is not a valid pair.
 */

const MIN = 1
const MAX = 65535

function isValidPort(n) {
  return Number.isInteger(n) && n >= MIN && n <= MAX
}

export function parsePortPair(raw) {
  if (typeof raw !== "string") return null
  const parts = raw.split(",")
  if (parts.length !== 2) return null
  const web = Number(parts[0])
  const server = Number(parts[1])
  if (!isValidPort(web) || !isValidPort(server) || web === server) return null
  return { web, server }
}
