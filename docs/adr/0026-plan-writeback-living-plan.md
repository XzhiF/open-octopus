# 计划回写 — spec 与票是活计划

日期:2026-10-10 · 状态:Accepted · 关联:ADR-0018（ws 权威 spec 环）+ ADR-0024（打回单路径化）+ ADR-0025（task-doer）+ `.scratch/plan-writeback/spec.md`（grill Q1–Q12 裁决）

打回/人工转向之后，**spec 与票还停在"改前"**：范围真相和实际产出脱节，下一轮与修复轮照旧计划办事、重复同一个错；而修复轮的规格级反馈无处安放——"范围/决策级变更上交人改选修订重跑"的出口已被 ADR-0024 废除，大改只能写进 fix-report「遗留问题」，落档即蒸发。决定：**执行期规格写权经唯一的任务级 REST 通道开放给 task-doer 与修复轮**（`POST /api/tasks/:id/plan` 与 `/plan/issues`，写权限定本任务 home 下 Batch 目录批次，**含后续 phase**）；对话侧走 **plan-before-code 确认闸**——判为大改 → 先出 spec 变更预览 + 票草稿 → 人确认 → 回写计划 → 才动代码，被准则一字不动；修复轮则开工先回写（打回反馈本身即人的指令，不再设二次预览）。写入由 server **机械落痕**：spec 文末「变更记录」节 append 一行（时间·actor·source·reason·文件，按时间累积不互相覆盖；actor 按会话/执行归属解析，不信 body 自报），新票必带 `Origin:` 出生证明与 `Status:` 行——演化史随写而生，「产物」tab（home 直读）即趋势板。信封 `task_spec` 的 `phases[]` 结构信封**不动**：牵连结构（加/减 phase、换绑定流）的变更落**范围变更票**（`Status: ready-for-human`）经 `issues/` 留档指路，处理归 authoring 侧。

为什么有两层。上层是产品裁决（用户终裁 Q8b）：**系统必须有自我纠错能力**——范围真相允许在执行期就地修正，不被迫回到起草窗口；"内容做着改"的写权给执行者，确认闸给人。下层是数据流断层：agent 若直改 ws 侧批次文件，则**看不见**（产物清单只扫 home）、**回不去**（collect 只在轮终态跑，验收期改动滞留 ws）、**会被洗**（下轮 seed 由 home 无条件覆盖 ws 同名）——三断层是同一病根（计划文件过了 ws）的病理表现，补守卫或补回流都治不了本，只有让**规格不过 ws**、计划的全部写入收敛到 server REST 一侧，才能根治；故 doer 加反向硬闸拒写 ws 侧批次目录（对话报可见原因并指向 REST 通道），seed 恒 home→ws 单向、fix-report/证据照旧 ws→home 轮终态回流，既有链路零破坏。一句话语义：**结构谈着做，内容做着改；一切计划变更，必经回写留痕。**

## Considered Options

- **双通道（ws 直写 + collect 回流照常，另补可见性）** — 被否：同一份 spec 存在两个真相源（home 镜像 vs ws 工作副本），mtime 竞态、seed 覆盖与 collect 时机（仅轮终态）正面冲突无法调平，三断层即其产物；单通道把写权收到 server，守卫、归属与落痕才走在必然路径上。
- **写权以"当前批次"为界**（只许改本 phase 批次，后续 phase 规格回 authoring 处理） — 被否：用户终裁的自我纠错跨 phase——晚发现的错牵连后续 phase 规格时须直接可改，留"回到作者侧"的出口等于重立已废除的修订重跑；跨 phase 直写正是活计划的意义所在（Q8b）。

## Consequences

- amends ADR-0025 的"批次规格对 doer 只读"边界（persona 身份边界段"批次目录里的规格文件对你只读"作废，改为"仅经计划回写通道可写，且大改先预览后执行"）。
- amends ADR-0018 的"修复轮不扩权"纪律（task-fix"原则上不动 spec*.md""不自行扩权、上交人改选修订重跑"的收束段作废——"改 spec + 开票 + 记变更"属修复轮正常职责；大范围收束 = 开票留档 + 建议转 doer 对话）。
- K16 不破，与 ADR-0024 同构：信封 `phases[]` 入队冻结照旧，运行时代理不得触碰结构层，结构变更只经范围变更票留档指路。
- web 零改动：变更记录与新票经既有「产物」tab 天然可见（2026-10-10 裁决 Q4a），验收台账不加"计划变更"列。
- 纪律载体照旧是 persona / 流提示词（ADR-0018 §6 同构），端点 curl 配方内嵌两处 prompt，builtin-clones 内嵌 persona 与 core-pack 运行副本双处同步；server 只持机械不变量（路径限批次内 / reason 非空 / 终态拒写 / append 落痕）。
- 词表落位：GLOSSARY-MAP 新增「计划回写 (Plan Writeback)」与「范围变更票 (Scope-Change Ticket)」，前者与「归并回写 (Sync-back)」并词区分；「修复轮」增回写职责，「task-doer」写权句改为通道可写。
