# 09: 自动退役窄口 + 恢复通道

**What to build:** "只进不出"的自动出口，只开一条窄口：锚点 90 天零引用（吃 effectiveness 账）**且**零活页入链 → 自动迁 _retired/（票 04 统一退役机械）+ 通知卡；对话"恢复 oct-XXX"原号原行回迁 + 入链回补。窄口之外一切退役仍走 finding 人裁。

**Blocked by:** 04（退役清入链机械）, 06（90 天零引用账）

**Reference:** spec §Implementation Decisions「衰减自动退役（窄口）」· 故事 16-18

**Status:** done (merged → integration `7328fbb6`，ff)

- [x] 窄口判据（AND 三条）：锚点 90 天零引用（记账 last_cited）且零活页入链且非人工文件；判据常量与理由注释入码、口径进 SCHEMA.md
- [x] 自动退役经全局串行队列（新 opKind：auto-retire），走票 04 统一退役机械（_retired + replaced_by + 入链摘除 + LOG retire 行，同 commit）
- [x] 通知卡：退役发生后进知识中心对话流（锚点/页/判据数据/可恢复提示）——**先斩后奏但可逆**，非审批形态
- [x] 恢复通道：对话"恢复 oct-XXX"→ 策展人从 _retired 原号原行回迁（锚点永不复用纪律的恢复豁免：原号随迁）+ 入链回补 + LOG restore 行（经队列）
- [x] 窄口之外负断言：低置信/域失衡/volatile 到期等一律仍产 finding 等人裁，无自动执行路径
- [x] 触发面：夜巡步骤（doctor 之后跑，吃当夜账）
- [x] S1（时钟注入构造 90 天账：窄口命中自动退役/入链存在不命中/恢复回迁原号/幂等）+ S4（通知卡渲染）

## Comments

- **2026-10-15 implementer（we/09-auto-retire @ 7 链 commits，净 diff 25 文件 +2304/−26 全知识域）**：auto-retire.ts 常量 AUTO_RETIRE_WINDOW_DAYS=90+逐条理由入码；判据①两账皆无名（锚点键∪页级 stem，票06 制式，行缺席/早于截止线=窗内无名）+**观察窗完整**（last_compiled≤截止线，昨日新页=未观测非僵尸，构造性保守）；②零活页入链=复用票04 cleanInboundLinks/linkPointsToPage 单源（判据与摘链永不分叉）；③非人工文件=isManualFileTarget 防御闸（现布局与 scan 面天然不交，性质注释钉死）。域最窄化=候选须≥1 规则锚点（零锚页归 finding 人裁域，负断言列证）。
- **opKind 裁定（两案对比，主控认可照票面）**：B=新 kind `auto-retire`+`page-restore`（故事18 逐字点名；kind=审计词表 UI/脚本按值消费，队列观测面直辨自动写）胜 A=复用 page-retire（票04 范围注非跨票约束）。`PageRetireInput.opKind?` HTTP 面不暴露防伪造；WRITE_OP_KINDS 十一→十二类逐字枚举同步；夜巡链序 **parseLedger→syncConfidence→autoRetire**（票06/07/09 三序约束同满足，腿序以账目可见性行为断言钉非调用序列）。
- **恢复通道**：`page-restore.ts` 镜像对话退役同款接线（POST /restore 三口令 anchor>path>pageId + GET task + web classifyKcRestore 意图 + restorePage Lane B 回执 + SKILL.md 资产化 API 表行）；原号原行回迁=永不复用纪律代码位 retiredLedgerAnchors 天然衔接（回迁后扫面移交，发号空间无缝，nextRuleAnchor 不重蹈测试钉）；入链回补=票04 备案 retire-commit diff 反放（漂移/失踪=让位+warnings 显形不吞后期编辑）；原位被占 RESTORE_TARGET_TAKEN 409。
- **通知卡**：终态后发（失败不进卡=事实沉淀非预告），KcAutoRetireCardData 开放 kind 零联合改、restoreHints 口令；**红线2 负断言 S4 卡面 button=0、批准/否决词零出现**；无会话诚实降级。
- **测试**：S1×12/S2×6/S4×11 全绿；全量 server 35 红=基线档内（**顺带治愈一枚存量日历红**：retire LOG 行接 this.now() 按票02 deep-revert 制式，生产缺省行为不变）；web/shared 档内零新增；合并冲突四处（compile-queue/wiki-write-queue/patrol-job/index）双语义全解。真盘零触碰全 tmpdir 缝。
- **SCHEMA.md 建议口径**（owner 落笔，红线5 写保护）：全文见 implementer 报告——窄口三判据+域外清单+恢复豁免+「低置信/域失衡/volatile 永远人裁」；留一开放共演项「rule_ref 指针边计不计入链」。
- **票11 前置**：core-pack SKILL.md 改动需重启 dev 同步运行副本（implementer 注记，与票10 同款提醒）。
