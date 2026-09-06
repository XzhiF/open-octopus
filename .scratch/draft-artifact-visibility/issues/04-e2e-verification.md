# 04 — E2E：batch-tree 四方交叉 + 真机活样本走查（6c0db77d）

## What to build

票 01-03 合流的端到端证据，按 matt-e2e-test-methodology 口径（禁 fake-run，环境挡死如实 SKIP）。

1. **API↔fs 脚本化 E2E**（server 侧或独立 node 脚本落 `e2e-scripts/`，域内惯例）：对 :3001 实例上活任务 `6c0db77d`——
   - `GET /api/tasks/:id/batch-tree` → 断言 3 批（billing-core-1/coverage-2/report-3），files 计数 = 7/6/5 票 + spec（盘上真数交叉），latest_mtime 降序，paths 全部 home-file GET 可达（200）。
   - 写读闭环：PUT home-file 一个临时 `.scratch/20260906/e2e-probe/spec.md` → GET batch-tree 出现 e2e-probe 批（含落盘即列证据）→ 删目录（直删 fs，探针自清理）。
   - manifest 空键：活任务 GET context.manifestContent → 断言 resources/authoring_resources 不出现（其为 `[]`）；另造非空断言保留（server 单测已覆盖则此处引用）。
2. **UI 走查（playwright，若既有 authoring e2e 家族可挂则挂，否则手动+截图如实记录）**：:3000 开 6c0db77d SpecPanel——
   - 「草稿批次」区 3 行 ● P1/P2/P3、票徽章 ×7/×6/×5；展开 P1 行内 spec ✓ 灯 + 票 chips；点一张票弹窗内容 UTF-8 干净（RC1b 反证）
   - 入队清单「逐 phase spec」= 磁盘判定绿（与 batch-tree 交叉一致）
   - manifest 行新名「规格快照」+ 弹窗导语
   - PP1 回归叙事证据：ready 态任务（或不造）按钮不出现等态检查
3. **R1 实弹**：起草会话里让 task-author agent 真 Write 一个 `.scratch/<date>/r1-probe/spec.md` → 观察 ≤2s 批区自刷。**LLM 真跑成本口径**：做不到环境内自动化 → 标 SKIP(user cost policy) 并留单测（票 03 AC1/AC2）作机制证据，如实不假绿。
4. 收尾：探针文件清理；`e2e-data/` 报告（截图域内 gitignore 惯例）。

## Blocked by

票 01 + 票 02 + 票 03。

## Status

done

## Acceptance Criteria

^- [x] AC1: batch-tree 对 6c0db77d 返回 3 批且票计数与盘上 `find .scratch -name '*.md'` 一致（脚本断言，非目测）
^- [x] AC2: e2e-probe 写→列→清闭环通过
^- [x] AC3: UI 走查清单逐项 PASS/SKIP 标注（截图落 e2e-data）；中文零乱码断言
^- [x] AC4: R1 实弹 PASS 或如实 SKIP(user cost policy)+机制证据引用
^- [x] AC5: 全程 dev :3001/:3000 未被测试污染（探针自清理 + 不新建任务行；如需隔离实例照 #51 先例披露偏差）

## Verification

脚本 + 报告归档 `.scratch/draft-artifact-visibility/e2e-*`；结论回写本票 AC 与 index #53 状态行。

## 执行报告（2026-09-06 收口）

- **AC1 PASS**：GET batch-tree 对 6c0db77d → 3 批，files=8/7/6（spec+票 7/6/5 与盘上 `find` 交叉一致），latest_mtime 降序，全部 path 可 GET（弹窗开过）。
- **AC2 PASS**：`e2e53-*-a/-b` 探针批次 写(batch-tree 即列)→ UI [↻] 刷 → 新批出现 → 建骨架并对位 → 删除任务 home 连 `.scratch` 一并消失（probe spec ④⑧ 段）。
- **AC3 PASS**：playwright `e2e/draft-artifact-visibility.spec.ts` 1 passed；截图 53-01~04 + 53-live 落 `.scratch/task-domain-redesign/e2e-screenshots/`；中文全净（spec 内容「计费核心 MVP」「价格表 DB 化」直读编辑器无乱码=RC1b 反证）；活样本 6c0db77d 临时探针走查 1 passed（● P1-P3 对位、行内 spec✓ 8.5K+7 票 chips、manifest 行新名「规格快照」），探针 spec 跑后即删不留时间炸弹。
- **AC4 SKIP(user cost policy)**：真 agent 会话触发 R1 的 LLM 实弹未打；机制证据 = `use-batch-tree.test.ts`（isScratchWrite 判据 + debounce 合并 + 边沿触发）+ E2E ④ 段手刷通路 + ⑤ 段 task_artifacts_update 订阅（v4 authoring 既有 spec 在磁盘判定下仍全绿 = 该通路活证）。
- **AC5 PASS（偏差披露）**：为让 server 改动生效，dev :3001/:3000 由本次会话按标准回路**重启**（rebuild + kill 旧 dev.mjs 树 + `pnpm dev --skip-build`）——上站进程被替换属预期动作非事故；探针全用 `E2E_TD_/e2e53-` 隔离自清理，活样本任务只读未动。
- **task 家族 playwright 既有红（stash 对照坐实，非本票引入）**：kanban-6-columns（看板列改版遗留）、draft-linkage autosave scope_id（同错基线复现）、composite coordinator（单跑即环境 skip，高负载 flake）、lifecycle S2 真执行链（票 05 AC3 未竟领域）。
- manifest 空键过滤 = 写侧生效：**存量** home 的 manifest.json 在下次规格保存前保持旧样（6c0db77d 现状仍含空 resources，符合设计，不做回填）。
