# 08: 清理账 — pending_review drop · 死码 · 沉淀页退役

**What to build:** P2' 遗留一次清完：pending_review 表物理退役（导出归档→蓝绿 drop）、死码删除、wiki 根空 v2 目录清理、E2E 沉淀页经策展对话退役（dogfood 真跑）、shadow-compare 只读边界注定稿。

**Blocked by:** 01（KC 合入）

**Reference:** spec 故事 28/29/32/33 · 红线：归档先于删除 · KC 分支留账注记（死码三件、shadow-compare「清理前勿新增消费者」）

**Status:** done

- [x] pending_review 蓝绿退役：数据导出归档（_archive 可查）→ drop 表含索引 → DAO/类型/边界注/相关路由残留同步删 → 全测试绿（零僵尸引用）
- [x] 死码删除：unmarkRuleRetired / findRuleById / listKnowledgeFiles 及同类零 importer 残留（grep 全仓确认零消费再删）
- [x] wiki 根空 v2 域目录（projects/workflows/business/research）fs 清理
- [x] E2E 沉淀处置（dogfood）：kc15-* 前缀 fixture 页经**策展对话**退役入 _retired/（全程对话+队列+git，无脚本旁路——这本身就是「对话即管理」的真跑验证）；真源编译产物（真实文章的页）保留
- [x] shadow-compare：保持冻结只读，边界注定稿（删除留 P4 后议）；代码注记与 spec 同步
- [x] 归档先于删除纪律：每项删除动作的归档件先落盘可查（顺序断言）

## Comments

- **2026-10-14 (票08 implementer)** 分支 `aa-08-cleanup-ledger` @ `de791e31` → 主控解 6 文件冲突（与票02/07 卡面同区叠加，按 notes §8-9 keep-both；chat-column ctx/deps 并集、use-kc-feed return 并字段）→ merge commit `6659d2f6` 入集成分支。
- **停报-裁定记录**：①spec「pending_review 已无消费者」不属实——legacy 执行归档流（web ArchiveDialog→/api/archive/:id/propose→/api/review/batch）仍活，主控裁定审批面全删（含 dialog 三页签链，P2 票09 漏检补刀）、非审批面保留（GET /:id/summary 孤儿端点留 P4 账、Archive V2、file-ops 模块本体含 readUserPreference 护栏）；死码删点名三件+同类 markRuleRetired（逐个 grep importer=0 后连测试段删）。②item-4 前提不实——「对话退役一页→_retired/」通道不存在，主控裁定按 spec 授权插座建机制：新 opKind `page-retire`（枚举+逐字断言同步）+ `WikiPageFrontmatter.status?`(ADDITIVE) + `page-retire.ts`（照 revert 四路同型：先写新位再删原位/INDEX 重建/LOG/DB-FTS 摘除/单 commit，人工文件拒）+ `POST /wiki/retire` + classifyKcRetire 对话意图+退役卡一行注册。
- **2026-10-14 (主控 ops)** 真默认库蓝绿退役：dry-run rows=0 → `retire-pending-review.ts --db octopus.db` 实跑，审计件 `~/.octopus/knowledge/_archive/pending-review-2026-10-14T09-52-07-276Z.json`（空表也留=红线1），表+三索引 drop 净（残留 pending 名对象=executions claim 索引，无关）。v2 空目录：`removeEmptyV2DomainDirs` 实跑 removed=projects/workflows/business/research（cases 保留）。**kc15-* 12 页退役**：3412 临时实例经产品队列通道 POST /wiki/retire ×12（opKind=page-retire，非脚本旁路）→ 队列 drain → 四路互验：_retired/ 有 12 件、wiki_articles 32→20（kc15 残留 0）、INDEX kc15 行=0、git 12 retire commits 线性、health pages.total=20。对话形态（classifyKcRetire UI 链）真跑复验归票09 链⑤。
- 预存红账：web harness-floating-panel ×3（EventSource jsdom）、shared model-alias ×1（本机 models.yaml）——stash 基点复证与本票零关联。
