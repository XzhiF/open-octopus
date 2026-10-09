// packages/web-app/components/tasks/run-console/artifacts-model.ts
//
// 票 11 ⑩回补 — ▣ 产物页签展示模型纯层：分组清单由 server
// GET /:id/artifacts/manifest 定形（五组 + 归类判据在 server 单源，前端不重分组、
// 不反推），这里只榨显示事实：徽标件数、预览截断。
//
// 票11 双轴 review 收口③⑤：
//   • 体积记数删私有副本（原 artifactSizeText），消费者直接用 lib/format.ts::formatBytes
//     ——全站唯一 format* 出口，无需再绕 C4 命名闸；
//   • ArtifactManifestItem/Group/Body wire 形并入 lib/types.ts 单源（与
//     LlmNodeAggregatesWire 同放法），本层与 lib/tasks-api.ts 同引之。

import type { ArtifactManifestBody } from "@/lib/types"

/** 页签徽标件数（原型 artifactsOf(t).length 口径 = 全部条目求和）。 */
export function manifestTotalCount(body: ArtifactManifestBody): number {
  return body.groups.reduce((sum, g) => sum + g.items.length, 0)
}

/** 预览截断（对话框现读文本；server 读门已按 512KB 封顶，这里再按行数视觉封顶）。 */
export function previewTruncate(content: string, maxChars = 20_000): { text: string; truncated: boolean } {
  if (content.length <= maxChars) return { text: content, truncated: false }
  return { text: content.slice(0, maxChars), truncated: true }
}
