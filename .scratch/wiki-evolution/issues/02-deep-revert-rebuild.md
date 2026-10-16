# 02: 深回滚 = 状态重建（D-kc15-3 清偿）

**What to build:** 回滚任意历史编译不再卡 REVERT_CONFLICT：revert 服务从 git revert 三方合并改为**状态重建**——读目标 commit 的树、与现态 diff、程序化重建页/INDEX/LOG/FTS/DB 至目标态、单 commit 收口。审计面完整（LOG deep-revert 行 + git 线性保持）。

**Blocked by:** 01（P3 合入）

**Reference:** spec §Implementation Decisions「缺陷清偿 · 深回滚」· 故事 22-23 · KC e2e-report D-kc15-3（复现靶：目标 commit 之后有触 INDEX/LOG 共行的后续编译）

**Status:** done (merged → integration `231bda5d`)

- [x] revert 服务改状态重建语义：目标态 = 目标 commit 的 wiki 树；重建含页文件增删改、INDEX 程序化重建、LOG append deep-revert 行（目标 commit + 重建页数）、FTS/DB 同步——单 commit
- [x] REVERT_CONFLICT 错误码废弃（状态重建无冲突面）；LOCK_HELD/WORKTREE_DIRTY 保留；既有 revert 契约测试相应翻转
- [x] 复现靶真验：构造"目标编译之后又有 ≥2 次触 INDEX/LOG 的编译"现场 → 深回滚成功、四路一致（页/INDEX/FTS/DB）、git 线性无 merge
- [x] 回滚经全局串行队列（既有 revert opKind，语义换芯不换闸）；diff 卡/回滚按钮 UI 零改动可用
- [x] 审计面：LOG deep-revert 行格式与既有 revert 行同族可 grep；知识中心 LOG 时间线渲染不破
- [x] S1（真 git+tmpdir：深回滚四路一致/线性/审计行）+ S2（端点契约翻转）；既有浅回滚测试迁移或翻转全绿
- [x] ADR 评估：「revert=状态重建」立 ADR（改变回滚审计语义，spec 倾向立）

## Comments

- **2026-10-15 implementer（we/02-deep-revert @ 41800e57 代码 + 0a3bd9fd 治理）**：revert.ts execute() 整段重写——`git diff --no-renames T^→T` 取触及面、逐路径强制对齐 T^ 侧（A→删/D/M→`git show T^:path` 重建）、INDEX 按盘程序化重建、LOG 历史行全保留+append deep-revert 行、DB/FTS 同步（_retired/非.md 不登账）、单 commit。REVERT_CONFLICT 全仓零产生点；S2 三处逐字旧断言显式翻转（顶行 regex→deep-revert、历史行保留义、冲突全弃→强制对齐 committed）；复现靶=旧实现实跑红证（`REVERT_CONFLICT: …9237e1acd`，tmpdir 复刻 D-kc15-3 形状 rev-list≥2 内嵌自查）→ 新实现 S1 4/4 四路一致+线性+审计行。web 69/69 零改动可用（仅确认钮括注措辞诚实化）；时间线 log-timeline 未知 op 兜底不丢行。ADR-0032（四段制式 Related=amends 点名 ADR-0030③/承 0031）+ GLOSSARY-MAP「深回滚 (Deep Revert / 状态重建)」词条挂行随仓先例同 commit。
- **主控裁定**：①「目标态=目标 commit 的 wiki 树」采 implementer 释义=**撤销 T 之改动**（触及面逐路径对齐 T^），非全树 checkout——全树还原会连坐撤销后续一切编译，颠覆「回滚本次编译」产品语义与 S2 主链；故事22 的痛点定义（后续共行编译卡死）以此释义完全清偿。②_retired 处置规则（还原活页删同路径墓碑镜像防双登记/回滚新增页不动既有墓碑=归档先于删除）认可，票09 恢复语义依赖位已在 ADR-0032 Decision 2。③formatLogRow ADDITIVE date 注入缝留「后续票顺手治愈 page-retire/findings 日历红」线索，不强求。④SCHEMA.md 增补文案（LOG 动作追加 deep-revert 行+「历史行不回退」注）归主控收尾治理账（人工文件，落笔归人）。
- **merger 账（231bda5d）**：--no-ff 零冲突（票02 与票04 净改动行级不重叠）；formatLogRow 双票语义人工核验并存（:376 签名 ADDITIVE、page-retire:314 缺省通道零改、revert:267 注入时钟）；定向 109/110（唯一红=page-retire 基线冻结日期非新增）；根 build 复绿；push origin 成功。
