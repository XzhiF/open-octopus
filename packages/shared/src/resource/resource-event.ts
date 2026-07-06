import type { ResourceType } from "./types"

export type ResourceEvent =
  | { kind: "installed"; name: string; type: ResourceType; version: string; path: string }
  | { kind: "uninstalled"; name: string; type: ResourceType }
  | { kind: "registered"; name: string; type: ResourceType; source: string }
  | { kind: "gc"; removed: string[]; freedBytes: number }
  | { kind: "completed"; action: string; durationMs: number }
  | { kind: "failed"; action: string; error: string }
