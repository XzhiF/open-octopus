// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module "monaco-editor" {
  export namespace editor {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type IStandaloneCodeEditor = any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type ITextModel = any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type IStandaloneDiffEditor = any
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const KeyMod: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const KeyCode: any
}

declare module "js-yaml" {
  export function load(str: string, opts?: unknown): unknown
  export function dump(obj: unknown, opts?: unknown): string
  export function loadAll(str: string, iterator?: (doc: unknown) => void, opts?: unknown): unknown[]
}
