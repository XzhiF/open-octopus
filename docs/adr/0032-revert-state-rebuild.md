# ADR-0032: 深回滚 = 状态重建 — git revert 三方合并退役，REVERT_CONFLICT 成历史

Date: 2026-10-15
Status: Accepted
Related: **amends ADR-0030 质控六道之③**（「git 一次编译一 commit + UI 一键回滚」的机制侧——单 commit 审计面与按钮语义不变，回滚机制由 git revert 三方合并改为状态重建；LOG 行「撤原行+revert 行」换成「历史行保留+deep-revert 行」）；**承 ADR-0031**（回滚仍经全局队列 `opKind="revert"` 串行，闸不变、语义换芯，红线1）；缺陷来源 = `.scratch/knowledge-center/e2e-report.md` D-kc15-3（回滚干净窗仅限 HEAD-adjacent；真盘实测目标 commit 之后 44 枚 INDEX/LOG 共行 commit，深回滚必冲突）；规格 = `.scratch/wiki-evolution/spec.md` 故事 22-23/31 + §Implementation Decisions「缺陷清偿 · 深回滚」；落码 = P4 票02（`wiki/revert.ts` execute 重写 + `compile.ts formatLogRow` 日期注入 + S1 `wiki-revert-deep.test.ts` 对靶 + S2 契约翻转）

## Context

知识中心票12 上线「一键回滚本次编译」：执行体 = `git revert --no-commit <target>`，后接 INDEX 程序化重建、LOG 追加 revert 行、DB/FTS 同步、单 commit。产品主场景（HEAD-adjacent 回滚最新编译）成立，但 D-kc15-3 用真盘钉出缺陷窗：**每枚编译必共改 INDEX.md 与 LOG.md 两枚程序化文件**，目标 commit 之后只要叠了后续编译，共行漂移使三方合并必冲突 → 任务 failed `REVERT_CONFLICT`，任意历史编译的深回滚实际不可达（真盘 bf6928d 之后 44 枚共行 commit，深窗 100% 冲突）。更深一层的不自洽：旧语义为消冲突要让 LOG「撤掉原 compile 行再 append revert 行」，与 LOG.md「append-only 时间线」纪律相抵——把本不该进 git 合并面的程序化文件拖进了冲突面。同时写闸现实给了另一条路：wiki 唯一写者是全局串行队列后面的服务群，commit 的页 diff 形状（增页/改页/迁 `_retired`）机械可判，回滚根本不需要三方合并的人工仲裁语义。

## Decision

**回滚 = 状态重建**，统一走此路（不再区分 HEAD-adjacent 快路径，git revert 三方合并退役）：

1. **目标态**：读 `T^ → T` 正向 diff（根 commit 以空树为参照）。T 触及的每个页路径**强制**回 T^ 侧——A→删在盘、D→按 T^ blob 重建、M→按 T^ blob 覆盖；INDEX.md/LOG.md 永不进 git 合并面：INDEX 按盘程序化重建，LOG 保留全部历史行（append-only 真相）+ append `## [date] deep-revert | compile <short>` 审计行（目标 commit + 重建页数，与既有 revert 行同族可 grep）。
2. **无冲突面**：强制对齐取代三方合并——后续 commit 对被触及页的改动被覆盖（被覆盖内容永久可经 `git show` 从仓史找回，审计真相面 = git，与 ADR-0031「真相面 = git commit + LOG 行」同根纪律）。`REVERT_CONFLICT` 错误码废弃；`LOCK_HELD`/`WORKTREE_DIRTY` 保留、语义不变。`_retired` 面处置：活页回在册面时同路径 `_retired/` 镜像一并摘除（防 retiredLedgerAnchors 与在册面双登记）；回滚退役迁页类 commit 时按 `T^ → T` 对称还原活页 + 删除退役位。
3. **闸与形不变**：仍经全局队列 `opKind="revert"` 入队串行（红线1）；仍单 commit 收口；API 形状（202 回执、task 面、touched 三值 removed/readded/restored）与 diff 卡/回滚按钮行为零改动；git 史线性保持（无 merge commit）。
4. **审计面换芯**（故事 23）：回滚不再「撤」LOG 历史行——每次回滚自产一条 deep-revert 行，时间线严格 append-only；「回滚了这次回滚」的后悔药 = 对回滚 commit 再发一次回滚（同一机械递归适用）。

## Considered Options

- **保留 git revert、加预检/逐页取舍（--strategy、ours 化处理）** — 被否：INDEX/LOG 共行冲突是结构性的（两枚程序化文件本就不该进合并面），逐页取舍只是把失败延后；且三方合并「保留后续改动」的许诺在深窗下已被 D-kc15-3 证伪。
- **回滚 = checkout 目标 commit 状态（整库回退到某点）** — 被否：会连带回退 T 之后全部编译，违背「回滚**本次**编译」的产品语义；票面 AC1「目标态」指撤销 T 之改动后的树形状（对 T 触及面逐字对齐 T^ 侧），不是 T 自身 tree。
- **深回滚产出冲突提案、人工裁决** — 被否（红线2 审批不复活）：冲突仲裁 = 新审批态；状态重建把裁决点后移到事后——回滚本身就是一条可 grep 的审计 commit，不满意再回滚它。

## Consequences

- **server**：`wiki/revert.ts` execute() 重写（纯读段先取全部 blob，fs 对齐段集中一次写，异常 best-effort `reset --hard` 清半成品）；`compile.ts formatLogRow` 增可选 `date` 参数（回滚通道走注入时钟，顺带治愈 revert 主链的日历型测试红；编译通道缺省仍真实钟、零改动）；`routes/wiki-revert.ts`、`index.ts` 装配注、`compile-queue.ts` kind 行注同步措辞；`wiki-revert-routes.test.ts` 三处逐字钉旧语义断言显式翻转；新增 `wiki-revert-deep.test.ts` S1 四例（D-kc15-3 复现靶翻正 + restored/readded 分支 + `_retired` 镜像处置）。
- **web-app**：行为零改动；仅 diff 卡确认钮括注文案「git revert 单 commit」→「状态重建单 commit」（措辞诚实性，testId 不变）与错误码注/用例标题随 REVERT_CONFLICT 废弃更新。
- **LOG 行格式族生长**：action 词表新增 `deep-revert`。server 读面 `LOG_LINE_RE` 的 op 字符集本就含连字符，零改动；web 时间线 FILTER_OPS 未含该词——落「全部」兜底渲染不丢行（retire/case+/revise 同形态先例）。SCHEMA.md 命名法段（人工文件，闸所护）待 owner 择机把 `deep-revert` 补进 LOG 动作口径一行。
- **风险与边界**：强制对齐意味着深回滚**吞掉**后续 commit 对被触及页的改动——找回靠 git 史，不靠测试假想；回滚的触及面是 wiki 树内文件，raw/ 与 wiki 库外 DB 面不参与（既有边界不变）；`_retired` 镜像摘除规则是票09「自动退役-恢复」的语义依赖位。
