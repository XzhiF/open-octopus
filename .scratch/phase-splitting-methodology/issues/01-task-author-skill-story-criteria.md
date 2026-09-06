# 01 — task-author SKILL 故事判据重写

## What to build
把 `packages/core-pack/skills/task-author/SKILL.md` 的拆 Phase 方法论从「时间预算借位」换锚为「phase = 完整故事」（spec KD1-KD9）：方法论章全重写（故事生成器：需求→列故事→phase1=MVP 切穿最高风险段→其后每故事一 phase；下界 sanity=功能票 ≥3、E2E 票不计、MVP 豁免；上界定性=讲得完+一次坐得下，无时间硬顶，⏳ advisory 保留；≤1h 锚降到票层「≤1h/票，E2E 票 ≤1.5h」；两段式预算制：拆相轮=结构 grilling ≤15 轮、fog-or-ticket 判据、禁下钻 phase 内部，内容轮在拆卡批准后逐 phase 走；写全+不画雾：后段 spec 故事/验收物写实、前序依赖只引用不抄；前提引用制「见 phase i KD#n」；风险/铺路安放：无 spike/技术 phase，铺路=故事 phase 内 prefactor 票，决策票 decisions/ 拆卡前解；沉淀分界：可逆→K8、三判据活过 task→docs/adr；AC 分层：phase AC=故事=E2E 票源、票 AC=切片、phase spec 不重复票 AC），工作总览②③④措辞、拆分确认卡模板（删「预算」列→「功能票」列；卡头加「最高风险：… → phase1（MVP）切穿路径：…」行；交付物列注「验收时我看什么·六问简版」）、交互风格「预算自觉」→「判据自觉」、matt 技能族协议章补两段预算、frontmatter（version 3.4.0 + description 故事判据句）。旧口径字符串含变体全文件清零（见 spec Implementation #1 清单）。

## Blocked by
None — can start immediately

## Status
done

## Acceptance Criteria
- [ ] AC1 方法论章含 spec Implementation #1 列出的全部成文点（KD1-KD3/KD5-KD9 语义在场，表述自拟但判据不得走样）
- [ ] AC2 拆分卡模板：无 `| 预算 |` 列、有「功能票」列、卡头有风险行、交付物列带六问简版注
- [ ] AC3 交互风格「判据自觉」替换「预算自觉」；工作总览/frontmatter 同步
- [ ] AC4 旧口径变体串全文件零命中（frontmatter 无冒号式、`票归属/预算`、示例单元格 `~1h`/`~1.5h` 均在内）
- [ ] AC5 保留段完好：K8 行稳定纪律、不抄前序（已升级前提引用）、数量线、⏳ D18 注记、衔接信道/绑定目录/API 各章不动

## Verification Method
**Verification type**: manual checklist + grep

**Verification steps**:
1. `rg "单 phase ?= ?coding agent|3~5 ?人天|超过 1\.5h 的 phase|票归属/预算|\| 预算 \||~1\.5h|预算 coding agent" packages/core-pack/skills/task-author/SKILL.md` → 零命中
2. `rg "1\.5h" packages/core-pack/skills/task-author/SKILL.md | rg -v "票"` → 零命中（1.5h 必在票语境）
3. `rg -c "完整用户故事" packages/core-pack/skills/task-author/SKILL.md` → ≥1
4. diff 人工审：对照 spec Implementation #1 逐条勾验收（保留段未误删：`rg "NEW-rN|不抄前序|auto_advance|advisory" SKILL.md` 均在场）

**Pass criteria**: 1-3 零/达标 + 4 全勾
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Verification Result
- 旧口径 11 变体 pattern 全零命中；「完整用户故事」×3；唯一 1.5h 行含票语境（`rg "1\.5h" | rg -v 票` 空）；K8/不抄前序/advisory/衔接信道保留段在场
