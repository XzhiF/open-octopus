// packages/server/src/services/tasks/reflection-store.ts
//
// 2026-10-28 task-thread: archiving knowledge reflection.
//
// At archiving start the main chat is woken ONCE to propose 2–5 wiki entries.
// The proposals + the human's per-entry decision live in the task home:
//
//   {home}/archive/reflection.json
//
// Why a file (not a DB table): the archive window already reads the archive
// directory (state.json/report.md), the data is task-scoped and ephemeral,
// and writing it does not touch task status or the spec version.

import fs from "fs"
import path from "path"

export interface ReflectionEntry {
  id: string
  title: string
  /** The wiki page/body the model proposes. */
  content: string
  /** Optional destination hint shown to the human (GLOSSARY · X / ADR · Y). */
  target?: string
}

export type ReflectionAction = "ingest" | "skip"

export interface ReflectionDecision {
  action: ReflectionAction
  at: string
  /** Overrides applied at decision time (edit-before-ingest). */
  title?: string
  /** Ingest outcome. */
  raw_path?: string
  compile_task_id?: string
}

export interface ReflectionStore {
  task_id: string
  created_at: string
  entries: ReflectionEntry[]
  decisions: Record<string, ReflectionDecision>
}

export function reflectionStorePath(taskHome: string): string {
  return path.join(taskHome, "archive", "reflection.json")
}

export function readReflectionStore(taskHome: string): ReflectionStore | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(reflectionStorePath(taskHome), "utf-8")) as ReflectionStore
    if (!parsed || !Array.isArray(parsed.entries)) return null
    return { ...parsed, decisions: parsed.decisions ?? {} }
  } catch {
    return null
  }
}

export function writeReflectionStore(taskHome: string, store: ReflectionStore): void {
  const file = reflectionStorePath(taskHome)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(store, null, 2), "utf-8")
}
