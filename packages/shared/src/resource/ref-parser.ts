import { ResourceError } from "./errors"
import type { ResourceType, ResourceSource } from "./types"
import { REF_RE } from "./types"

export interface ParsedRef {
  source: ResourceSource
  name: string
  raw: string
}

/**
 * RefParser — parse "builtin:brainstorming" or "local:/path/to/resource"
 * Registry pattern: Map<source, parser>. Phase 2 adds git/npm parsers.
 */

type RefParserFn = (namePart: string) => ParsedRef

const parsers = new Map<string, RefParserFn>()

parsers.set("builtin", (namePart) => ({
  source: "builtin",
  name: namePart,
  raw: `builtin:${namePart}`,
}))

parsers.set("local", (namePart) => ({
  source: "local",
  name: namePart,
  raw: `local:${namePart}`,
}))

parsers.set("git", (namePart) => ({
  source: "git",
  name: namePart,
  raw: `git:${namePart}`,
}))

export function parseRef(ref: string): ParsedRef {
  if (!REF_RE.test(ref)) {
    throw new ResourceError("INVALID_REF", `Invalid ref: ${ref}`)
  }

  const colonIdx = ref.indexOf(":")
  const source = ref.slice(0, colonIdx)
  const namePart = ref.slice(colonIdx + 1)

  const parser = parsers.get(source)
  if (!parser) {
    throw new ResourceError("INVALID_SOURCE", `Unknown source: ${source}`)
  }

  return parser(namePart)
}

export function registerRefParser(source: string, parser: RefParserFn): void {
  parsers.set(source, parser)
}

export function getRegisteredSources(): string[] {
  return [...parsers.keys()]
}
