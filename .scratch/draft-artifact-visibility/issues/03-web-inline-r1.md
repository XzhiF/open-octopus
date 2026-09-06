# 03 — web：Phase 行内展开 + R1 useBatchTree + 入队清单磁盘判定 + manifest 降位

## What to build

起草面「行内快读 + 边写边现」，喂上游数据源（spec K2/K5）。

- `useBatchTree(taskId, chat)`（`authoring/` 新 hook，可测）：
  - 触发重拉：① mount / taskId 变；② `task.version` 变（agent 写 phases 会 bump，spec_field_update 驱动）；③ **R1 侦测**：`chat.toolCalls` 里 `status` 转 success/ended 且 `isScratchWrite(name, input)` 命中 → debounce 800ms 拉一次；④ `chat.streaming` true→false 转空闲 → 拉一次（漏网兜底）。
  - `isScratchWrite(name, input)`：`name ∈ {Write, Edit, MultiEdit, NotebookEdit}` 且 `input.file_path/notebook_path`（字符串，含绝对或相对）经归一含 `.scratch/`；纯函数 export 供单测。
  - 返回 `{ batches, loading, error, refresh }`，透传给票 02 的 `DraftBatches` + 票 04 展开行 + 入队清单。
- Phase 行 ▾ 展开（`workflow-box.tsx`，K 内联快读，**不弹新窗**）：行下展开区显示
  - spec 磁盘灯：`spec.md ✓ <bytes>·<mtime>` / `✗ 未落盘`（读 batches 对位 files）
  - 票 chips：`issues/*.md` 文件名（可点→`PhaseSpecDialog` 复用票 02 路径）
  - 摘要：`getHomeFile(specPath)` 首屏文本前 ~200 字 + Key Decisions 表行数（正则数 `|` 行，容错），展开时懒取
- 入队清单 `rowSpec` 升级（`authoring-workspace.tsx` v4Rows，K5）：tree 加载成功 → 逐 phase：其 specPath 归一后命中某 batch.files 才算 ✅；未命中 → ⏳（文件没落盘，不算绿也不算红，提示「spec 未落盘」）；tree error/未载 → **退化为现字符串非空判定**（端点故障不冻结面板）。
- manifest 降位（`output-viewer.tsx`，PP3）：行标题「任务清单」→「规格快照 (manifest.json)」，副标题「agent 读的规格账本 · 核对/调试」，弹窗底部导语加一句「你在上面各区看到的 phases/票/决策即此文件的渲染；此窗用于核对 agent 视角」。resources chips：v4 且 `spec.resources`/`authoring_resources` 非空 → 顶栏徽章区各加小 chip（hover 全名），空则不显（K3）。

## Blocked by

票 01（契约）、票 02（DraftBatches 组件挂载点 + 弹窗复用路径）。

## Status

done

## Exploration

**Analog studied**：`authoring-workspace.tsx` 既有两个 SSE useEffect（spec_field_update→onMutated；订阅 idiom）作 debounce-refresh 样板；`useAgentChat` 返回 `toolCalls: ToolCallRecord[]`（`{name,input,status}`，types.ts:42）+ `streaming: boolean`——R1 消费这两个；`ToolCallRecord.input: unknown`（useAgentChat 原样存 SSE data.input，形态随 SDK Write 工具入参 `{file_path,...}`，非嵌套，实测归一函数需容错）。v4Rows useMemo（:317）已持 phases+catalog，加 batches 依赖即可。

**R1 事件时序核验**：toolCalls 在 `onToolCall` 逐条 push（status 先 'start' 后 'result'），文件在其间已落盘（server 侧 Write 工具执行完才回 result）→ 侦测转 success 后拉即可见；800ms debounce 合并连写多文件（一次拆批 N 张票）为 1 次 GET。

**摘要容错**：getHomeFile 404（未落盘）→ 摘要区显空态不报错；>512KB 或读取失败 → 只显灯不显摘要。归一 `./x` 与 `x` 与 `\x` 同 listHomeDir posix 化口径。

## Acceptance Criteria

^- [x] AC1: `isScratchWrite` 单测——Write/`.scratch/a/b.md`→true、Edit 绝对路径含 .scratch→true、Write 到 `artifacts/x.md`→false、Bash→false、input 非对象/缺 file_path→false
^- [x] AC2: useBatchTree 集成——toolCalls 注入一条 Write .scratch success→debounce 后 refresh 恰 1 次；streaming true→false→refresh 1 次；version 变→refresh（fake timers）
^- [x] AC3: Phase 行 ▾ 展开渲染 spec ✓/✗ 灯 + 票 chips（喂 batches）；点票 chip 开弹窗 GET 正确 URL
^- [x] AC4: rowSpec 三态——tree 全命中→✅、部分未命中→⏳+提示、tree error→退化字符串判定（回归现行为）
^- [x] AC5: manifest 行改名/副标题/导语断言；v4 resources 非空→顶栏 chip 渲染、空→不渲染

## Verification

`npx vitest run components/tasks/authoring`；新 `__tests__/use-batch-tree.test.ts` + `workflow-box.test.tsx`/`authoring-workspace.test.tsx` 追加用例。基线 51 不红。
