# 09: 旧世界拆除 — 审批链 + 两旧 UI + org knowledge + 经验库

**What to build:** 旧知识世界整体退场（owner 裁决：删除干净一点）：审批链 server 侧全删、/wiki「知识词条」页与 /experience「工作经验」整页（含经验库、偏好编辑器）删除、org knowledge 与 experiences 数据**先归档再删除**、旧经验提炼管线退役。agent 记忆系统零触碰。

**Blocked by:** 07（重蒸馏——知识资产先迁完）, 08（注入链删除——org knowledge 先没了读者）

**Reference:** spec §Implementation Decisions「已拍板的前置决策 · 删除边界」+「审批废除」+「注入链与旧库硬废」· 过闸文书 §5（归档不删纪律）

**Status:** done

- [x] 审批链 server 全删：review 的 wiki 通道（rule/wiki-edit/wiki-split 策展分发）· approve→curate 链 · 拆分提案入队语义 · auto_approve；pending_review 表本体保留（skill 草案等非 wiki 用途）并在代码注释注明边界
- [x] /wiki 路由 + 页面组件删除；/experience 整页删除（经验库、知识管理 tab、审核组件、助手面板、**偏好编辑器**——user_preference 从此无 Web 编辑入口）；导航入口移除；旧链接 404 或重定向 /knowledge
- [x] org knowledge：各 org 目录（projects/workflows/user_preference 原件）→ `_archive/org-knowledge-{date}/` 后删原目录；旧知识目录 getter 的 mkdir 副作用随注入链消亡（不得重建已删目录）
- [x] experiences：数据导出归档 → drop 表（含 FTS）；**agent 记忆系统（daily/long-term/session 记忆表与 UI）零触碰断言**
- [x] K11 归档归并语义零触碰（其回归测试绿）
- [x] 全测试套件绿（被删模块零僵尸引用；lint 过）
- [x] S4：旧路由 404/重定向断言；S1：归档先于删除的顺序断言 + 幂等

## Comments

**2026-10-13 实现（kc/09-old-world-teardown @2d63aa42 → 并入集成分支 741ec1b7；53 文件 +1031/−7327）**

- server 删：wiki/curate.ts·split.ts·distill.ts + routes/wiki-distill（approve→curate 链/拆分执行器/蒸馏落盘面）· routes/knowledge.ts 旧 CRUD 全删（PUT preference 消亡）· ReviewService 策展分发/auto_approve/写权闸全删（approve=纯结案）· extract.ts auto_approve 直写块（recurring 统一 pending 零落盘）· file-ops 三 getter **mkdir 副作用消亡**
- server 保留（边界注已写进 schema.sql/review.ts）：pending_review 表+DAO+/api/review（skill 草案用）· wiki 读面 · 对话编译轨 · shadow-compare
- web 删：app/wiki·app/experience 整目录 + KnowledgeTab/Experience 五件/PreferenceEditor/useReviewQueue/wiki-api/旧 CRUD 十三函数/`knowledge-ui.test.tsx`（**TC-027×3 基线红随文件退役——档案减账**）；header 两旧导航摘除（票 11「只加不删」测试按票面翻转为退役断言）
- **共享件红线兑现**：cards/ReviewCard（ChatArea 用）、archive/ArchiveDialog（workflow-detail-panel 用）、assistant/、shared/badges 零触碰——票面「助手面板」经探索实锤=ArchiveDialog 内件而非 /experience 挂载，按红线保留（裁定认可）
- 新增：middleware.ts（/wiki /experience→307 /knowledge 剥 query，S4×4）· GET /preference 只读迁入 knowledge-read（票 11 契约不变，零 mkdir 断言×4）· old-world-teardown 服务 + `scripts/kc-old-world-archive.ts`
- 归档脚本两阶段（archive+逐文件 hash 校验过才删；ARCHIVE_CONFLICT/EXPORT_FAILED 时零删除）；**主控 ops 序**：tsup 打桩→`--dry-run`→VACUUM 备份→`--apply`→重跑验幂等；真 drop 后服务重启会重建空表（数据已归档无损，可幂等再 drop）——**「DDL 退役+消费降级」收口单**待开（evolution-dao/harness/useAgentSkills 僵尸面）
- 并入后复证：build+next build 绿（旧路由删除自洁闸）· lint 0 error · server 522 例仅档案 archive-routes×10 逐字吻合零新增 · web app/knowledge 32/32 + middleware 4/4 · 崩溃 7 文件不回退 · 代码级僵尸扫描=0（一处死账 globals.css `.preference-prose`~130 行零引用→留 review 清扫）
- 环境档案（merger 实锤）：server 重 git 套件**须走 PowerShell**，Git-Bash/MSYS 下 git 子进程读 Program Files gitconfig 假红
- K11+记忆零触碰：v4-archiving×19/acceptance×31/archive-ingest×14/memory×22 全绿；teardown 报告含 memoryTablesBefore/After 五表对账断言

**真数据 ops 已执行（2026-10-13 主控，序=搬家→重蒸馏后）**：tsup 打桩（注意 out-dir 每次清，schema.sql 需后补）→ dry-run（12 org 目录 archive+delete：xzf-dev 6f/3866B、testorg 1f、miyuan/xzf 偏好原件；experiences present rows=0；memoryTables 前后对账等）→ VACUUM 备份 pre-old-world-teardown.bak → apply 全点执行 → 重跑 13×skip-absent+`drop-verified-export` ✓幂等。实盘：orgs/xzf-dev/knowledge 消失、experience* 查询零行、sessions=49/chat_sessions=0 存活、归档件 `_archive/org-knowledge-20261013/`（orgs/*, experiences.json/csv, global）。证据 `C:/tmp/kc-ops/teardown-*.json`。
