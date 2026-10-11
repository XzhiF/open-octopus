// packages/web-app/components/tasks/run-console/ready-spec-tab.tsx
//
// 票 09（原型⓬ readySpecHtml）—— 待执行控制台「▤ 规格」= 草稿右栏 SpecPanel 的
// **只读镜像**：单源换装（SpecPanel 加 readOnly 入参），不复制第二套面板。
// 镜像头 = 原型 f-toolbar 逐字（「草稿期 SpecPanel 只读镜像 … 要改请走右栏
// 『↩ 回草稿』」+ 只读徽标）；面板体三段照常：phases 卡（静态）、入队清单、
// 输出区批次目录树（文件点击开 HomeFileViewerDialog 只读查看）。
//
// 取数纪律（server 零新端点，全部走任务详情既有 payload / 读取面）：
//   · task_spec —— 控制台已轮询的 GET /:id detail 快照优先，看板 prop 兜底；
//   · 六行清单 —— 提纯共享函数 computeSpecRows（authoring 入队预检同一份）+
//     built-in 目录（listBuiltInWorkflows，与草稿侧同 effect 形态）；
//   · gateHits —— computeGateHits(null)：ready 任务已过服务端硬闸，gateMissing
//     是入队交互态（409 反解）控制台不存在 → 全空 = 清单只显 ✓ 态；
//   · home/batchTree —— 复用 authoring 现成 hooks（toolCalls/streaming 缺席：
//     R1 走 version bump + 两 hook 内建的 task_artifacts_update SSE 通路）。

"use client"

import { useEffect, useMemo, useState } from "react"
import type { Task } from "@octopus/shared"
import type { TaskDetail } from "@/lib/tasks-api"
import { listBuiltInWorkflows, type BuiltInWorkflowSummary } from "@/lib/workflow-presets-api"
import { SpecPanel } from "../authoring/spec-panel"
import { useBatchTree } from "../authoring/use-batch-tree"
import { useHomeTree } from "../authoring/use-home-tree"
import { computeGateHits, computeSpecRows } from "../authoring/spec-gate"

export function ReadySpecTab({ task, detail }: { task: Task; detail: TaskDetail | null }) {
  // spec 真相 = 控制台轮询快照（比看板行新鲜），缺省回落 prop（首帧未到位时）。
  const spec = detail?.task_spec ?? task.task_spec
  const mirrorTask = useMemo(() => ({ ...task, task_spec: spec }), [task, spec])
  const phases = spec.phases ?? []

  // inputs 行判据的 built-in 目录（authoring 同款：读不到不阻塞，server 权威）。
  const [catalog, setCatalog] = useState<BuiltInWorkflowSummary[]>([])
  useEffect(() => {
    let cancelled = false
    listBuiltInWorkflows()
      .then((list) => { if (!cancelled) setCatalog(list) })
      .catch(() => { if (!cancelled) setCatalog([]) })
    return () => { cancelled = true }
  }, [])

  const batchTree = useBatchTree(task.id, { versionKey: task.version })
  const home = useHomeTree(task.id, { versionKey: task.version })

  const rows = useMemo(
    () => computeSpecRows({
      phases, spec, catalog,
      batches: batchTree.batches, batchLoading: batchTree.loading, batchError: batchTree.error,
    }),
    [phases, spec, catalog, batchTree.batches, batchTree.loading, batchTree.error],
  )
  const gateHits = useMemo(() => computeGateHits(null), [])

  return (
    <div data-testid="ready-spec-tab" className="flex min-h-0 flex-1 flex-col">
      {/* 原型 readySpecHtml .f-toolbar 逐字 + .ro-badge */}
      <div className="flex shrink-0 items-center gap-2 px-1 pb-2 font-mono text-[10.5px] text-pop-dim" data-ready-spec-toolbar>
        <span>草稿期 SpecPanel 只读镜像 · v4 phases={phases.length} — 要改请走右栏「↩ 回草稿」</span>
        <span
          className="ml-auto shrink-0 rounded-full border-[1.5px] border-pop-bd px-2 py-px font-black text-pop-yellow"
          data-ready-spec-readonly-badge
        >
          只读
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-md border-[1.5px] border-pop-bd">
        <SpecPanel
          task={mirrorTask}
          onMutated={() => { /* 只读态写动作不渲染，本回调无处触发 */ }}
          batchTree={batchTree}
          rows={rows}
          gateHits={gateHits}
          home={home}
          readOnly
        />
      </div>
    </div>
  )
}
