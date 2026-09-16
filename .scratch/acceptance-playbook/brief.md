# Brief: 验收面 v2.1 — 验收剧本(Acceptance Playbook)+ 跑起来看(Live Preview)

> 2026-09-17 · 分支 octopus-feat-task-exec-tree · 上游 = 验收面 v2「验货台」(2026-09-16, round-evidence-service.ts)
> 决策来源 = 本会话 grill 全程 + 原型三轮(v1 颗粒度/预览入口 · v2 真皮肤/占比/单滚动 · v3 两屏定稿)。
> 原型(一手证据): `.scratch/20260917-acceptance-playbook-proto/prototype.html`(#view=console|accept)

## 用户原话锚

- 「复杂功能不是跑完单元/集成测试就完事…就想看到实际项目运行,在 UI 上检验功能」
- 「还需要一定的指引,告诉我应该怎么对这一轮 phase 成果进行校验,预期是什么 —— 有没有 UI 的 phase 都该有」
- 「标记(✓✗⊘)对后续操作有什么影响?要考虑闭环用途,不然就是纯纯花架子」
- 「内嵌 iframe 不整,界面已经很臃肿」「不要搞太多固定区域,出现很多个滚动条」
- 「突出核心验收(区域占比)」→ 选 A′;「执行摘要的 token 信息去掉,完善回执行控制台」;「控制台的验收通过/打回按钮不能要」;「决策按钮都要 confirm」;「AI 消耗每层完整七量纲(总/入/出/缓存读/缓存写/请求/费用)」

## 已定决策(不再翻)

| # | 决策 | 内容 |
|---|------|------|
| D1 | 颗粒度 | 票级:每轮走查步 = 待验票一张一步 + e2e-test-plan 故事步,**硬顶 8 步**;超出编译器降档归并;票内 AC 全量进折叠细目(勾选不在细目层) |
| D2 | 预览 | 无 iframe、无内嵌。preview = 用户配的长驻命令 + 探活 + 外链打开 + 停止;入口 = 实物 tab 第③段状态条(一行)+ 起停 |
| D3 | 标记闭环 | ✓=销账(下轮不再编译进来 + 进 ledger);✗=硬闸(通过 disabled)+ reject 反馈结构预填 + **对应票 done→reopened**;⊘=延期(原因必填 → 下轮 carryover 首段,第二次豁免需新原因,最终轮未决 → 交付披露);未决≠跳过,通过时弹确认区分「没看/看了跳过」 |
| D4 | 预算的度 | 编译器硬约束 ≤8 步/≤10min 预估;爆表自动降档(票级→故事级)而非翻页 —— C 反例已实测否决 |
| D5 | 布局 | A′:①实物②复检③预览 = **一行状态条**(点击内联展开);④走查 = 主角(黄头条+加粗边+阴影升档);右栏 360→**240**,只剩进度+决策钮两块;⑤台账不设常驻区(确认弹层即预览) |
| D6 | 单滚动纪律 | 每屏只许主列一根滚动条。现有嵌套滚动盒一并拆除:round-diff patch `max-h-[420px]`、叙述内嵌 md `max-h-[420px]`、verify 日志 `max-h-[280px]` → 全改内联展开/尾 N 行+指向 verdict 文件 |
| D7 | 双入口撤除 | 执行控制台 phase-surface 的 `data-verdict-row`(✓验收通过/✕打回)**删**,换「→ 去验货台验收」;决策唯一入口 = 验货台右栏 |
| D8 | 确认层三式 | 通过 = **ledger 预览弹层即确认**(不设空洞的"真确定?");打回 = 既有弹窗 + fail 项预填 + 路由单选;中止 = 红色危险确认(SIGTERM 连带在跑复检/预览 + aborted 不可恢复) |
| D9 | AI 消耗 | 从验货台右栏**撤除**;执行控制台主列**置顶**;三层同构完整七量纲(∑↑↓⚡🗡️请求费):总计=大瓷砖、按模型/分轮=AggInline 口径行;+烧钱 Top3 节点 +编写期口径开关;数据缺行标灰不猜 |
| D10 | 编译哲学 | 纯解析零 AI(与 ac-matrix 同族):spec.md / 末张 NN-e2e 票 / e2e-test-plan.md / round-report.md 都是固定 markdown 约定,解析即契约;缺料降级+coverage.missing 明说,**绝不猜** |

## 数据权威与落盘(零 schema 变更)

- playbook = **派生视图**(`GET /:id/playbook`),不入库;server 重启 = 重编译。
- 勾选 = `acceptance-checks-r{N}.json` 落批次目录(走既有 writeHomeFile → task_artifacts_update SSE 免费)。
- 台账 = `acceptance-ledger-r{N}.md` 通过瞬间**机写**落批次目录(叙述 tab 可见,不可改)。
- carryover = 编译器读上一轮 checks 文件(skip/fail 项),顶置剧本首段。
- preview 会话 = 内存(与 verify 同哲学);spec-field `acceptance_preview` 白名单持久。

## 非目标

- 不做 e2e 自动编排/浏览器驱动(P2+);不做 api-probe 单跑(P2);不做多任务并发预览;不改 matt-spec-dev 工作流本身(票纪律变更走 SKILL.md 另单);不新增表/不改 DB。

## 执行决定(用户已裁决)

- 主 agent 直接开发(用户令:「写完你就直接开发,没有什么对抗」)—— 不走 matt-dev-pipeline 并发派发。
- E2E 验证:有,以 **octopus-demo-api-admin** 为主靶(Spring Boot Web 应用,可 `mvn spring-boot:run` 起 :8080;parent/BOM = **octopus-demo-java-common**,前置 `mvn -N install` 进 .m2)。极简需求=`/api/status` 端点 + static/index.html 状态页 + MockMvc 单测(用户令:「设计一个简单的 web 功能,让他能启动起来」),浏览器实测验收台新面并截图 —— **UI 还原度本身是验收标准**(pop token/A′ 布局/单滚动与原型逐项对得上)。
