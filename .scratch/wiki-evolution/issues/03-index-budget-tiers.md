# 03: INDEX 预算两级化 + 分层渲染（D-aa16-2 清偿）

**What to build:** 新知识不再被 800 token 硬顶三连拒：L4 闸两级化（>80% 预警 finding 放行、>100% 才拒且附压缩建议），INDEX 分层渲染（必读+高频恒见、Optional 压缩尾部），预算口径 = 恒见部分。

**Blocked by:** 01（P3 合入）

**Reference:** spec §Implementation Decisions「缺陷清偿 · INDEX 预算」· 故事 24-25 · P3 E2E DEFER D-aa16-2（复现靶：三连拒现场源）

**Status:** done (merged → integration `bcaf6f90` + main「先享用」)

- [x] L4 闸两级：INDEX 恒见部分 >80% 预算 → 编译**放行** + 预警 finding（提案三选：移低频页入 Optional / 拆分 / hub 化）；>100% → error 拒写 + 附压缩建议（策展人对话自纠，既有通道）
- [x] INDEX 渲染分层：必读节 + 五类正文节恒见；Optional 节压缩在尾（llms.txt 惯例）；预算只算恒见部分
- [x] 预警 finding 走既有 patrol→finding 卡通道（裁决即编译：采纳"移 Optional"则重编译 INDEX）
- [x] 复现靶真验：P3 三连拒的源重新投喂 → 编译成功落库（预警 finding 伴随产出）
- [x] 既有 L4 测试翻转（硬拒→两级）；lint 其余闸（L1/L3/L5/L6）零回归
- [x] S1（构造逼近预算 fixture：80% 放行+finding、100% 拒+建议）

## Comments

- **2026-10-15 implementer（we/03-index-budget @ a2ff1b93 码 + bcaf6f90 并集成 tip）**：预算口径从全文 token 改恒见段（D-aa16-2 病根「降入 Optional 行仍算钱」在 `renderBudgetedWikiIndex` 渲染层治好，故事25 llms.txt 惯例落地）；三通道统一 `l4BudgetGate` 接既有三拒写点（:487/702/1134，批面自此带 suggestion）——**判例管线 compileCase 维持无闸**（裁定：票面只列三点，给无闸通道新设闸=超合同，且蒸馏 adopt 会被拦成「裁决恒败」与票03 方向相反）。恒见∈(640,800]⇒findings upsert `kind=index-budget`（内容寻址单行/证据未变零写幂等/三选提案入 detail）；>800⇒L4_INDEX_BUDGET+overflowSplitSuggestion 随错。adopt⇒**finding-fix 队列串行位内** rebuildIndex 确定性重建（空转成功=distillCase 律），红线1 无旁路、零新 opKind（wiki-write-queue 逐字断言未动绿）；红线2 预警=事后三态人裁。翻转×3（lint 口径/病态巨行两级/migrate 三连拒→分层收敛全放行36源）；复现靶 tmpdir 三现场（沉淀推爆重投成功+预警伴随 13s、大库巨页硬拒+建议+零副作用、幂等重放不增殖）；E4 注记合规（真盘三连拒现场不可原样复现=已第4投 committed，故 tmpdir 合规口径）。测试 knowledge 域 379/381（2 日历红=基线自带，stash A/B 实证）、routes 367/367、shared 922/923（1 环境红）、build 绿。
- **SCHEMA.md 措辞建议（真盘人工文件未动，主控落治理账）**：「INDEX ≤800 token」段→第一跳预算=恒见部分（必读+五类正文节）≤800；低频页降级 `## Optional` 不占第一跳；两级闸 >80%(640) 放行+预警三选、>100% 拒+建议。
- **ff 入 main**：缺陷波（02/03/04/05）齐后 main ff 至 bcaf6f90「先享用」；票03 属缺陷波。冲突仅 finding-ops.test.ts 尾部双向追加，双保留解。
