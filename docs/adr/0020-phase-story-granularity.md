# 0020 — 拆 Phase 故事判据：phase = 完整用户故事叠加 MVP，时间锚降回票层

## 状态

Accepted（2026-09-06）· 改写 task-author SKILL「拆 Phase 方法论」章 + persona 同口径 + CONTEXT-MAP Phase 词条；不改 server 调度代码（spec 纪律写 SKILL/persona，ADR-0018 §6）；消费 ADR-0019 衔接信道作「毕业对位」机制

## 背景

v4 看板每 phase 末有一道人工验收 gate，但 task-author 拆出的 phase 频繁退化到票大小（phase≈issue），用户被迫为碎片付注意力税——一次看板验收 ≈ 人的注意力一整次，摊薄不下 3 张票就不值一道 gate。

诊断 = **判据借位**：SKILL、persona、CONTEXT-MAP 三处把票层容量尺当作 phase 上限。病灶原文（历史引述）：

> 单 phase = coding agent **≤1h**（含 E2E 时 **≤1.5h**）。经验换算：3~5 人天需求 ≈ 4~5 个 phase。

（——而「一个 context window ≈ ≤1h」正是 to-tickets 的**票层**尺寸判据；同条内「3~5 人天 ≈ 4~5 phase」又隐含每 phase 约一人天，与 ≤1.5h 自相矛盾，模型服从更具体数字的那个。）

matt 族方法论为「单次 spec→tickets」设计，其精髓（垂直切片/一次一问/雾与毕业/决策单源账本）与本平台的独有层——**phase 序列 + 人验收 gate**——需要一次显式的层级抬升改造，而非继续挪用票层标尺。

## 决策

1. **phase 集 = 故事集**：每 phase = 一个**完整用户故事**，叠加在 MVP 之上。phase1 = MVP 薄切片（tracer bullet 本义：**切穿需求最高风险段**，非最简易功能）；其后每 phase 的验收叙事 = 「上次这样 → 现在这样」。可运行可验收（原 deliverable 判据）降为必要条件。
2. **下界**：故事内功能票 ≥3（E2E 票不计）；不足 → 合进邻故事；**MVP 豁免下限**；整需求凑不出 ≥2 个达界故事 → 单 phase 合法（「列不出 ≥2 就不拆」承自 wayfinder「无雾则无图」）。
3. **上界**：由叙事钉——成果内聚、一次坐得下验收；**phase 层不设时间硬顶**（运行期超时仅 ⏳ advisory D18 原样），故事太大 → 拆故事或问用户砍范围，禁止掰成时间块小 phase。
4. **时间锚降回票层**：≤1h/票（E2E 票可放宽至 1.5h）、票 DAG 并行——两层各有不可分资源：票被 agent 认知窗口封顶，phase 被**人的验收注意力**封顶（同形递归，换了币种）。
5. **两段式对话预算**：拆相轮 = 结构 grilling（10~15 轮封顶，fog-or-ticket 判据，禁下钻 phase 内部）；逐 phase 内容轮在拆卡批准后走 matt 三件套；拆卡 = 一表批问硬 gate。超载（收敛不了 / >7 故事）= 上层信号 → map 化拆分或需求再澄清。
6. **写全 + 不画雾**：入队 gate 要求每 phase spec 存在，故起草期写全；但后段 spec 依赖前序处只引用不抄不猜（「依赖 phase i 的 Confirmed Interfaces」/「见 phase i KD#n」前提引用制），毕业 = spec-review 对位前序 handoff.md（0019 既有纪律），不另发明拦截环。
7. **非故事工作**：spike / 纯技术铺路不立 phase（风险前置进 MVP 选题；铺路 = 故事 phase 内 prefactor 票；拆相期判断题走 decisions/ 决策票、拆卡前解）。
8. **沉淀分界**：task 内可逆 → spec K8 表（行/编号稳定纪律不变）；三判据（难逆/惊讶/权衡）且活过 task → docs/adr。K8 表 = 对下游唯一预告账本（草稿态），handoff.md = 运行态，一本账两态。

## 被否方案

- **硬时间双界**（下界 ≥3 票 + 上界 phase wall-clock ≤1.5h，靠 DAG 并发消化）：把 phase 上限绑死在并发能力上，票间串行依赖多的故事必被误杀；且保留「时间钉叙事」的借位思维。
- **纯时间双界**（2h ≤ phase 估计 ≤ 4h）：时间是估计值不是事实，author 估时漂移；未触及验收成本本质。
- **雾占位 + 毕业重写**（wayfinder 严格版：后段只交占位 spec，毕业 = 前序 accepted 后作者侧 grilling）：与入队 gate/autoAdvance 正面冲突（accepted→开轮无人工窗口），需要新拦截机制；「画雾文件」还会静默骗过存在性检查。
- **spike / 技术 phase 例外**：撕开「phase=可交付故事」判据的口子，「DB 层 phase」反面教材重新合法化；无产品验收物的工作在人工 gate 前没有可看的东西。
- **拆分卡加「传给下游」列 / spec 加 For Downstream 节**：草稿态预告与 ship 运行态真值必然漂移，违反 decision single home，gate 多一本要校对的账。

## 后果

- 拆卡列换形：删「预算」列，「票数」→「功能票」（E2E 不计），卡头加「最高风险 → phase1 切穿路径」行——author 的生成顺序（列故事→定界→数票→排依赖）即判据的执行形态。
- 单 phase 回滚粒度变粗：一次打回波及的故事更大——由 round 机制（打回二分路由 0018）承接，非新增成本。
- 防线从「运行期时长」前移到「拆分期票数 sanity」：执行超 ⏳ 不再有「拆得更细」的出口，只有「故事本来该砍」的对话。
- 文本判据 ≠ 行为判据：author LLM 可能滑回票大小拆法——以真需求 dogfood 首航（.scratch/phase-splitting-methodology 票 05）作生效实证，同时补 #51 AC6 的真 LLM 全链缺口。
- 存量 v4 任务不迁移（K13 姿态）；CONTEXT-MAP Phase 词条同步换锚，词表与 SKILL/persona 从此四处同锚（grep 一致性矩阵守卫，ADR 本文件豁免历史引述）。
