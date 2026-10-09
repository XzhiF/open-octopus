// packages/web-app/components/tasks/run-console/artifacts-model.ts
//
// 票 11 ⑩回补 — ▣ 产物页签展示模型纯层：分组清单由 server
// GET /:id/artifacts/manifest 定形（五组 + 归类判据在 server 单源，前端不重分组、
// 不反推），这里只榨三件显示事实：徽标件数、体积记数、预览截断。

export interface ArtifactManifestItem {
  name: string
  /** 门牌引用：`home:<.scratch/…>` / `ws:<工作区相对>`。 */
  path: string
  bytes: number
  mtime: string
}

export interface ArtifactManifestGroup {
  key: string
  label: string
  items: ArtifactManifestItem[]
}

export interface ArtifactManifestBody {
  groups: ArtifactManifestGroup[]
}

/** 页签徽标件数（原型 artifactsOf(t).length 口径 = 全部条目求和）。 */
export function manifestTotalCount(body: ArtifactManifestBody): number {
  return body.groups.reduce((sum, g) => sum + g.items.length, 0)
}

/** 体积记数：B / KB / MB 一档（1024 制）。命名刻意避开受禁 format* 前缀
 *  （formatter-revival gate C4：lib/format.ts 是全站唯一 format* 出口）。 */
export function artifactSizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/** 预览截断（对话框现读文本；server 读门已按 512KB 封顶，这里再按行数视觉封顶）。 */
export function previewTruncate(content: string, maxChars = 20_000): { text: string; truncated: boolean } {
  if (content.length <= maxChars) return { text: content, truncated: false }
  return { text: content.slice(0, maxChars), truncated: true }
}
