# Spec: 拆 Phase 方法论改造（phase = 完整故事判据）

## Problem Statement

v4 看板按 phase 逐里程碑验收，但 task-author 拆出的 phase 经常「一个 phase ≈ 一张票」——用户被迫为票大小的碎片付人工 gate 的注意力税（一次看板验收 = 一次完整注意力，摊不到 3+ 票就不值）。根因不是 agent 乱拆，而是**判据借位**：SKILL、persona、CONTEXT-MAP 三处的 phase 判据都写着「单 phase = coding agent ≤1h（含 E2E ≤1.5h）」——1h 恰恰是票层容量（一张票 = 一个 context window ≈ ≤1h），拿票容量钉 phase，作者只能拆出一票一 phase；同一条里「3~5 人天 ≈ 4~5 phase」又隐含每 phase 约一人天，与 ≤1.5h 自相矛盾，模型服从更具体的那个数字。

## Solution

把 phase 的判据从「时间」换成「叙事」：**每个 phase = 一个完整用户故事，叠加在 MVP 之上**。phase1 = MVP 薄切片（切穿最高风险段），其后每 phase = 一个讲得完、验得完的产品故事。时间预算降回票层（≤1h/票），phase 层不设时间硬顶。配套：两段式对话预算（拆相轮只谈结构 ≤15 轮，内容细节逐 phase 轮）、后段 spec「写全+不画雾」、前提引用制衔接预告。四源（SKILL/persona/CONTEXT-MAP/ADR-0020）统一换锚。

## Projects Involved
- [x] octopus（主仓库：core-pack SKILL / server persona / 根 CONTEXT-MAP / docs/adr / scripts/sync-builtin）

## Feature Scope

**Do:**
- `packages/core-pack/skills/task-author/SKILL.md`：「拆 Phase 方法论」章重写 + 工作总览②③微调 + 拆分确认卡模板换列 + 交互风格「预算自觉」重写 + frontmatter description/version（→ 3.4.0）+ matt 技能族协议章补两段式预算
- `packages/server/src/services/agent/builtin-clones.ts`：task-author persona 拆 Phase 行同口径重写（全文件 grep 旧口径清零）+ 受影响测试同步
- 根 `CONTEXT-MAP.md`：Phase 词条换锚（去「≈1h/phase」）+ Phase/Ticket/User Story 词层澄清
- `docs/adr/0020-*.md`：故事判据决策记录（含被否方案与后果）
- `node scripts/sync-builtin.mjs` 生效 + 三源一致性 grep 断言 + 全量回归（shared/server/web/simulate/playwright 基线不新增红）

**Don't:**
- 不动 server 调度/gate/DB/占位符机制代码（纯文本档改造，ADR-0018 §6 纪律：spec 纪律写 SKILL/persona 不写 server 代码）
- 不改 `.claude/skills/` 下 matt-* 技能本体（外部源仓库资产；本次是「抬升进本平台 SKILL」，不是回搬）
- 不动绑定目录/衔接信道/占位符词表各章；不新增注入键或产物
- 不迁移存量 v4 任务（旧拆法不追改，SKILL 注明现状即可）
- web-app 零改动（拆分卡是 agent 对话 markdown，非组件）

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| KD1 | phase 主判据 | **phase 集 = 故事集**：每 phase = 一个完整用户故事（MVP 之上叠加），验收主题从「可运行」升级为「讲得完一条故事」；可运行降为必要条件 | 用户钦定（grilling 叉①）；故事边界天然同时管住太碎与太大 |
| KD2 | 序结构 | phase1 = MVP 薄切片（tracer bullet 本义：切穿**最高风险段**），其后每 phase = 一个故事；拆分流程 = 需求 → 列故事 → 每故事一 phase | 「在 MVP 之上」用户原话；风险前置替代 spike 例外 |
| KD3 | 量化检查 | 下界 sanity check：故事内**功能票 ≥3（E2E 票不计）**，不足 → 合进邻故事；**MVP 豁免下限**；上界定性（成果内聚 + 一次坐得下验收），phase 不设时间硬顶（⏳ advisory 徽标保留）；**≤1h/票（E2E 票 ≤1.5h）预算降到票层** | 一次看板验收 = 一次人的注意力，摊薄不下 3 票不值 gate；时间尺是票层容量，借给 phase 即本次根因 |
| KD4 | 对话预算 | **两段式预算制**：拆相轮 = 结构 grilling（10~15 轮封顶，**fog-or-ticket 判据**：能精确成问的才在拆相轮问，只能感到形状的下放该 phase 内容轮；禁止下钻表结构/API 字段）；拆分卡批准 = 一表批问；超载 = 「上层出问题」信号（>7 故事 → 需求再澄清，与既有阀门同族） | matt max-15-rounds 抬升版；轮次爆炸 = 用户说的浪费 |
| KD5 | 后段 spec 完整度 | **写全 + 不画雾**：入队前每 phase spec.md+issues/ 写全（gate/autoAdvance/seed 机械零改动），但后段故事/范围/验收物写实，依赖前序的接口细节**只留引用不抄不猜**；「毕业」= matt-spec-dev spec-review 段首条既有纪律（对位前序 handoff：不回退 Protected/复用 Confirmed/承接 Gap Targets），修订经 collect 回流 home | 免掉「雾占位 spec 与入队 gate/autoAdvance 的正面冲突」；对位机制现成 |
| KD6 | 衔接预告 | **零新增账本 + 前提引用制**：预告物 = 各 phase spec 的 Key Decisions 草稿态（K8 表），ship 精选 = 运行态，两态一本账；后段 spec 凡以自己的前提为前序决策处，写「见 phase i KD#n」行引用，禁散文转述；拆分卡**不加**「传给下游」列 | decision single home（wayfinder 原训）；加列必与 ship 真值漂移 |
| KD7 | docs 沉淀分界 | 本 task 生命周期内可逆 → spec K8 表行；满足三判据（难逆/无上下文会惊讶/真实权衡）且活过本 task → `docs/adr/`（home 草稿→归档归并）；Protected Decisions 是运行时投影非新账本 | domain-modeling 三判据的 phase 层免费礼物（叉④推导项，随本 spec 确认） |
| KD8 | 验证策略落层 | 粗粒度六问（验收级别/数据态/范围面/测试数据/断言/前置）压缩进拆分卡「交付物」列（必须可执行地回答「验收时我看什么」）；全 6 维留各 phase spec 的 Verification Strategy 节；**AC 分层**：phase AC = 故事叙事（= 该 phase E2E 票断言来源），票 AC = 切片行为 + Verification Method；phase spec 不重复票 AC | 「No verification strategy = not clarified」抬升（叉⑥推导项，随本 spec 确认） |
| KD9 | 非故事工作 | spike/纯技术铺路**不立 phase**：风险前置进 MVP 选题；铺路工并入首个需要它的故事 phase 作 prefactor 票；拆卡头部一行「最高风险 → phase1 切穿路径」；拆相期答不了的开 `decisions/` 决策票、拆卡前解掉 | phase 的存在理由 = 交付产品状态（wayfinder task 型票判据在 phase 层失效） |
| KD10 | 落地流程 | 本会话直接改造（不开成 v4 任务——它按新判据不构成可拆任务：无故事序列，用旧 SKILL 拆自己的改造 = 违例样本）；改造全绿后**拿真 backlog 需求 dogfood 首航**（候选：dev 库残留「全局 token 计费」草稿），补 #51 AC6 真 LLM 全链 | 用户选定（叉⑦）；方法论需真实首航而非自拆自检 |

## Execution Decisions

<!-- 出口 gate 一表批问后回填 -->
| # | Decision | Choice | Reason |
|---|----------|--------|--------|
| 1 | Story Walk-Through | run | 方法论文本最吃「作者盲视」：独立读者检 10 KD × 9 AC 一致性 + 各章自洽（三源同判据是本 feature 的结构性风险） |
| 2 | E2E Verification（票 05 dogfood） | run（择时执行） | KD10 已定首航；票必产，实际开跑由用户在改造合入后发令（真 LLM 成本面单独授权） |
| 3 | Ticket Execution Mode | main-agent-quick | 票是同一判据的三源联动，交叉引用密集，拆子代理反而漂移；本会话直做（KD10） |

## User Stories

1. 作为用户，我给出多故事需求时，author 先和我敲定 **MVP 切片（含切穿哪段最高风险）** 与故事清单，而不是直接吐一串 1h 碎 phase。
2. 作为用户，拆分卡上每个非 MVP phase 都带「功能票数」列且 ≥3；出现 <3 的故事时 author 主动提议合并，并说明理由。
3. 作为用户，拆相对话在 15 轮内收敛，全程只谈故事边界/验收物/依赖/票量，不问「表加哪几列」——那属于逐 phase 内容轮。
4. 作为用户，后段 phase 的 spec 写全但诚实：故事与验收物写实，前序依赖处只写「见 phase i KD#n / Confirmed Interfaces」，不假装预见执行细节。
5. 作为验收人，我按 phase 验收时看到的故事是完整的（「用户现在能完整地 X」），一次坐得下，不需要连着通过三道碎 gate 才凑出一个功能。
6. 作为用户，我在 SKILL、persona（源码+盘上运行时态）、CONTEXT-MAP、ADR 四处读到同一个「phase = 故事」判据；旧时间口径只在 ADR 历史引述块与票层语境（≤1h/票、E2E 票 ≤1.5h）出现。
7. 作为作者侧 agent，我拿到新 SKILL 后按「列故事 → 拆卡 → 逐 phase 内容轮」走，遇到 spike/大重构诉求时把它并进故事而非另立 phase。
8. 作为维护者，我能在 ADR-0020 里读到这次换锚的完整权衡（被否的三案：硬时间双界 / 雾占位毕业 / 全部写全现行）。
9. 作为平台用户，我用新方法论 dogfood 的真任务，其拆分卡能证明判据生效（风险行、票数列、无预算硬顶列、交付物列可执行）。

## Implementation Decisions

**涉及文件与章级改动点**（票 01/02/03 的具体施工对象；行文措辞执行侧定，判据以 KD 表为准）：

1. `packages/core-pack/skills/task-author/SKILL.md`（票 01）
   - frontmatter：`version: 3.4.0`；description 中「拆 phase 方法论（deliverable 判据…预算 1h/1.5h…）」短语替换为故事判据一句话（含 phase1=MVP、票≥3 下界、时间锚降票层）
   - 「拆 Phase 方法论」章**全重写**：KD1-KD3、KD5-KD9 成文（故事生成器 → 上下界检查 → 不画雾 → 前提引用 → 风险/铺路安放；**KD7 沉淀分界** = 本 task 可逆决策进 K8 表行、三判据满足且活过 task 者进 `docs/adr/`；**KD8 AC 分层** = phase AC 讲故事、是该 phase E2E 票的断言来源；票 AC 讲切片行为 + Verification Method；phase spec 不重复票 AC）；K8 行稳定纪律、数量线（单 phase 合法 / >7 再澄清）、不抄前序保留并接入前提引用制
   - 工作总览六步：② 改「列故事 + 结构 grilling（≤15 轮，fog-or-ticket）」、③ 卡含风险行、④ 明确「逐 phase 内容轮在拆卡批准后」
   - 拆分确认卡模板：列改为 `| # | Phase 名（故事） | slug | 交付物（验收时我看什么·六问简版） | 功能票 | 依赖前序（KD#/接口引用） |`，**删「预算」列**；卡头加一行「最高风险：… → phase1（MVP）切穿路径：…」
   - 交互风格「预算自觉」条重写：「讲不成一个故事、或功能票 <3（MVP 除外）的 phase，在你嘴里就不该存在——先合，或问用户砍范围」
   - matt 技能族协议章：补两段式预算（拆相轮 vs 内容轮）+ 小/雾 phase 选型保留
   - **旧口径字符串全文件清零**（含 frontmatter，**以实际变体串为清零对象**）：`单 phase = coding agent ≤1h`、`3~5 人天 ≈ 4~5`、`超过 1.5h 的 phase`、frontmatter 无冒号变体 `预算 coding agent 1h / 含 E2E 1.5h`、工作总览② `票归属/预算`、卡模板 `| 预算 |` 列头与示例行 `~1h`/`~1.5h` 单元格
2. `packages/server/src/services/agent/builtin-clones.ts` **+ 盘上 persona**（票 02）：源码 persona 两处旧口径按 KD1-KD3 同口径重写——「拆 Phase」行 + 拆分确认 gate 段的「票归属/预算」字样；**加载链是盘上优先**（`clone-runtime`/`clone-resolver` 读 `~/.octopus/agent/built-in/task-author/persona.md`，源码仅 fallback；clone-init 对已存在文件 skip-if-exists——盘上现文件为 79 行 v3 遗物，早已与源码脱钩），故本票必含盘上处置：**删盘上 persona.md → server 重启重 seed → 断言盘上实文为新口径**；grep 全分身提示词面（源码+盘上）旧口径清零；`persona-v3-instructions.test.ts` 锁着相邻三段契约，施工不得误伤（列入本票 Verification）；其他若测试断言 persona 文案（snapshot/字符串匹配）同步更新，不新增红
3. 根 `CONTEXT-MAP.md`（票 03）：Phase 行重写（去「≈1h/phase」，写入「= 一个完整用户故事；phase1=MVP；功能票 ≥3 下限 sanity、MVP 豁免；时间预算属票层」）；新增一行**词层澄清**：Phase（叙事/交付单元）≠ User Story（spec 内穷尽清单条目）≠ Ticket（实现单元，≤1 上下文窗）；Round/验收 Gate/Batch 行不动；「System-wide ADRs」列表补 0020 行（惯例含 0019 同款）
4. `docs/adr/0020-phase-story-granularity.md`（票 03，按 domain-modeling ADR-FORMAT）：背景（判据借位根因 + 三源病灶）、决策（KD1-KD6 摘要）、被否方案（B 硬时间双界 1.5h wall-clock / C 纯时间双界 / 雾占位毕业重写 / spike·技术 phase 例外 / 拆卡加预告列）、后果（碎 phase 消失的代价 = 单 phase 回滚粒度变粗，由打回·round 机制承接；执行期超 ⏳ 只有 advisory，靠拆卡票数 sanity 前移防线）
5. 验证基建（票 04）：`node scripts/sync-builtin.mjs` 执行并核对落位；**grep 一致性断言矩阵**（逐源强制判据：`完整用户故事` 在 SKILL/persona 源码/盘上 persona/CONTEXT-MAP **各源必中**，辅串任一命中即核；旧口径串**操作三源**（SKILL/源码 persona+盘上/CONTEXT-MAP 操作面）零命中；ADR-0020 豁免——其背景与被否方案必然引用旧数字，但须置于「历史引述」引用块内；写成可重跑命令组进票 04 的 Verification）；全量回归：`pnpm --filter @octopus/shared build`、`pnpm --filter @octopus/server test`（基线 42 不新增红）、`pnpm --filter @octopus/web-app test`（基线 3 files）、`octopus workflow simulate packages/core-pack/workflows/matt-spec-dev.yaml`（5/5）、playwright 三 spec（14 pass/1 skip 不动）
6. 接口/数据：**零 API、零 DB、零 web 变更**——回归即「不破坏」证明

**既有纪律承接**：K8 表行稳定、NEW-rN 标注（本 feature 即 KD1-KD10）；ADR 三判据本改造满足（难逆 = 判据重塑所有未来任务的拆法；惊讶 = 后人问「为什么不设 phase 时间上限」；权衡 = 三案被否）；绑定可选项 = workflow-presets.yaml 目录不变。

## Data Model Changes

无——纯文本资产改造，不触 DB/表/字段。

## API Contracts

无——不触 server 代码。

## Design Specs

- Figma：无。零 UI 变更。

## Verification Strategy

### Verification Environment
| 项 | 值 |
|---|---|
| 环境 | 本机 dev：`:3001` 新构建（衔接信道/绑定目录 v3 已活；**persona 盘上优先**——盘上现为 v3 遗物，票 02 处置后方与源码一致；dev server 跑 dist 无 watch，server 源码改动需 rebuild+重启才上运行态）；`:3000` web |
| 仓库 | `C:\xzf\ai\open-octopus`，分支 `octopus-feat-v4-direct-create-ui`，PR #57 |
| 基线 | server 42 failed / web 3 files / shared 绿（`model-alias.test` 本机环境红除外）/ PW 14+1skip / simulate 5/5 |

### Test Users & Data
| 项 | 值 |
|---|---|
| DB 写入 | 票 01-04 零写入（grep/test 为主）；票 05 dogfood **新建**真任务 `E2E_TEST_phase-split-dogfood`（不转正旧草稿——「全局 token 计费」残留草稿绑的 `built-in/matt-dev-pipeline` 系 v3 遗留流已不在绑定目录，届时 abort 清池防干扰发现命令） |
| 清理 | dogfood 任务验收后 abort/归档，测试草稿不入终态；旧「全局 token 计费」草稿票 05 执行时 abort |
| 可重跑 | 全部 grep 断言 + 测试命令幂等 |

### AC to Verification Method Mapping
| US# | 断言锚 | 级别 | 方法 |
|-----|--------|------|------|
| US1/US2/US7（拆法行为） | 拆分卡模板含票数列+风险行、删预算列；方法论章含生成器流程 | 静态 grep + 人工审稿 | 票 01 Verification：正则断言 + diff 审读 |
| US3（对话预算） | 两段式预算制与 fog-or-ticket 判据成文于 SKILL 方法论章+协议章 | 静态 grep | 同上 |
| US4（写全+不画雾） | 不画雾纪律 + 前提引用制成文；「不抄前序」段保留并升级 | 静态 grep | 同上 |
| US5（验收承载力） | 判据语义正确性 | 人工审查（story-walkthrough 子代理辅助） | Execution Decisions #1 |
| US6（四源同锚） | 关键串四源在场、旧串四源零命中 | 脚本断言 | 票 04 grep 一致性矩阵 |
| US8（决策留痕） | ADR-0020 在场、含被否三案 | 文件存在 + 人工审 | 票 03 |
| 回归不破坏 | 全部既有测试/simulate 基线 | unit/integration | 票 04 Verification 命令组 |
| US9（判据生效实证） | dogfood 拆分卡四特征（风险行/票数列/无预算列/交付物可执行）且非 MVP 故事票 ≥3 | live 人工清单 | 票 05（run 择时，用户发令） |

### Verification Methods Detail
#### 静态 grep 断言（票 04，可重跑命令组）
- 旧口径清零（**操作三源**：SKILL.md / builtin-clones.ts / 盘上 persona.md / CONTEXT-MAP.md 操作面）：`rg "单 phase ?= ?coding agent|3~5 ?人天|超过 1\.5h 的 phase|≈1h/phase|预算 ?[:：] ?coding agent|含 E2E ?1\.5h|票归属/预算|\| 预算 \||~1\.5h"` → **零命中**（变体含 frontmatter 无冒号式与卡模板单元格；ADR-0020 豁免——引用旧数字须在「历史引述」块内，人工核）
- 新判据在场（**逐源强制**，非 OR 混池）：四文件（SKILL/persona 源码/盘上 persona/CONTEXT-MAP）各自 `rg "完整用户故事"` **必中**；辅串 `rg "功能票\** ?≥ ?3"`、`MVP 豁免`、`不画雾`、`见 phase [0-9i]+ KD` 按源核（书写式以「不含 markdown 粗体夹字」为准，正则已放宽）；ADR 含被否三案关键词 `硬时间双界|雾占位|spike`
- 票层语境机械规则（替代人核计数）：`rg "1\.5h" packages/core-pack/skills/task-author/SKILL.md | rg -v "票"` → **零命中**（凡 1.5h 行必含票语境）

#### unit/integration 回归
- `pnpm --filter @octopus/shared build && pnpm --filter @octopus/server test`（≤42 且无 persona 相关新红）
- `pnpm --filter @octopus/web-app test`（3 files 基线）
- `octopus workflow simulate packages/core-pack/workflows/matt-spec-dev.yaml`（5/5——本改造不触流定义，防误伤）
- playwright 三 spec（task-authoring-v4 / task-phase-acceptance / task-phase-board：14 pass/1 skip）

#### live 清单（票 05，run 择时）
0. 版本探针（B1/B8 防线）：commit 后 **rebuild server + 重启 :3001**（dev.mjs 无 watch）；删盘上 persona.md 令 clone-init 重 seed；核 `~/.octopus/agent/built-in/task-author/persona.md` 实文含「完整用户故事」+ task-author 落位 SKILL version=3.4.0
1. `node scripts/sync-builtin.mjs` 后核对 task-author 分身 plugin 落位 SKILL version=3.4.0
2. 看板发起 task-author 会话，投喂真需求 → 产出拆分卡：非 MVP 故事功能票 ≥3、卡头有风险行、无预算列
3. 用户批准拆卡 → 逐 phase 产 spec 后走 ready gate（四项全过）→ 首 phase 派发（衔接信道注入 live 验证 = #51 AC6 补票面）

### Anti-Fake-Run Standards
| # | 本 feature 适用形态 |
|---|---|
| R1 真服务 | 票 04 simulate/回归真跑本机 :3001；票 05 真任务真会话，禁 mock |
| R2 业务数据 | grep 断言具体判据串，不接受「文本已更新」 |
| R3 交叉验证 | 四源一致性矩阵互证（SKILL↔persona↔CONTEXT-MAP↔ADR） |
| R4 证据 | 断言命令 + 输出行数进票 Verification Result |
| R5 副作用 | sync-builtin 后核对落位文件实际 version 字段 |
| R7 数据隔离 | dogfood 任务 `E2E_TEST_` 前缀 |
| R8 可重复 | 全部命令幂等可重跑；票 05 若环境/授权不满足 → 如实 SKIP（延续 #51 AC6 口径） |

### Prerequisites
- [x] `pnpm dev` 新构建在跑（:3001，本次会话已重启）
- [ ] 票 01-03 完成后才进票 04；票 04 全绿 + commit 后**用户发令**才开票 05 首航；票 05 开跑前先 rebuild + 重启 :3001（dev 无 watch，persona/SKILL 运行态生效依赖此环）
- [ ] 票 05 需求载体届时由用户投喂（新建 E2E_TEST_ 任务，不转正旧草稿）

## Acceptance Criteria
（= 上表 AC 行的可勾选形态，票 04 汇总验收；票 05 单列）

- [ ] AC1 SKILL 方法论章重写：故事生成器 + MVP 首 slice + 票 ≥3 下界（MVP 豁免）+ 上界定性不设时硬顶 + 两段预算 + 不画雾 + 前提引用 + 风险/铺路安放 + 沉淀分界三判据切账 + AC 分层（phase AC=故事叙事=E2E 票源/票 AC=切片/phase spec 不重复票 AC），frontmatter v3.4.0
- [ ] AC2 拆分卡模板：票数列 + 风险行 + 交付物六问简版列注，预算列删除；交互风格「预算自觉」换「判据自觉」
- [ ] AC3 persona **同口径重写两处（源码 L108 拆 Phase 行 + L155 拆分 gate 段）+ 盘上 persona.md 经删文件重 seed 更新**；旧口径**操作三源零命中**（SKILL/源码 persona/CONTEXT-MAP——ADR-0020 豁免，历史引用须置于引述块）
- [ ] AC4 CONTEXT-MAP Phase 行换锚 + 词层澄清行（Phase/User Story/Ticket 三分）+ System-wide ADR 列表补 0020
- [ ] AC5 ADR-0020 在场，含三案被否与后果
- [ ] AC6 一致性 grep 矩阵全绿（逐源强制「完整用户故事」在场 + 旧口径操作三源零命中 + `1\.5h` 行必含票语境机械规则）
- [ ] AC7 回归零新增红（shared/server/web/simulate/PW 基线原样）
- [ ] AC8 sync-builtin 生效，落位 SKILL version=3.4.0；**盘上 persona.md 实文探针含新判据关键串**
- [ ] AC9（live，run 择时）dogfood 首航拆分卡四特征 + 首 phase 派发走通（= #51 AC6 补票）

## Risks & Notes
- R1 LLM 执行惯性：文本判据 ≠ 行为判据，author 可能滑回票大小——AC9 首航即检验；缓解：新判据放方法论章第一句 + 拆分卡自查清单化（生成器顺序即防线）
- R2 词层漂移：「故事」易与 spec 的 User Stories 清单混用——AC4 词层澄清行兜底；SKILL 内统一「叙事单元/清单条目」措辞
- R3 三源漂移：SKILL 与 persona 两处独立文案——AC6 grep 矩阵兜底；ADR 留完整权衡供后人
- R4 存量豁免：已建 v4 任务按旧拆法不迁移不追改（K13 停用不物理删同款姿态）
- R5（walk-through B1 实证）：**内置分身 persona 盘上优先且 clone-init skip-if-exists**——源码 persona 改动对运行时不生效；task-author 盘上 persona 已是 v3 遗物（goal/ac 叙事、与源码脱钩）。本批以「删文件重 seed」收口（票 02），但**机制缺陷（内置分身盘上遗物不可升级）另案登记**，本批不修 server 代码
- Note: 本 spec 自身即新方法论的**第一个应用样本**——它不为「改造」编造故事序列，而是单批 5 票直做（KD10），这正是「小需求别硬拆」判据的自我一致

## Glossary（本 feature 新增/换锚）
| 术语 | 含义 |
|------|------|
| 故事判据（Story Criteria） | phase 主判据 = 一个完整用户故事（MVP 之上叠加）；取代时间预算判据 |
| 判据借位 | 本次根因诊断：票层容量尺（1h/context window）被借用为 phase 层上限 → phase≈issue |
| 前提引用制 | 后段 spec 依赖前序决策处写「见 phase i KD#n」，禁散文转述 |
| Phase ≠ User Story ≠ Ticket | 叙事/交付单元 ≠ spec 穷尽清单条目 ≠ 实现单元（票）——CONTEXT-MAP 落行 |

## Appendix: 拆相对话记录（七叉结论）
①粒度=故事判据+票数 sanity（A 案，否 B 硬双界/C 纯时间）→ ②两段预算制+写全不画雾（A 案，否 B 雾占位/C 全现行）→ ③风险前置/铺路入票（A 案，否 spike phase/C 技术 phase）→ ④沉淀分界（三判据切账，推导确认）→ ⑤零新增账本+前提引用（A 案，否 B 加列/C ForDownstream 节）→ ⑥验证落层（六问拆卡/全维 phase spec/AC 分层，推导确认）→ ⑦直接改造+真需求 dogfood（A 案，否 B 自拆/C 不首航）。
