# 02 — web：「草稿批次」直扫区（对位 ●/○ + 建骨架 + 弹窗复用）

## What to build

右栏新组件 `draft-batches.tsx`，插在「Phase 计划」与「执行产物」之间，仅 v4 渲染（spec K1/K4/K6/K7）。

- client：`tasks-api.ts` 加 `getBatchTree(taskId)` + `BatchTreeEntry` 类型（照 `HomeFileListingEntry` 手写法，shared 零改动）。
- 区结构：
  - 区头：`草稿批次` + 计数 + `.scratch/<…>/` 路径行（截断+复制，抄执行产物区 artifactsDir 行 idiom）+ 手刷 [↻]。
  - 批次行：`slug` · `spec ✓/✗`（批内是否有 `spec.md` 直放文件）· `票 ×N`（`/issues/` 下文件数，`-e2e` 结尾票单列标记）· 对位态：任一 phase 的 specPath 归一后以 `<dir>/` 为前缀 → `● P<i>`；否则 `○ 未对位` +（仅 draft）[建骨架并对位]。
  - 行 ▾ 展开：文件 chips 复用 `specFileClass`（import 自 phase-spec-dialog，分组序照 sortedFiles 样板）；点文件 → 开 `PhaseSpecDialog`。
  - 警示行：phases 中 specPath 归一后在 tree 里找不到对应批次文件的 → 区头下「⚠ 已登记未落盘：P1, P3」（US3 反向账）。
- 孤儿批次浏览：`PhaseSpecDialog` 现签名吃 `TaskPhase`——**零改动喂合成对象**（见 Exploration），孤儿批次点文件同样可开可编（home-file PUT 白名单本就按路径不按 phase）。
- [建骨架并对位]（K6）：`getHomeFile(dir/spec.md)` → 取首行 `# ` 标题作 name（失败/无 → slug）→ `withPhases` 追加 `{index: next, name, slug, specPath: "./"+dir+"/spec.md", workflowRef: "built-in/matt-spec-dev", inputValues: {batch_dir: "${phase.batch_rel}"}}`；slug 撞既有 phase → toast 拒绝（同 AddPhaseRow 判重）。

## Blocked by

票 01（端点契约）。

## Status

done

## Exploration

**Analog studied**：`workflow-box.tsx` PhaseRow（卡结构/badge/按钮行）、`phase-spec-dialog.tsx`（specFileClass/sortedFiles/弹窗喂法）、`output-viewer.tsx`（区壳 rounded-lg border + 路径行 + SSE 重拉 effect）、`authoring-workspace.tsx` v4Rows（specPath 归一口径）。

**合成 TaskPhase 喂弹窗的核验点**：PhaseSpecDialog 内部仅用 `phase.specPath`（三处：normalizeRel/batchDirOf/isUiEditableSpecPath）+ `phase.index`/`phase.name`（纯标题渲染）——合成对象 `{index: 0, name: slug, slug, specPath: dir/spec.md, workflowRef 占位, inputValues: {}}` 全表达式安全；「创建骨架」按钮走 `specSkeleton(phase)` 模板只用 index/name/slug，孤儿批次显 `Phase 0: <slug>` 标题属可接受降级（实现时若有更干净的最小 prop 化也允许，不扩组件行为）。

**specPath 归一**：web 已有 `normalizeRel`（phase-spec-dialog.tsx:50，未 export → 提到 shared helper 或在 draft-batches 内联同款，两处同规则即可，注意 agent 写的绝对路径 specPath 永远不匹配相对 tree → 自然落「未落盘」，正确）。

## Acceptance Criteria

^- [x] AC1: 喂 3 批 tree（1 批 spec✓票×7、1 批无 spec、1 批未对位）→ 行/徽章/对位态/警示行渲染正确（testing-library）
^- [x] AC2: ▾ 展开出文件 chips（spec 在前票在后），点 spec.md → PhaseSpecDialog 打开且 GET 打到正确路径（fetch mock 断言 URL）
^- [x] AC3: ○ 未对位 + draft → [建骨架并对位] → 断言 PUT phases body：name=spec 首标题、slug、specPath、matt-spec-dev、batch_dir 骨架；v4 非 draft（ready 态）→ 按钮不出现
^- [x] AC4: 非 v4 任务整区不渲染；tree 加载中 spinner / 失败错误行 + [↻]（错误不炸面板其余区）

## Verification

`cd packages/web-app && npx vitest run components/tasks/authoring/draft-batches`；新文件 `__tests__/draft-batches.test.tsx`（fetch stub 样板抄 `workflow-box.test.tsx`）。authoring 基线 51 绿不红。
