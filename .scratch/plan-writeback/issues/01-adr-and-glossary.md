# 01: 文档落位 — ADR-0026 + 词表三改

> Spec: `.scratch/plan-writeback/spec.md`（裁决全程 Q1–Q12 见 tmp/tbm-v2-notes.md 与本会话 grill 记录）

**What to build:** 把"计划回写"的决策与词汇先立起来——后续票的 UI 文案、persona 指令、测试断言都从这里取词。未来读者打开 docs/adr 能看懂"为什么对话可以改 spec"。

**Blocked by:** None (can start immediately).

**Status:** done

- [x] ADR「计划回写 — spec 与票是活计划」成文：决策（执行期规格写权经单通道开放给 task-doer 与修复轮，amends ADR-0025"批次规格对 doer 只读"与 ADR-0018"修复轮不扩权"，句内点名）、为什么（系统自我纠错 + 三断层只能靠"规格不过 ws"根治）、权衡（否决双通道与"当前批次为界"两案）
- [x] 词表新增「计划回写 (Plan Writeback)」：任务执行期经确认闸与单一 REST 通道回写批次 spec/票的行为；与「归并回写 (Sync-back)」并词不混称
- [x] 词表新增「范围变更票」：`Status: ready-for-human` 的溢出票，载体为当前批次 issues/，处理归 authoring 侧
- [x] 「修复轮」词条扩义：承担计划回写职责（反馈指向规格即改 spec 并留痕；大范围收束 = 开票留档 + 建议转 doer 对话）
- [x] 「task-doer」词条改写：批次规格由"只读"改为"仅经计划回写通道可写"
- [x] 词条间引用自洽（计划回写 ↔ 修复轮 ↔ task-doer 互链，无循环定义），全仓 grep「修订重跑」「只读」旧口径不残留在活文档（.scratch/docs/adr 历史记录豁免）

> **Closed**: 并入 feat-plan-writeback（octopus-pwb-01@9692f724，纯文档零代码）。SKILL/persona 内旧口径清扫按裁决归票 05。2026-10-10。
