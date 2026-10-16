# 05: raw→多页编译管线 + SCHEMA.md 首版

**What to build:** 三层架构的主链条端到端成立：投喂一篇真文章 → 策展人编译 → **一次触 N 页**（新建/更新 entities、concepts、topics + 生成 sources 摘要页）→ INDEX/LOG/FTS/git 同步一个 commit。矛盾不静默覆盖。SCHEMA.md（层 3 约定文档）首版落地。

**Blocked by:** 02（raw 层）, 04（v3 格式基座）

**Reference:** spec §Implementation Decisions「三层架构」+「审批废除与写入闸门」· prototype Tab③（Ingest 入口 A 全流程）· Karpathy gist "A single source might touch 10-15 wiki pages"

**Status:** done

- [x] 编译管线：读 SCHEMA + INDEX → 全文读 raw → 抽取实体/概念/断言 → 对照现 wiki diff → 写 N 页 + sources 摘要页（要点 + 触及页清单 + 回指 raw 路径与 hash）→ 单一 git commit
- [x] 一篇真文章（真 provider）投喂端到端：触 ≥3 页；sources 回指可解析；INDEX/LOG/FTS/git 四同步
- [x] 矛盾处置：新源与旧断言冲突 → 两页内矛盾标记 + finding 数据产出；不静默覆盖、不阻塞编译
- [x] SCHEMA.md 首版落知识根：吸收 octo-wiki-curate 的编译纪律/页格式约定/命名法/工作流；curate skill 本体瘦身为「指向 SCHEMA + 编译 API 用法」
- [x] 编译为异步任务：投喂返回任务 id，状态可查（排队中/编译中/已提交/失败）；失败事务回滚零半成品（复用既有原子机制）
- [x] S1 环级测试（fixture raw + 真 fs）：多页产物 / sources 回指 / 矛盾标记 / 幂等（同 raw 重编译 diff 空）
- [x] S2 测试：投喂→编译任务 API 契约（状态流转 + 错误码）

## Comments

**2026-10-13 实现（kc/05-compile-pipeline @bc75fbce → 并入集成分支 18ef034b；merge 零冲突，build/lint 全绿，并入后回归基线逐名一致零新增）**

- 新服务：`wiki/curator.ts`（CuratorCompileService）/ `curator-task.ts`（薄 registry）/ `curator-llm.ts`（默认 sonnet，OCTOPUS_CURATOR_MODEL 可覆盖）/ `schema-doc.ts`（模板单源+幂等 seed，人工文件永不覆盖）/ `db/dao/findings-dao.ts` / `routes/wiki-compile.ts` / `scripts/kc-curator-e2e.ts`（真跑驱动入仓）；curate SKILL.md 瘦身为指向 SCHEMA+API
- **AC2 真 provider 实跑（非 DEFERRED）**：Karpathy gist 11985B → 触 **10 页**（con×5/ent×3/top×1/src×1）、单 commit `2c1d4d2`、169.3s、回指 sha256 互验、四同步齐；驱动 13 断言 ALL PASS
- findings 最小面=v53 纯新表 `findings`（kind/status open|resolved|ignored/detail JSON/pages/raw_ref/source compile|patrol），内容寻址 id `fnd-<sha16>` 幂等，upsert 保人已裁决状态；写于 commit 成功之后
- 测试：S1 16 + DAO 4 + S2 5 全绿；并入后 server 域 646 passed / 红仅基线档案（archive-routes 等）
- 入缝（票 06 已消费）：`compileRaw(raw)` 同步原子入口，队列整包=外包 run/start 互斥；registry 进程内 Map 不持久（崩溃恢复语义归票 06/12）
- 裁定注记：① 矛盾对象为 v2 旧页时 `CURATOR_CONTRADICTION_TARGET_LEGACY` 拒——票 07 重蒸馏后消解（其测试已带此断言）；② sources 页 id=`src-<raw-stem>`；③ source 回执页豁免正文日期（回指需日期文件名）；④ 计划校验自纠仅一轮；⑤ URL 末段 "raw" 致兜底 slug `2026-10-13-raw.md`——票 12 抓取卡展示时留意，ingest 面小修随票 09/12 顺路。
