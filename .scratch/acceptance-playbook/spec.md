# Spec: 验收面 v2.1 — 验收剧本(Playbook)+ 跑起来看(Live Preview)

> 单一真相源,供开发/自审/e2e 消费。决策全量见 `brief.md`(D1-D10)+ 原型 `.scratch/20260917-acceptance-playbook-proto/prototype.html`。
> 架构决策记录:`docs/adr/0022-acceptance-playbook-live-preview.md`。
> 上游:验收面 v2 验货台(round-evidence-service.ts,2026-09-16)— 本 spec 是其 v2.1 增量,同哲学:**派生视图不入库 / 纯解析零 AI / 用户按钮触发 / 机写证据**。

## Problem Statement

验货台 v2 解决了「改了什么(实物 diff)」和「自动跑一遍(当场复检)」,但复杂功能的验收仍断在两步:

1. **看不见** — 待验收轮的工作区明明活着,用户却没法一键让项目"跑起来"在真 UI 上检验功能;v2 头注释里「真项目跑起来」是 v2.1 预留锚点。
2. **没指引** — 「这一轮该验什么、预期是什么」散在 spec.md AC、末张 e2e 票、e2e-test-plan.md、round-report 四处 markdown 里,验收人要自己翻叙述 tab 拼图;无 UI 的 phase 同样缺"编译好的校验清单+预期"。
3. **无闭环** — 人工判定(通过/不过/跳过)在 UI 里没有落点:不驱动票状态、不进下一轮、不留证据链。且执行控制台与验货台**双入口决策**(phase-surface:353 verdict 行直通 postAcceptance 无确认、无证据),决策可以绕过一切证据被按下。
4. **太臃肿** — 5 个嵌套滚动区 + 360px 右栏塞满执行摘要(token/cost),真正的验收动作(走查)反被挤到视线末梢。

## Solution

**验收剧本**:服务端把 awaiting 轮的契约文件(spec.md / 末张 `NN-e2e-*` 票 / e2e-test-plan.md / round-report.md / 上轮 checks)**编译**成票级走查清单(≤8 步,预算爆表自动降档),每项带「操作 + 预期 + 反假跑」;勾选落批次目录 JSON;✓✗⊘ 各有硬下游(销账 / 通过拦+票重开 / 下轮 carryover);通过瞬间机写 `acceptance-ledger-r{N}.md` 完成证据链。
**跑起来看**:`acceptance_preview` spec-field(命令+url+可选 readyPattern)→ BashExecutor 在活工作区起长驻进程 + 探活 + `task_preview` SSE;只「启动/浏览器打开/停止」,无 iframe;决策确认时自动 stop 并记入 ledger。
**界面重构(A′)**:实物 tab 变剧本流 ①实物②复检③预览=一行状态条内联展开、④走查=主角;右栏 240px 只剩进度+三颗决策钮(确认层三式);token/cost 撤出验货台、AI 消耗卡在控制台置顶并按「总计/按模型/分轮」三层完整七量纲还原;控制台 verdict 行删除,决策唯一入口=验货台;全界面单滚动纪律。

## Projects Involved

- [ ] `@octopus/shared` — `acceptancePreviewSchema` + `TaskSpec.acceptance_preview` + SPEC_FIELDS 白名单 + `TASK_PREVIEW_EVENT` 常量
- [ ] `@octopus/server` — RoundEvidenceService:+getPlaybook 编译器 / preview 生命周期 / writeLedger / reopenTickets;routes:GET /:id/playbook、POST+GET /:id/preview、POST /:id/preview/stop、acceptance body +reopen_tickets、accept 后 ledger 钩子
- [ ] `@octopus/web-app` — tasks-api 客户端 / lib 类型镜像 / playbook-panel / preview-bar / ledger-confirm-dialog / acceptance-surface A′ 重构 / verify-panel+round-diff-panel 拆嵌套滚动 / phase-surface 撤 verdict 行 / execution-summary AI 卡三层化
- [ ] `@octopus/core-pack` — 不改动(票纪律升格走另单)

## Data Contract(锁定,开发不得偏)

### S1 shared

```ts
// scheduler-job.ts (acceptanceVerifySchema 旁)
export const acceptancePreviewSchema = z.object({
  command: z.string().min(1).max(4000),
  cwd: z.string().max(500).optional(),
  url: z.string().min(1).max(200),            // 探活+外链目标, http(s)
  readyPattern: z.string().max(500).optional(), // 可选 stdout 正则(双保险)
})
// TaskSpec: acceptance_preview: acceptancePreviewSchema.optional()
// task.ts SPEC_FIELDS + validateSpecFieldValue case "acceptance_preview": null→undefined 否则 parse(与 acceptance_verify 同款)
// constants: TASK_PREVIEW_EVENT = "task_preview"
```

### S2 playbook 编译器(GET /api/tasks/:id/playbook,409=无 awaiting)

输入(批次目录,`batchRelDir` 解析;缺任一 → `coverage.missing` 记录,不崩):
`spec.md`(AC Mapping 表)、`issues/NN-e2e-*.md`(末张:Verification type/steps bash 块/Pass criteria/AC 列表)、`e2e-test-plan.md`(Step 块:页面/操作/断言/反假跑)、`round-report.md`(「票执行摘要」「Spec 修订」节 → 每步 goal/⚠标注)、`acceptance-checks-r{N-1}.json`(carryover)。

```ts
interface PlaybookPayload {
  available: boolean           // 至少一个来源编译出内容
  goal: string                 // round-report 首行 / phase 描述回退
  budget: { steps: number; estMin: number; over: boolean; degraded: boolean }
  sections: Array<{
    kind: "walk" | "probe" | "claim"      // UI走查步 / 命令探针(票 bash 块) / AC 断言核对
    title: string                          // 票号/计划名
    source: string                         // "issues/11-e2e-x.md" 等
    items: Array<{ id: string; op: string; expect: string; evidence?: string; probe?: { command: string } }>
  }>
  finePrint: Array<{ ticket: string; acs: string[] }>   // 折叠的 AC 级细目(不勾选)
  carryover: Array<{ id: string; fromRound: number; decision: "skipped"|"failed"; note?: string; op: string; expect: string }>
  coverage: { found: string[]; missing: string[] }
}
```

规则:items 按**票**归并(一票一节,每票 ≤4 条,全剧本 ≤8 步);爆表 → 降级为故事级(每票 1 条,`degraded: true`);item id = `pw:<ticketBase>:<seq>` / 计划步 `pp:<n>` / carryover `co:<origId>@r<N>` —— **跨刷新稳定**(勾选键)。

### S3 勾选与台账

- 勾选调 `PUT /:id/home-file`(**零新端点**),path=`<batchRelDir>/acceptance-checks-r{N}.json`,body `{version:"1",checks:{[itemId]:{decision:"pass"|"fail"|"skip",note:string,at:iso}}}`;换轮新文件;读走 `GET home-file?path=`。
- 台账:`acceptance-ledger-r{N}.md`,routes 层 acceptance POST **成功返回后**调 `evidence.writeLedger(taskId, decision)`(fire-safe:失败 warn 不翻转决策)内容 = 实物聚合 + 最近 verify 会话 + checks 摘要(✓/⊘+原因/未决)+ preview 会话(存活时长)+ 决策人时刻。机写、不可改、进叙述。
- 票重开:acceptance body 新增 `reopen_tickets?: string[]`(票文件名基);rejected 分支把 `<batchRelDir>/issues/<name>.md` 的 `## Status` 下 `done` → `reopened`,并把 fail 项(op/expect/note)**追加**进 fix-feedback-r{N}.md 的「## 未过项(验收台剧本 ✗)」节(扩展 writeFixFeedbackArtifact 的 content,或 evidence 侧二次 append,择一实现,行为=反馈文件里必须有这节)。

### S4 preview 生命周期

- `POST /:id/preview` → 202 {state:"starting"};闸门同 verify:awaiting 存在 / 配了 preview(400)/ 无在跑会话(409)/ 工作区在(409)/ cwd 不逃逸;命令里 `$vars.`/`${x|}` 撞引擎替换语法 → 启动前 400(与 verify 同纪律,verify 现在只在文案提醒,preview 一并校验)。
- BashExecutor 长驻:timeout 硬顶 7200s;stdout 尾行过 `readyPattern`(配了才判)且 probe `GET url`(任意 HTTP 响应 = 端口起)→ state `ready`;进程退出 → `exited`(带 exit_code);SSE `task_preview` {task_id,state,url,external?,exit_code?}。
- `GET /:id/preview` → 有会话给会话态;**无会话先探一次 url**(800ms 超时):通 → `{state:"ready",external:true}`(用户自己 pnpm dev 起来了,面板如实显示可打开/无需停);不通 → `{state:"stopped"}`。
- `POST /:id/preview/stop` → SIGTERM 树杀 → `stopped`;accept/reject/abort 三决策时 routes 层自动 stop(记录进 ledger 的 stop_note)。preview 会话内存,重启失,同 verify 哲学。

### S5 UI(A′ 定稿,还原基准 = 原型 #view=console|accept 两屏)

- 实物 tab 顺序 ①RoundDiff 状态条 → ②Verify 状态条 → ③Preview 条 → ④Playbook 主角卡(`rounded-[13px] border-[2.5px] shadow-pop` + 头 `bg-pop-amber-soft` 语义的「人工走查 · 按票编译」)。①②③点击卡头**内联展开**,详情不设滚动盒。
- 右栏 `w-[360px]`→`w-[240px]`:删 `data-acceptance-col-summary` 整块与 TaskAiUsageCard 及 fetchLLMCalls;`data-acceptance-col-actions` 保留(通过/打回/中止 + autoAdvance + rejectedSeam 回显 + ImpactApprovalList 原样迁移)。**三锚点 testid 语义保持**(见兼容性)。
- 确认层三式(复用 `components/scheduler/confirm-dialog` / ui AlertDialog):通过=Ledger 预览确认弹层(内容即最终 ledger 摘要 + 未决项列表;有 fail 项时通过钮 disabled);打回=既有 Dialog + fail 项自动预填反馈 + 收集 `reopen_tickets`;中止=destructive 确认。
- 单滚动:verify-panel console `max-h-[280px] overflow-auto`→ 尾 15 行内联 + 「完整看 verdict」;round-diff PatchBlock `max-h-[420px]` 与叙述 round-report `max-h-[420px]` → 去掉内滚随页滚。
- 控制台:phase-surface :353-372 verdict 行删,原位置「→ 去验货台验收」CTA(`ctx.openAcceptance`);TaskAiUsageCard 迁 phase-surface 主列**最顶**(在 P 头部 section 之上/之下取 LIVE 语义:放第一块),三层七量纲(总计瓷砖 / 按模型行 / 分轮行,行式= AggInline 同款串)+ 编写期开关;缺数灰显注。

### S6 兼容性(还原≠破坏)

- 保留锚点:`[data-acceptance-modal]`、三列 `data-acceptance-col-*`(summary 列改为进度卡承载,或 testid 挂 actions 内新进度块——e2e `toBeVisible` 三列断言必须仍可过)、验货台 `data-testid="acceptance-approve"`(成为唯一 approve 锚)。
- 控制台 approve 的 e2e(`task-phase-acceptance.spec.ts:487,572`、`task-phase-lifecycle.spec.ts:722,775`)改为:先切验货台 tab 再点 approve(或 `page.click('[data-testid="acceptance-approve"]')` 天然唯一)。
- 打回既有流(next_flow 二分/fix-feedback 命名/autoAdvance)**零行为变更**,只增字段。

## Feature Scope

**Do:** S1-S6 全部 + 票纪律文档行(core-pack task-author 不动)。
**Don't(P2+):** api-probe「▶单跑」;iframe;自动起 preview;剧本 AI 生成;Top3 节点缺数据时不扩 observability 聚合端点(见 T10 降级);checklist 细目层勾选;matt-spec-dev 预填 acceptance_verify/preview(另单)。

## Acceptance Criteria(故事级,每条带验证方式)

- **AC1 剧本编译**:对 fixture 批次目录(spec+末张 e2e 票含 4 AC+bash steps+e2e-test-plan 2 steps+round-report),`GET /:id/playbook` 返回按票归并 ≤8 步、每 item 有 op+expect、finePrint 含全部 AC、id 稳定;缺全部文件 → available:false + coverage.missing 全列、HTTP 200 不崩。**验证:server 单测(vitest,fixture 目录)**
- **AC2 勾选闭环**:PUT home-file 写 checks-r1 → GET 读回;✗ 项在面板使通过 disabled、reject 提交后 fix-feedback 含「未过项」节且对应票 Status=done→reopened;⊘ 项出现在下一轮 playbook.carryover(同 batch 目录 r2 编译时读 r1)。**验证:server 单测 + 组件测;人证见 E2E**
- **AC3 台账**:通过决策后 `<batch>/acceptance-ledger-r{N}.md` 存在,含实物/复检/预览/走查计数/决策行;叙述 tab 文件列表可见(SSE 后重拉)。**验证:server 单测**
- **AC4 预览**:配置 preview 命令后 start→(真 bash 起 http 服务)→GET/ SSE 报 ready→stop 后端口释放无残留;工作区不在→409;外部进程占 url 时 GET 报 external:true;决策时自动 stop。**验证:server 单测(python3 -m http.server 或 node 内联 server)**
- **AC5 双入口撤除**:控制台无 approve/reject 按钮,「去验货台」CTA 切 tab;验货台决策全过确认层(中止无 confirm 路径不存在)。**验证:组件测 + 既有 e2e 两 spec 更新后过**
- **AC6 AI 消耗三层**:控制台首卡含 总计 7 瓷砖 / 每模型 ∑↑↓⚡🗡️+calls+$ 行 / 每轮同式行;验货台不再出现 token/cost。**验证:组件测(execution-summary)+ 目检截图**
- **AC7 UI 还原度【用户硬标准】**:dev 栈真数据下,两屏与原型 `#view=console`/`#view=accept` **逐项对齐**:pop token(border-2.5px/shadow-pop/stamp 旋转贴/marching-ants)、A′ 分区占比(走查主角、右栏 240)、状态条展开交互、后果条三色、确认弹层版式、AI 卡七量纲;整窗每屏**恰好一根**滚动条(`getElementsBy*` 遍历 overflow 断言 + 截图留证)。**验证:Playwright 截图 + vision 比对 + 滚动盒审计脚本,e2e-screenshots/ 留档**
- **AC8 靶子实测**:workspace 挂 octopus-demo-api-admin(+parent java-common 已装 .m2),极简需求(见 E2E-Scenario)真跑一轮到 awaiting_review,验收台完成 剧本→勾选→预览 mvn→通过→台账 全链。**验证:E2E(browser 走查票,截图+ledger 为真通过条件)**

## E2E Scenario(票 11,唯一 browser 票)

**极简需求(靶子侧,写入 task spec)**:octopus-demo-api-admin 新增 `StatusController`:`GET /api/status` → `R<StatusVO{app:"api-admin",java:系统属性,uptimeMs}>`,+ MockMvc 单测,+ `src/main/resources/static/index.html`(fetch /api/status 渲染状态卡,页面即预览产物)。
**前置**:workspace `create demo-java` 注册 octopus-demo-api-admin(+octopus-demo-java-common);`mvn -N install` common BOM 进 .m2;jdk/maven 在 PATH。
**走查步**:创建任务(v4,单 phase 2 票)→ 入队绑定 matt-spec-dev → R1 完成后开验货台 → 断言:剧本从票编译(≥3 步含预期)/勾选+刷新持久/▶预览 `mvn spring-boot:run` ready → ↗ :8080 看到状态页 / 标一项 ⊘ → 通过弹层列未决 → ledger 落盘 / 重开轮验证 carryover 重现。**反假跑**:ledger/checks 文件为 server 产物(grep 断言),预览真端口响应(curl /api/status),截图落 e2e-screenshots/。

## Execution Decisions(用户已裁)

单 phase 自开发(主 agent 直做,不走并发 runner / 不对抗审);E2E=做(AC8,java 靶);还原度硬门槛 = AC7。

## 票 DAG(实现顺序)

```
T01 shared ─┬─ T03 preview ──────────┐
            ├─ T07 web preview-bar ──┤
T02 playbook-compiler ─┬─ T04 ledger+reopen ─┐
                       └─ T05 web api ─ T06 playbook-panel ─┐
T09 confirm三式 ← T08 surface A′重构 ←──────────────────────┘
T10 console(AI卡+撤verdict) [独立]
T11 e2e(browser,靶子实测)← 全部
```
