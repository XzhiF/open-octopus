# 07: confidence 滚动 + 可见面

**What to build:** 置信度从编译期静态初值变为实战滚动值：confidence = helpful/(helpful+not_helpful)（DB 真源），夜巡批量刷页 front-matter 快照（经全局串行队列新 opKind，单 commit 收口一批）；页元数据与健康条可见引用数/helpful 率/confidence；低置信自动产 finding。

**Blocked by:** 06（记账解析器——confidence 的原料）

**Reference:** spec §Implementation Decisions「effectiveness v2」· 故事 3-5

**Status:** done (merged → integration `c6930a09`)

- [x] confidence 计算：helpful/(helpful+not_helpful)，样本不足（总记账 <3）保持编译期初值不抖动（阈值进 SCHEMA.md 可调）
- [x] effectiveness-sync 队列 opKind（新写操作类型入 WRITE_OP_KINDS 单源）：夜巡批量把 DB confidence 刷进对应页 front-matter，单 commit 收口一批 + LOG sync 行；无变化零提交（幂等）
- [x] 页元数据面：article API 与浏览模式页脚带 引用数/helpful 率/confidence（DB 实时值，非 front-matter 快照）
- [x] 健康条：全库平均 confidence 或低置信页数（口径进 SCHEMA.md）
- [x] 低置信 finding：confidence≤0.2 且引用≥3 → patrol 产出（提议修订或退役，走既有 finding 卡裁决）
- [x] S1（账目 fixture→confidence 断言/样本不足不抖动/批量刷幂等零空提交）+ S2（元数据 API 形状）+ S4（页脚与健康条渲染）

## Comments

- **2026-10-15 implementer（we/07-confidence-rolling @ c6930a09，8 功能 commit + merge 票10 tip）**：`effectiveness-confidence.ts` 纯函数单源（CONFIDENCE_MIN_SAMPLES=3 理由入码：2-3 次裁决撑不起生死、抖动夜夜洗 front-matter 造 git 噪音）+ DAO `recomputeSufficientConfidences`（兑现票06 留白位）；**effectiveness-sync 入 WRITE_OP_KINDS 单源（P4 首个扩 kind，wiki-write-queue.test.ts:89-99 逐字枚举同步→十类，红→绿亲验）**；`effectiveness-sync.ts` 执行体=夜巡批量 DB confidence→v3 页 front-matter，批通道 compilePages action=sync 单 commit 收口+LOG sync 行（parseLogLines 天然兼容），无变化零入队零空提交。可见三面：article API `effectiveness` 实时段（DB 真源，快照0.9/实时0.8 同显=特性，S2×4）+ 页脚实效段（S4×3）+ health `avgConfidence`（已测行均值/全未测诚实 null，queueDepth「只换值不换形」同律，S2×2+S4×1）；低置信=巡检第七查（≤0.2 且引用≥3，账目=页键∪锚点行与 sync 同 rollup 单源零漂移，PatrolFindingKind 于票03 index-budget 后追加、票03 21 例复绿；adopt 走 semanticRevision 第三证据形态=账目数字进 prompt，红线2 退役不在此通道）。
- **裁定备案**：①低置信按票面字面（初值≤0.2 且引用≥3 未测也入列=「编译期就没人信还被用3次」最该复审）；②健康条取平均置信口弃低置信页数口（低置信已由 finding 显形）；③POST /effectiveness/sync 手动端点=票06 双触发对称；④schema-doc「裁决即编译」枚举句留票08 同步位。
- **测试**：S1×10+6+3（手算字面 1/3=0.333 定标/2样本保0.9/幂等重跑 git 计数不变 LOG 字节恒），全 tmpdir+注入时钟 FROZEN 零 sleep；全量 server 3383/36红（=档内34+日历2同数同档，stash 基线复现）、web 1030/3档内、shared 922/1档内，零新增红；build/lint 绿。红线三点 diff 23 文件全知识域+组合根，engine/记忆域/builtin-clones 零出现。
- **SCHEMA.md 建议**（真盘人工未动，owner 落笔）：新增「实效账目与置信度」节——confidence 公式、<3 不刷新、低置信判据、健康条平均置信口径、effectiveness-sync 队列通道 LOG sync 行。
- **ff 入集成**：merge-base --is-ancestor 确认，e081748e→c6930a09 ff + push origin。解锁票08（吃本票 low-confidence 分组视图）。
