# 03 — CONTEXT-MAP 术语换锚 + ADR-0020

## What to build
根 `CONTEXT-MAP.md`：**Phase 词条（L108）换锚**——现文「时间预算 ≈1h/phase（含复杂 E2E ≤1.5h）」是词表层病灶（judgment 借位的宿主），改写为故事判据（= 一个完整用户故事；phase1=MVP 切穿最高风险；功能票 ≥3 下限 sanity、MVP 豁免；时间预算属票层）；新增**词层澄清行**：Phase（叙事/交付单元）≠ User Story（spec 内穷尽清单条目）≠ Ticket（实现单元，≤1 上下文窗）；「System-wide ADRs」列表补 0020 行。`docs/adr/0020-phase-story-granularity.md`（按 ADR-FORMAT.md/0019 惯例）：背景 = 判据借位根因与三源病灶（旧数字置于「历史引述」块）、决策 = KD1-KD6 摘要、被否方案 = 硬时间双界 1.5h wall-clock / 纯时间双界 [2h,4h] / 雾占位 spec+毕业拦截环 / spike·技术 phase 例外 / 拆卡加预告列、后果 = 单 phase 回滚粒度变粗由 round 打回承接、防线前移拆卡票数 sanity、执行惯性风险靠 dogfood 首航实证。

## Blocked by
None — can start immediately（判据文本以 spec KD 表为准，不依赖票 01/02 产物）

## Status
done

## Acceptance Criteria
- [ ] AC1 Phase 行含「完整用户故事」「MVP」「功能票 ≥3」，不含 `≈1h/phase` 与「1.5h」
- [ ] AC2 词层澄清行在场（Phase/User Story/Ticket 三分），Round/验收 Gate/Batch 行未动
- [ ] AC3 ADR-0020 文件在场且编号无冲突（原 docs/adr 下一号确为 0020）、含三案以上被否与后果、System-wide ADRs 列表已登记
- [ ] AC4 ADR 内旧数字仅在历史引述/被否方案语境出现

## Verification Method
**Verification type**: grep + manual checklist

**Verification steps**:
1. `rg "完整用户故事" CONTEXT-MAP.md` ≥1；`rg "≈1h/phase" CONTEXT-MAP.md` 零命中
2. `rg "Phase（叙事|≠ User Story" CONTEXT-MAP.md` 命中；`git diff CONTEXT-MAP.md` 审 Round/Batch 行未动
3. `ls docs/adr/0020-*` 在场；人工对照 `docs/adr/0019-*` 结构核对 ADR 完整性（背景/决策/被否/后果四段，被否 ≥3 案）

**Pass criteria**: 全过
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Verification Result
- Phase 行换锚 + 叙事分层行 + System-wide ADRs 0020 行；ADR-0020 在场含 5 被否案与后果，旧数字均在历史引述块
- `rg "≈1h/phase" CONTEXT-MAP.md` 零命中；`rg -c 完整用户故事` = 3；Round/Batch 行 git diff 未动
