# Spec: 起草面产物可见性 — 磁盘直扫「草稿批次」区 + Phase 行内展开 + R1 边写边出

## Problem Statement（dogfood 用户原话三痛点，2026-09-06 点线图会话定稿）

v4 起草面（TaskModal → AuthoringWorkspace 右栏）里，agent 写到磁盘 `.scratch/` 的批次产物（spec.md + issues/ 票）**用户看不见**：

1. **PP1「批准了却没出来」**：可见性被 `task_spec.phases[]` 门控——agent 用 Write 工具直写 16 个文件落盘，磁盘 → UI 没有任何线；只有 agent 再走 spec-field API 写 phases[] 才出行。用户心智 =「写了 = 该看见」，与「先契约后展示」正冲突。RC2（agent 漏写 phases）把这条放大成全盲。
2. **PP2「点小图标弹窗」**：即使有行，spec/票唯一入口 = phase 行末 14px `FileText` → `PhaseSpecDialog`，三连跳才够到内容。
3. **PP3「manifest.json 有值没展示」**：manifest 是 task_spec 的磁盘影子（server 每次规格保存重写，**唯一真消费者 = agent**，rules 文件指它替代 curl；server 逻辑零读回）。其字段级人话展示面不全，用户只能开 raw JSON 弹窗。

## Solution（三叉拍板 = C + R1 + manifest 保留降位）

1. **形态 C**：右栏新增「草稿批次」区——`GET /:id/batch-tree` 直扫 task home `.scratch/`，**绕开 phases[] 门控**，落盘即列（含未对位目录）；Phase 计划行同步支持 **▾ 行内展开**（spec 磁盘状态 + 票清单 + 摘要），弹窗降级为「深读/编辑」面。两区按 specPath 前缀**对位互联**（● 已对位 / ○ 未对位 + 建骨架 / ✗ 登记未落盘）。
2. **实时 R1**：前端侦测 chat 流里 agent 的 `Write/Edit/MultiEdit/NotebookEdit` 工具事件、`file_path` 命中 `.scratch` → debounce 重拉 batch-tree；`streaming` 转空闲再兜底重拉一次；区头 [↻] 手刷。**不建 server fs watcher（R2 出局）**。
3. **manifest 降位（PP3 收口）**：「任务清单」行改名「规格快照（agent 读的账本）」+ 弹窗加导语（它是 agent 侧账本，人看的是 ①②④⑤ 区）。写侧 v4 快照**只滤空数组噪音**（`resources`/`authoring_resources` 为 `[]` 时不落 manifest）。
4. **入队清单升级**：「逐 phase spec」行从「specPath 字符串非空」升级为「磁盘文件真存在」（batch-tree 喂），消灭假绿 ✅。
5. **对位闭环修 RC2**：未对位目录给 **[建骨架并对位]** —— 读 spec.md 首 heading 作 name 一键补 phase 行；反向「登记了没写盘」行显 ✗。agent 忘写 phases 从「只能催它」变成「用户看得见 + 一键补」。

## Projects Involved

- [x] packages/server（`task-home-service.ts` batchTree + manifest 写侧空键过滤；`tasks-service.ts` 委托 + 存在性 404；`routes/tasks.ts` GET /:id/batch-tree）
- [x] packages/web-app（`authoring/` 下：`workflow-box.tsx` 行内展开 · `draft-batches.tsx` 新组件 · `phase-spec-dialog.tsx` heading 泛化 · `output-viewer.tsx` manifest 行改名/导语 · `authoring-workspace.tsx` 状态提升 + R1 · `lib/tasks-api.ts` client；`lib/agent` 零改动）
- [ ] shared / engine / providers / cli / core-pack：**零改动**（batch-tree 响应类型照 `HomeFileListingEntry` 先例手写在 tasks-api，server 响应无 shared schema；SKILL/persona 不动——产物可见性属平台能力，spec 纪律不写 server 代码 ADR-0018 §6，反之 UI 改版不改纪律）

## Feature Scope

**Do:**
- server `batchTree(taskId)`：批次目录 = `.scratch` 子树中**直接含 `.md` 的目录**（约定 `.scratch/<date>/<slug>/`，兼容 `.scratch/<slug>/`——日期层无直放 .md 时其子目录各自成批）；每批 `files` = 该目录内递归 depth ≤2 的 `.md`（即 batch 内 `spec*.md` + `issues/*.md` 全见，更深不追）；全局 cap 300 文件；批次按 `latest_mtime` 降序；缺 `.scratch`/缺 home → `batches: []`（**空是正常态不是 404**，仅未知任务 404）
- `GET /api/tasks/:id/batch-tree` 路由（错误分类同 home-file 惯例：未知任务 404 前置、不建野 home）
- `writeManifestFile` v4 侧：`resources` / `authoring_resources` 为空数组时剔除（DB 行不动，非空保留）
- web `getBatchTree` client + `BatchTreeEntry` 类型
- 「草稿批次」区：批次行（slug · spec✓/✗ · 票×N · ● P_i / ○ 未对位 → [建骨架并对位]），展开 = 文件 chips 按 `specFileClass` 分组，点文件 → `PhaseSpecDialog`；区头路径行 + [↻]；「已登记未落盘」警示行（孤儿 phase 列表）
- Phase 行 ▾ 展开：spec 磁盘灯（size·mtime）+ 票 chips + 摘要（KD 行数 + 首段两行，展开时懒 fetch）+ [打开编辑器]；`FileText` 小图标保留为同一弹窗快捷方式
- `useBatchTree`（authoring-workspace 内）：mount/id 变 + task.version 变 + R1 侦测（debounce 800ms）+ streaming 空闲兜底 + 手刷；下传三区与入队清单
- 入队清单 `rowSpec` 行 = tree 已加载时按磁盘存在判定；tree 失败/未载 → 退化为现字符串判定（**不阻塞面板**）
- manifest 行改名「规格快照 (manifest.json)」副标题「agent 读的规格账本 — 核对与调试」+ 弹窗底部导语升级；resources/authoring_resources **非空时**顶栏小 chips（hover 列名）

**Don't:**
- server fs watcher / 新 SSE 事件（R2；现事件通道 + R1 已够，起草期文件写方=agent 会话本身，前端天然看得见）
- 行内嵌全文编辑器（阅读摘要行内、深读/编辑仍弹窗——★① 用户已认可）
- `.scratch` 以外目录直列（context.md/manifest.json/artifacts 各有既有端点，白名单不放宽）
- phases[] 信封结构 / K16 冻结（建骨架 = draft 期既有整数组 PUT 车道，无新语义）
- 看板/验收面/执行面 UI（本轮只动起草面右栏）
- manifest 人话视图表（用户在 AskUserQuestion 已裁「保留+改名降位」，不做第三视图）
- v3/legacy 任务形态（batch 区仅 v4 format 渲染）

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|----------|------------|--------|
| K1 | 可见性来源 | C：磁盘直扫区兜底 + phases[] 契约面保留，两区对位 | 「写了=看见」的用户心智由**磁盘源**兑现；phases[] 仍是入队/派发唯一契约（gate/K16 不动）；解耦后 RC2 类「agent 不写契约」不再演变成全盲 |
| K2 | 实时性 | R1 前端侦测（tool 事件 + 空闲兜底 + 手刷），无 watcher | 起草期写文件的进程就是 chat 会话——tool 事件已在流里，零 server 改动即可边写边现；watcher 属执行期需求（R2），当前无第二个高频写方 |
| K3 | manifest 字段分类修正 | `resources`/`authoring_resources` **不是死键**（agent spec-field 可写、dispatch 合入 workflow.requires / 注入起草会话，v4 活字段）；写侧仅滤 `[]` 空数组，读侧非空补顶栏 chips | 点线图会话曾误判为 v3 遗物；实现时核 shared schema（scheduler-job.ts:151-153 + TaskSpecFieldSchema）纠错——滤非空=删 agent 真写过的账，不可接受 |
| K4 | 文件查看复用弹窗 | batch 区点文件 = 复用 `PhaseSpecDialog`，加可选 `heading` prop 承接孤儿批次 | 弹窗枚举/分组/编辑/骨架已全功能（上站核实），只改入参不吃 phases 行；养第二个阅读器不值（★①） |
| K5 | 入队清单磁盘判定 | rowSpec = specPath 归一后命中 tree files；tree 异常退化字符串判定 | 现在 ✅ 是字符串假绿（specPath 写了文件不存在也绿）；入队被 server 409 `spec-missing` 打脸是断链体验；退化规则保证端点故障不冻结面板（★②） |
| K6 | 建骨架并对位 | ○ 目录 → 读 `<dir>/spec.md` 首 `# ` 标题作 name（缺/失败回退 slug），`specPath=./<dir>/spec.md`，workflowRef=built-in/matt-spec-dev（目录默认，可后改），整数组 PUT 追加 | 双向对位账（图 8）闭环；复用 `withPhases` S5 纪律；draft-only 天然（K16 合规）（★③） |
| K7 | batch-tree 契约 | 批次=直接含 .md 的 `.scratch` 子树目录；批内递归 ≤2；只 .md；cap 300；latest_mtime 降序；缺目录 `batches:[]` 200；未知任务 404 | 与 listHomeDir 守卫同族但**枚举权威在服务端一次成型**（客户端不再逐目录 list，省 N+1 往返）；空态 200 让前端免于区分「没有」与「没建」 |
| K8 | 交付纪律 | 产物可见性属平台能力可动 server（红线自查过）；spec 纪律仍不写 server；SKILL/persona 零改动 | ADR-0018 §6 分界：UI 是平台的眼，SKILL 是 agent 的手——本次只修眼 |

## User Stories

- **US1 落盘即现**：起草对话里 agent 写完 `billing-core-1/spec.md`（哪怕 phases[] 仍空）→ ≤2s 右栏「草稿批次」出现该批次，展开可见 spec+票文件；点文件开编辑器，可编辑保存回磁盘。
- **US2 行内快读**：Phase 行 ▾ 展开 → spec 磁盘灯（✓ size·mtime）+ 票清单 chips + KD 行数/首段摘要；[打开编辑器] 才进弹窗（小图标跳深读保留）。
- **US3 对位闭环**：孤儿目录 ○ + [建骨架并对位] 一键出 phase 行（name=spec 首标题，绑定默认值可改）；「登记未落盘」phase 在区头警示 + 行内 ✗，agent 补写后自动转 ✓。
- **US4 真绿清单**：入队清单「逐 phase spec」仅在磁盘真在时 ✅；tree 拉取失败行显 ⏳ 退化态不冻结。
- **US5 manifest 归宿**：行名「规格快照 (manifest.json)」，弹窗导语说明「agent 读的账本，人看各区」；v4 空 resources/authoring_resources 不再出现在快照里；非空时顶栏见 chips。
- **US6 执行期无扰**：执行产物区/运行记录/决策备忘行为与文案分工不回退（RC3 的「执行产物」命名保留）。

## Verification Strategy

| US | 判据 | 层 |
|----|------|----|
| US1 | server：`tasks-batch-tree.test.ts`（复用 tasks-home-file harness：真路由+tmp home+嵌套布局 fixture——约定层级/扁平层级/非 md 过滤/深度截断/cap/空态 200/未知任务 404 不建野 home）；web：`draft-batches.test.tsx`（tree→行渲染、对位 ●/○、展开 chips、点击开弹窗） | API↔fs |
| US1 实时 | web：`useBatchTree` 纯函数判据 `isScratchWrite(toolCall)` 单测（Write/Edit 命中、Bash 不触发、路径归一）+ debounce 重拉 mock 断言 | 组件 |
| US2 | web：`workflow-box.test.tsx` 追加：▾ 展开渲染 spec 灯/票 chips/摘要（fetch mock 喂 spec 样例） | 组件 |
| US3 | web：建骨架流单测（getHomeFile 喂 heading → withPhases PUT body 断言 specPath/name/workflowRef）；警示行渲染 | 组件 |
| US4 | web：rowSpec 三态单测（tree 命中 ✅ / 未命中 ⏳→✗ 语义 / tree 失败退化字符串） | 组件 |
| US5 | server：manifest 写侧空键剔除 + 非空保留单测（真 home 读文件断言）；web：行名/导语/ chips 快照断言 | API↔fs / 组件 |
| US6 | 既有 authoring 套件全绿（基线 51 不红即为回归判据） | 回归 |
| 端到端 | 票 04：真机 :3000 开 `6c0db77d`（活样本 version 9 三批次盘上全在）→ 直扫区 3 行 ●、展开票 7/6/5、入队清单真绿、manifest 新名；agent 会话实写一发小文件验 R1（LLM 真跑按成本口径如实标） | 四方交叉 |

## Execution Decisions

| # | Decision | Choice | Reason |
|---|----------|--------|--------|
| 1 | Story Walk-Through | skipped | 点线图会话已走完数据流全链（图 1-2 即穿线产物），断点已定位到行号 |
| 2 | E2E Verification | run（API↔DB↔fs↔UI 四方 + 真机活样本走查）；agent 真会话触发 R1 的 LLM 实写按口径如实标 SKIP/手动 | 与 #51 同成本口径：不建真 LLM 全链任务 |
| 3 | 票执行方式 | 主会话直实现（用户「动手吧」） | 票间强耦合（类型/组件互喂），拆 runner 反而接缝成本 |

## 风险与另案

- `.scratch/` 根若有巨型非批次子目录（用户手放）→ cap 300 + 只认「直接含 .md 的目录」双闸；仍慢属性能另案，不阻塞本票。
- R1 对 Bash 重定向写盘不可见（SKILL 配方已统一 Write→@file，主流覆盖）；[↻] 手刷兜底，文案如实写。
- 未接 `task_artifacts_update` 起草期发射（执行期语义保留原样）——R1 替代了对该通道的依赖，不新增。
