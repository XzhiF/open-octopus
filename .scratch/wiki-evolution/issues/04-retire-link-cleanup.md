# 04: 退役清入链 + 矛盾裁决降级（D-aa16-3 清偿）

**What to build:** 页/规则退役不再留死链：退役执行器（人裁 finding 与后续自动退役共用的机械）增加"活页入链摘除"步骤；矛盾 finding 的对手页已退役时裁决降级为单侧处理，不再恒 failed。

**Blocked by:** 01（P3 合入）

**Reference:** spec §Implementation Decisions「缺陷清偿 · 退役清入链」· 故事 26 · P3 E2E DEFER D-aa16-3

**Status:** done (merged → integration `c8a69934`+tip merge `cec1917d`)

- [x] 退役执行器统一机械：迁 _retired/（replaced_by 指针）+ **活页入链摘除**（[[链接]] 改 _retired 指针文本或摘除）+ 触页与退役同一 commit（经队列）+ LOG retire 行
- [x] 人裁退役 finding（supersede/僵尸/低置信采纳）全部走此机械；票 09 自动退役复用同一执行器（接口预留）
- [x] L5 断链零潜伏断言：退役后全库 [[链接]] 扫描无指向已退役页的活链
- [x] 矛盾 finding adopt 时对手页已退役 → 单侧裁决（本页矛盾标记清除 + LOG 注记），不 failed；既有"对手页在盘"路径零回归
- [x] 复现靶真验：构造 P3 留的死链现场（退役页被活页引用 + 矛盾对手退役）→ 两症状均消
- [x] S1（退役清链 fixture / 单侧裁决 fixture / L5 扫描断言）

## Comments

- **2026-10-15 implementer（we/04-retire-links @ c8a69934，8 文件）**：统一机械落 page-retire.ts——正文 `[[链接]]`→定长指针文本 `[已退役]` + links 数组摘项，三形态（page/case/entry）覆盖，宿主 DB body/FTS 同步，与退役同一 commit 经队列。语义裁定「摘除+指针提示」弃「_retired 路径入正文」（文件名含日期触 L5_DATES_IN_BODY=延迟爆炸地雷）；机读留存=front-matter `status:superseded + replaced_by`（shared schema ADDITIVE，E1「replaced_by 零实现」缺口就此清偿）+ LOG retire 行「摘除 N 页入链」+ commit diff（票09 回补反放依据）。`PageRetireInput += replacedBy/source`（缺省 dialogue 零回归）。矛盾单侧：`_retired` 在盘⇒无 LLM 清标+LOG「单侧」注记 committed；ghost 真缺席不降级照旧 FINDING_TARGET_MISSING；双页在盘 LLM 路径原样绿。L5 潜伏做成测试断言不入 patrol（最小改动避 E2 结构冲突）。
- **票09 接缝（implementer 备案）**：唯一入口 `PageRetireTaskService.retire({path|pageId, reason?, replacedBy?, source:"auto"})` → enqueue("page-retire")——窄口只喂判据零改机械；恢复通道=单 commit diff 反放。
- **复现靶账**：tmpdir 复刻 D-aa16-3 三例绿（旧形态对照 5 断链显形/新机械零潜伏/fnd-a6f743a4a5043316 同形 adopt committed 且未裁标记不误伤）。**真盘现场留主控 ops 清偿（票11 前）**：prj-open-octopus.md 死链+恒败标记，经队列通道处理。
- **测试账**：定向 7 套件 46 绿+2 基线日历红（主仓同日同红）；全量红 list 交叉 diff 零新增；shared 922（1 基线红）；build 全绿。红线复核：零新 opKind、人工文件双保险、真知识根零触碰。

## Ops 真盘清偿（票11 前，主控执行 2026-10-15）

- 起集成分支代码实例（we-int dist @ fe4a5a48，OCTOPUS_DB_PATH=默认库，PORT=3420 非保护段，备份 `octopus.db.bak-pre-p4-settle-20261015`）。
- `POST /api/knowledge/patrol` 复报三枚恒败矛盾（fnd-7695a097/9073e3b4/a6f743a4，页内标记复报）→ `POST /findings/:id/adopt`：票04 单侧降级路径生效（**实测**：首次 adopt 因本页仍持对手页活体正文链被 L5_LINK_BROKEN 挡，走「restore→再退役」清链后 adopt committed——见下条评审料）。
- 死链现场清偿：对 `top-dev-port-and-stale-lock`、`con-fixture-first-hand-material` 两枚已退役页做「POST /wiki/restore 原号回迁 → POST /wiki/retire 走票04 统一机械再退役」→ 活页 [[链接]]→`[已退役]`、front-matter links 摘项、prj-open-octopus.md 三处死链全消。
- 全库 python 断链扫描（[[链接]] ∩ _retired ∖ live）=**0**（清 con-fixture 前曾 5 处，机械再退役后归零）；`wiki-reconcile` 幂等 diff 空、36==36 VERIFY OK。拆机三段式，3420 FREE。
- **给评审/票11 的料**：真盘 D-aa16-3 已清偿，**复现靶须走隔离 tmpdir 副本**（勿依赖真盘原状）。**新暴露缺陷 D-p4-ops-1**：单侧降级与 L5 残留断链复合——同页既有矛盾标记、又有对同一已退役页的正文活链时，stripMarkers 后 compilePages 仍被 L5 拒 → adopt 恒 failed（票04 fixture 未覆盖此复合形，故事26「不再恒 failed」对历史态未闭合）。真盘以 restore→re-retire 合法绕行；代码面候选修法（单侧降级 compile 前对本页跑对手页定向 cleanInboundLinks）交 /code-review 定夺。

## 评审波销账（2026-10-16）

- **D-p4-ops-1 已代码化闭合**（修复波 `0b3322e9` @ we/fix-review → 集成 `8458f533`）：单侧分支剥标记后、compile 前对每个已退役对手页摘残留活链并入同 works 同 commit；落地形态=从 page-retire 拆出**本页形** `cleanInboundLinksInContent` 页级纯变换基元（扫描形改消费之=判据单源不分叉，多退役页链式应用、且不为单页降级借全库读盘形）。票04 复现靶补复合形 fixture：修复前实测红（L5_LINK_BROKEN）→修复后 committed+`[已退役]`+恰+1 commit+零潜伏+退役件不动；真 failed 语义零伤（ghost 不降级动测过）。**故事26 判词 PARTIAL→PASS**（票11 映射同步销账）。行为变更申报：历史复合形 adopt 恒 failed→committed，预期修复面。
