// packages/server/src/services/tasks/runbook-spec.ts
//
// 启动 Runbook 两级判据的单一真源（taskboard-modal-v2 票10 review-6）。
// 历史上这条判据在三个落点各抄了一份，措辞/宽严漂移：
//   - round-evidence-service.resolveRunbook（验货台预览/剧本步过滤）
//   - tasks-service.readyTask 的 v4 runbook 硬闸（缺 runbook/preview → missing）
//   - task-doer-service.buildTaskContext 的每回合注入行
// 这里收成一对纯函数：`specRunbookLevel`（命中哪一级）+ `runbookFromSpec`
// （命中即解析成生效 runbook，② 级按旧面板语义合成 curl 就绪探活）。
//
// 语义逐字不变（2026-09-22 定级的两级）：
//   ① 显式 `acceptance_runbook` —— up 与 ready 的 command 非空白即命中；
//   ② legacy `acceptance_preview` —— command 非空白且带 url（ready-gate 旧判据
//      只查 command，注释「url 由 schema 保证」；这里统一查 command+url，对
//      acceptancePreviewSchema（url required, http(s)）写入路径逐字等价，
//      只是对手改坏行的 spec 更诚实 —— 没 url 的 preview 本来就跑不了预览）。
// 历史第③级「约定脚本 .octopus/acceptance/*.sh」已摘除，理由见 resolveRunbook
// 的原注释（工作区根探测永不相交，测试自证假象）。
//

import type { AcceptancePreview, AcceptanceRunbook } from "@octopus/shared"

/** 命中的 runbook 级别（canonical 词：启动 Runbook ① 显式 / ② legacy preview）。 */
export type SpecRunbookLevel = "explicit" | "legacy"

/** 只吃这两个 spec 字段 —— 三个调用方各自手里的 spec 形状都结构化满足。 */
export interface RunbookSpecFields {
  acceptance_runbook?: { up?: { command?: string }; ready?: { command?: string } }
  acceptance_preview?: { command?: string; url?: string }
}

/** 两级判据：命中哪一级（都没有 → null）。 */
export function specRunbookLevel(spec: RunbookSpecFields | undefined | null): SpecRunbookLevel | null {
  const rb = spec?.acceptance_runbook
  if (rb?.up?.command?.trim() && rb?.ready?.command?.trim()) return "explicit"
  const legacy = spec?.acceptance_preview
  if (legacy?.command?.trim() && legacy?.url) return "legacy"
  return null
}

/** 两级解析：命中即给生效 runbook（② 级合成单服务 runbook），都没有 → null。
 *  round-evidence.resolveRunbook 委托到这里；ready-gate 只需 specRunbookLevel。 */
export function runbookFromSpec(
  spec: (RunbookSpecFields & {
    acceptance_runbook?: AcceptanceRunbook
    acceptance_preview?: AcceptancePreview
  }) | undefined | null,
): AcceptanceRunbook | null {
  switch (specRunbookLevel(spec)) {
    case "explicit":
      return spec?.acceptance_runbook ?? null
    case "legacy": {
      const legacy = spec?.acceptance_preview
      if (!legacy?.command?.trim() || !legacy.url) return null
      return {
        up: { command: legacy.command, cwd: legacy.cwd },
        // rc0 = got any HTTP response (conn refused → rc7 → not ready); mirrors
        // the old "any response = port up" probe under the unified exit-code rule.
        ready: { command: `curl -s -o /dev/null ${JSON.stringify(legacy.url)}` },
        views: [{ url: legacy.url }],
      }
    }
    default:
      return null
  }
}
