# ADR-0022: 验收剧本与活预览 —— 验收期证据链从"叙述"升级为"编译+机写+状态机下游"

日期:2026-09-17 · 状态:Accepted · 关联:.scratch/acceptance-playbook/(brief D1-D10/spec S1-S6)+ ADR-0018(ws 权威/打回二分)+ 验收面 v2(2026-09-16)

## 上下文

验货台 v2 已消灭"报告即证据"(实物 diff + 当场复检),但复杂功能(有 UI/跨仓库)验收仍三断:看不见(工作区活着却无"跑起来"入口)、没指引(该验什么/预期散四份 markdown 无编译面)、无闭环(人工判定不驱动票状态/不留下轮/双入口可绕证据直通提交)。界面侧 5 个嵌套滚动区 + 360px 摘要栏挤掉验收主角。

## 决策

1. **Playbook = 派生视图,不入库不 AI**:服务端把 awaiting 轮契约(spec.md/末张 NN-e2e 票/e2e-test-plan.md/round-report/上轮 checks)按固定 markdown 约定**编译**为票级走查清单(每票≤4 步、全局≤8、爆表降档故事级);缺料降级 + coverage.missing 明说。id 稳定(勾选键)。
2. **勾选与台账 = 文件即权威**:checks 走既有 home-file(零新端点);通过瞬间 server 机写 `acceptance-ledger-r{N}.md`(聚合 diff/verify/preview/checks/决策),不可改,叙述可见。
3. **✓✗⊘ 有状态机下游**:✓销账(下轮不再编译入);✗硬闸(通过 disabled)+ reject 结构预填 + **对应票 done→reopened**(acceptance body +reopen_tickets,server 改票文件 Status);⊘延期(原因必填→下轮 carryover 首段;最终轮未决→交付披露)。未决≠跳过,通过弹层强制区分。
4. **Live Preview = 用户配、按钮起、绝不自动跑**(与 verify 同信任级):`acceptance_preview` spec-field{command,cwd,url,readyPattern?};BashExecutor 长驻+探活+`task_preview` SSE;无 iframe 只外链;无会话时探测到外部进程占 url 如实报 external;三决策路径自动 stop 并记 ledger。
5. **决策唯一入口 = 验货台**:控制台 verdict 行撤除;通过/打回/中止全部过确认层(通过=ledger 预览弹层即确认)。
6. **UI 定稿 A′**:①②③一行状态条内联展开、④走查主角、右栏 240 只剩进度+决策;token/cost 撤出验货台、AI 消耗卡控制台置顶且三层同构完整七量纲(总计/按模型/分轮,口径=AggInline);**单滚动纪律**:每屏恰一根主滚动条(现有 420/280px 嵌套滚盒一并拆)。

## 后果

- 验收面板不再"读报告",而是"照剧本验货+盖章留链";打回的下一轮 brief 天然携带人证缺口(carryover/reopened),与 matt-pipeline-loop 的 anti-fake-convergence 同构复用。
- 契约文件 markdown 形状升格为**被机器解析的接口**:task-author 票模板(Verification steps/Pass criteria)改动需同步 playbook 编译器 —— 记入 core-pack 纪律(另单)。
- 预览引入"面板起长驻进程"新面:blast radius 同 verify(用户本机自用工具,不自动跑);2h 硬顶 + 决策自动 stop 防悬挂。
- e2e 兼容成本:控制台 approve 选择器迁到验货台锚(两既有 spec 更新);三列 testid 语义重挂。
- 内存态(verify/preview 会话)重启即失不变,ledger/checks 文件为持久真相。
