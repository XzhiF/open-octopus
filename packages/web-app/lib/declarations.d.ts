declare module "monaco-editor" {
  export namespace editor {
    type IStandaloneCodeEditor = any
    type ITextModel = any
    type IStandaloneDiffEditor = any
  }
  export const KeyMod: any
  export const KeyCode: any
}

declare module "js-yaml" {
  export function load(str: string, opts?: unknown): unknown
  export function dump(obj: unknown, opts?: unknown): string
  export function loadAll(str: string, iterator?: (doc: unknown) => void, opts?: unknown): unknown[]
}
