import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

type WorkerCtor = new () => Worker

const workerScope = self as unknown as {
  MonacoEnvironment?: {
    getWorker: (_moduleId: string, label: string) => Worker
  }
}

workerScope.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    const workers: Record<string, WorkerCtor> = {
      json: JsonWorker,
      css: CssWorker,
      scss: CssWorker,
      less: CssWorker,
      html: HtmlWorker,
      handlebars: HtmlWorker,
      razor: HtmlWorker,
      typescript: TsWorker,
      javascript: TsWorker,
    }
    const WorkerClass = workers[label] ?? EditorWorker
    return new WorkerClass()
  },
}

loader.config({ monaco })
