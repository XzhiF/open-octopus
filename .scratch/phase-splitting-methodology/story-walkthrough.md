# Story Walk-Through — 拆 Phase 方法论改造（phase-splitting-methodology）

> 模式：spec（对 spec.md 的断言锚逐条 trace 到真实现场文件）。
> 执行：独立子代理，2026-09-06。spec.md 未被修改。
> trace 对象：SKILL.md（core-pack）/ builtin-clones.ts（persona 源）/ **盘上 persona.md**（运行时真身）/ CONTEXT-MAP.md / docs/adr / scripts/sync-builtin.mjs / server 测试 / 本机 dev 实况。

---

## 结论速览

| 断点 | severity | 一句话 |
|------|----------|--------|
| B1 | **CRITICAL** | persona 生效链断裂：运行时读的是盘上 v3 遗物 persona.md（79 行，无「拆 Phase」章），改 builtin-clones.ts 永不生效，全 spec 无人负责把新 persona 落盘 |
| B2 | **HIGH** | frontmatter 旧口径「预算 coding agent 1h / 含 E2E 1.5h」（无冒号）不在任何清零 pattern 内 → AC6 可假绿 |
| B3 | **HIGH** | persona 旧口径实为**两处**（L108 拆 Phase 行 + L155 拆分确认 gate「票归属/预算」），spec 只圈了拆 Phase 行 → 改造后 SKILL 卡无预算列 vs persona 仍要求含，正是本 feature 要消灭的漂移 |
| B4 | **HIGH** | 「旧口径四源零命中」（AC3/实施#5）与 grep 命令实扫三源矛盾；ADR-0020 背景必然引用旧口径，四源版断言不可达成 |
| B5 | MEDIUM | 新判据在场用 OR 备选大正则，任一文件命中 5 串之一即过 → persona 可以只写「见 phase i KD」就绿，US6「同一判据」实际未钉死；`功能票 ?≥3` 对粗体星号/`>=` 写法敏感 |
| B6 | MEDIUM | KD7 全链孤儿（方法论章清单、ADR 决策摘要、AC 三处都没接）；KD8 后半「AC 分层」同样无落点 |
| B7 | MEDIUM | 票 05 载体自相矛盾：实测「全局token计费」草稿存在（无 E2E_TEST 前缀、已绑目录外 matt-dev-pipeline），与 `E2E_TEST_phase-split-dogfood` 新建要求互斥，R7 二选一未裁决 |
| B8 | MEDIUM | dev 跑 dist/index.js 无 watch：票 02 后 :3001 仍旧构建；Prerequisites 缺「重建+重启」环，AC9 前置链断 |
| B9 | LOW | CONTEXT-MAP「System-wide ADRs」列表按惯例应加 0020 行，票 03 改动清单没列 |
| B10 | LOW | 「1.5h 命中 ≤3 处」是估计非枚举，按 KD3 措辞三章各写一遍就到 4 处，人工核对步无判据 |

spec 的绝大多数现场断言**属实**（见文末核对表）：六条旧口径串都真实存在、pattern 的半角波浪号/全角冒号与现场字节相符、K8 纪律段/「不抄前序」段/「>7 阀门」/⏳徽标(D18) 均在场、「保留」类断言有真实对象、0020 号未被占、基线数字与 git log 吻合、PR #57 OPEN。

---

## Story A（US1/2/3/4/7）— 用户与 author 会话走「列故事 → 拆卡 → 逐 phase」全程

happy path，trace 每个触点的**实际装配来源**：

```
用户在看板发起 task-author 会话
  │
  ├─[persona] CloneRuntime.loadPersona()
  │    → 优先读 ~/.octopus/agent/built-in/task-author/persona.md   ← 实测存在，79 行
  │    → 盘上文件是 v3 时代遗物：goal/ac 叙事、无「拆 Phase」章、无绑定目录/D15 段
  │    → builtin-clones.ts 的 81 行 v4 persona（含 L108 旧口径）只是 fallback，从未落盘
  │    → clone-init-service L155-161: "Write default persona.md (skip if exists)"
  │    → clone-resolver.readPersona: 盘上优先，源码兜底
  │    ═══ [断点 B1 · CRITICAL] ═══
  │    票 02 改源文件 → 源码 grep 全绿，但会话拿到的 persona 一个字都不会变。
  │    spec 通篇（Do/实施#2/AC3/票04）没有任何一步负责「persona 落盘生效」。
  │    且 Verification Environment 声称「:3001 本次启动已含…persona…已活」——对盘上真身不属实。
  │    FIX：票 04 增加落位步骤（用 PUT /config/persona 或直接覆盖盘上 persona.md，
  │        或删盘上文件重启让 clone-init 重新 seed），并给 AC9 加前置断言
  │        「rg 完整用户故事 ~/.octopus/agent/built-in/task-author/persona.md 命中」。
  │
  ├─[SKILL] SDK plugin 扫 ~/.octopus/agent/skills/（getPlugins 主 plugin）
  │    → sync-builtin.mjs cpSync force:true 到此 + .claude/skills/   ← 两处现均 3.3.0
  │    → 票 04 `node scripts/sync-builtin.mjs` 后两处 → 3.4.0 ✓ 链路真实成立
  │    → root package.json "build" 尾部本就链 sync-builtin（票 04 单跑冗余但无害）
  │    ✓ 无断点（这正是与 persona 的不对称：SKILL 有强覆盖链，persona 没有）
  │
  ├─[SKILL] 方法论章（新）指导拆卡 → 拆分卡贴回对话
  │    → 卡模板新列（功能票/风险行/无预算列）OK
  │    → 但 persona L155「拆分表（phase 名/范围/票归属/预算）必须先呈给用户确认」仍在源文件，
  │      票 02 若只按 spec 重写「拆 Phase 行」，gate 段残留「预算」枚举
  │      与 SKILL 新卡「删预算列」直接矛盾          ═══ [断点 B3 · HIGH] ═══
  │    → 同理 SKILL 工作总览② L27「票归属/预算」靠实施#1「②微调」覆盖，但清零命令无对应 pattern，
  │      漏改不会被任何断言抓到（SKILL 卡模板 L294-297 的 `| 预算 |`、`~1h`、`~1.5h` 残留同罪）
  │    → frontmatter「预算 coding agent 1h / 含 E2E 1.5h」无冒号，6 条 pattern 全部不命中
  │                                                   ═══ [断点 B2 · HIGH] ═══
  │
  ├─[对话] 15 轮封顶（fog-or-ticket）——锚属实：matt-verified-requirement L250 "Max 15 rounds" ✓
  │
  └─[SKILL] 逐 phase 内容轮 → 前提引用制「见 phase i KD#n」——K8/衔接信道锚均属实 ✓
```

**US7 语义核对**：「作者侧 agent 拿到新 SKILL」——经 B1 修正后成立（SKILL 链完好）；persona 的「拆 Phase 行」在修正前是死文案。

---

## Story B（US6/US8 + AC6）— 维护者跑一致性 grep 矩阵验证四源同锚

```
维护者执行票 04 命令组
  │
  ├─[脚本] 旧口径清零：6 pattern × 3 路径
  │    实测当前命中：单 phase ?= ?coding agent→SKILL L167 ✓；3~5 ?人天→SKILL L167+persona L108 ✓
  │    （tilde 确为半角 ~，与 pattern 字节相符）超过 1\.5h 的 phase→SKILL L349 ✓
  │    ≈1h/phase→CONTEXT-MAP L108 ✓；预算：coding agent→persona L108 ✓（全角冒号相符）
  │    → pattern 本身全部「活着」，不存在写死的死正则 ✓
  │    但覆盖面有洞：① frontmatter 变体（B2）② 卡/总览/gate 的「预算列」枚举（B3）
  │    → 改造后旧口径可以合法残留而矩阵全绿        ═══ [断点 B2/B3] ═══
  │
  ├─[脚本] 新判据在场：五串 OR 备选，逐文件「各≥1」
  │    → 任一文件命中「不画雾」或「见 phase i KD」即算该源在场，核心串「完整用户故事」可以缺席
  │    → persona 票若只写引用句也绿                ═══ [断点 B5 · MEDIUM] ═══
  │    → 「功能票 ?≥3」的 `≥` 是 U+2265，现场若写 `>=3` 或被粗体拆成 `票 **≥3**` → 假红；
  │      若统一措辞又依赖行规。建议 pattern 写成 `功能票[ *≥]*3` 级别宽松 + spec 钉死书写式
  │
  ├─[脚本] 同锚人核：rg "1\.5h" SKILL.md 命中须票层语境，≤3 处
  │    → 改造后合法票层句（方法论/交互/matt 协议/frontmatter）各带一次即 4 处 → 人核必报「超标」
  │      但「超标」无处置定义                    ═══ [断点 B10 · LOW] ═══
  │
  ├─[文件] ADR-0020：docs/adr 最大号 0019 ✓ 0020 空闲 ✓；格式惯例（ADR-FORMAT.md + 0019 实物）：
  │    标题「# 0020 — slug 题」、状态/背景/决策段、可含「否决的备选」（0019 有先例）✓
  │    → spec 要求「被否三案」与 ADR-FORMAT「Considered Options（值得记住才写）」兼容 ✓
  │    → 但 ADR 背景讲「判据借位」必然引用「单 phase = coding agent ≤1h」旧串
  │      而 AC3/实施#5 声称「旧口径**四源**零命中」，命令实扫三源（无 docs/adr）
  │      → 施工者无法同时满足两者                ═══ [断点 B4 · HIGH] ═══
  │      FIX：统一为「操作三源零命中；ADR 豁免并强制以引用块标注历史口径」；US6 第四源限定「决策留痕语境」
  │
  └─[词表] CONTEXT-MAP 改动清单核对：Phase 行 L108 含 ≈1h/phase ✓ 唯一需换锚行；
       Round L109 / 验收Gate L110 / Batch L111 均无时间口径 → 「不动」承诺属实 ✓
       词层澄清行新加：Ticket 定义 L7「单个 context window 内完成」与 KD3「票层容量」互证 ✓
       System-wide ADRs 列表 L152-163 现列至 0019 → 0020 应顺手补行（B9）
```

**测试断言核对**（票 02「若测试断言 persona 文案同步更新」）：全 server `*.test.ts` grep「拆 Phase / 约 1h / 3~5 人天 / 票归属」**零命中**——旧口径无测试锁，「同步更新」是空对象（spec 用条件句，不算错）。但 `persona-v3-instructions.test.ts` 锁着 persona 另三段契约（可用字段+decisions、source_chat_session_id+D15+会话优先、@@spec_updated+system prompt）——票 02 重写拆 Phase 行与拆分确认 gate 段时挨着 L149「可用字段」与 L159「@@spec_updated」，删改误伤即红。建议票 02 Verification 显式列该套件保绿。另注：该测试读 `getBuiltinCloneDef().persona`（源常量）——测试绿≠运行时 persona 绿，B1 的又一佐证。

---

## Story C（US9 + AC8/AC9）— 维护者验收生效链 & 用户 dogfood 首航

```
票 04：node scripts/sync-builtin.mjs
  │
  ├─[脚本] 落位核对「task-author 分身 plugin 落位 SKILL version=3.4.0」
  │    → 分身 plugin 面 = ~/.octopus/agent/（主 plugin，扫 skills/ 直属）→ 该路径实测存在 3.3.0
  │    → sync 后 → 3.4.0 ✓ 断言有真实对象，成立
  │    → 附带 .claude/skills/ 第二落位（本会话/IDE 面）✓
  │
  ├─[回归] pnpm --filter shared build / server test(基线42) / web test(3 files) /
  │    simulate matt-spec-dev（fixture .test.yaml 实测在场）/ playwright 三 spec 文件实测在场 ✓
  │    全部锚属实
  │
  └─[服务] :3001 现状 = dev.mjs spawn packages/server/dist/index.js（**无 watch**）
       票 02 改源后不重建不重启 → dist 仍旧 persona（虽然按 B1 运行时本就不读它）
       ═══ [断点 B8 · MEDIUM] ═══ Prerequisites 只写「本次会话已重启」（写 spec 时点，改造前）
       FIX：票 04 或票 05 前置加「commit 后 pnpm build + 重启 :3001 + 健康检查」

票 05（用户发令，择时）：dogfood 首航
  │
  ├─ Trigger 链逐环：改造全绿(票04) → commit(本会话,KD10) → 重建重启(:3001) — **无人负责**（B8）
  │    → persona 落盘 — **无人负责**（B1）→ sync SKILL(票04✓) → 用户发令(Execution#2✓) →
  │    → 载体拍板(Prereq#3 留给届时) → 看板发起会话 → 拆卡 → 用户批 → 入队 → 首 phase 派发
  │    环上每步有人，但「发令时盘上 persona/SKILL 是新是旧」用户无法自证 → 建议票 05 Verification
  │    第 0 步：现场版本探针（rg version SKILL 落位 + rg 完整用户故事 persona.md），缺则先回票 04
  │
  ├─[数据] 载体实测：GET /api/tasks?status=draft → 「全局token计费」草稿**存在**
  │    （id 1e140941-ed50-474f-9da1-b36f26a2d08d，已含 phase1 绑 built-in/matt-dev-pipeline
  │      ——v3 遗留流、已不在绑定目录）
  │    → 「转正重拆」复用同名草稿违反 R7（E2E_TEST_ 前缀）；新建又与「转正」措斥；
  │      旧草稿还会滞留 draft 池，干扰 persona 发现命令 `.items[-1]` 取「最新草稿」的确定性
  │    ═══ [断点 B7 · MEDIUM] ═══ FIX：二选一并写死（建议：新建 E2E_TEST_phase-split-dogfood
  │      重贴需求 + 旧草稿届时 abort），Prereq#3 相应收口
  │
  └─[反馈回路] AC9 若发现 author 滑回旧拆法（R1 风险兑现）：修复回路=改 SKILL 措辞→回票 01→
       重跑票 04 grep→再 dogfood——spec 未给这条「发现→回修」通道任何票面
       （matt-pipeline-loop 是 feature 间机制，本 feature 出口没接）。建议 Prerequisites 或
       Execution Decisions 补一句「票 05 红 → 回票 01 修订 + 票 04 复跑，不开新票」——
       ═══ 断点类 6（Unconnected Feedback），MEDIUM-LOW，记录即可 ═══
```

---

## 事实核对表（spec 断言锚 × 现场）

| spec 断言 | 现场 | 判定 |
|---|---|---|
| 三源 phase 判据都写 ≤1h/1.5h | SKILL L167 / persona L108 / CONTEXT-MAP L108 | ✓（三处措辞各异，恰证「漂移」命题） |
| 「3~5 人天 ≈ 4~5」与 ≤1.5h 自相矛盾同条内 | SKILL L167 一条之内 | ✓ 根因陈述成立 |
| 旧口径串六条真实可 grep | 逐 pattern 实测命中，半角 `~`、全角 `：` 字节相符 | ✓ |
| frontmatter 含「同串」 | 实为「预算 coding agent 1h / 含 E2E 1.5h」变体，**非**同串 | ✗（B2） |
| persona 旧口径「拆 Phase 行」一处 | L108 + L155「票归属/预算」 | ✗ 实两处（B3） |
| K8 表行/NEW-rN 段保留对象 | SKILL L169 | ✓ |
| 「不抄前序」段在场 | SKILL L168 | ✓ |
| 「>7 阀门同族」 | SKILL L170 | ✓ |
| ⏳ advisory（D18）保留对象 | SKILL L167 尾 | ✓ |
| matt max-15-rounds 抬升 | matt-verified-requirement L250 | ✓ |
| ADR-0018 §6 纪律引用 | 0019 正文重申、0018 在档 | ✓ |
| ADR 0020 空闲 + 惯例 | 最大 0019；ADR-FORMAT.md + 0019 结构 | ✓ |
| sync-builtin 同步范围=skills+agents→.claude + agent/skills | 脚本 L41-53 | ✓（不含 persona——B1 根源） |
| AC8 落位对象存在 | ~/.octopus/agent/skills/task-author/SKILL.md=3.3.0 | ✓ |
| 票 02 测试同步对象 | 无测试锁旧口径串；有 persona-v3-instructions 锁邻段 | △ 空对象+邻雷 |
| 基线 server42/web3/PW14+1skip/simulate5/5 | 与 b1bb8666 提交注、文件在场性一致 | ✓（数值未重跑，取自近 5 次提交注） |
| PR #57 OPEN、分支吻合 | gh 实测 OPEN，标题吻合 | ✓ |
| dogfood 载体草稿 | 存在但形态与 R7 冲突 | △（B7） |
| 拆分卡「风险行」位置 | 卡头一行（实施#1/KD9 一致） | ✓ 非孤儿 |
| 「票层语境」 | =「≤1h/票（E2E 票 ≤1.5h）」票预算句所在的列举/纪律句 | ✓ 语义可执行，靠人核（B10） |

## 逐 KD 落点矩阵（Orphan 检查）

| KD | 实施承接 | AC | 判定 |
|---|---|---|---|
| KD1-3 | 实施#1 方法论章/卡/交互风格 | AC1/AC2 | ✓ |
| KD4 | 实施#1 总览②+协议章 | US3 映射行 | ✓ |
| KD5 | 实施#1 不画雾/写全 | AC1/US4 | ✓ |
| KD6 | 实施#1 前提引用+卡不加列 | AC1 | ✓ |
| KD7 | **无** | **无** | ✗ B6 |
| KD8 前半 | 卡「六问简版」列注 | AC2 | ✓ |
| KD8 后半（AC 分层） | **无** | **无** | △ B6 |
| KD9 | 方法论章风险/铺路 | AC1/AC2 风险行 | ✓ |
| KD10 | Execution#3 + 票 05 | AC9 | ✓ |

## 建议修复汇总（供父代理回填 spec）

1. **B1**：票 04 增「persona 落盘」步骤 + AC9 前置断言盘上 persona.md；更正 Verification Environment 陈述。
2. **B2/B3**：清零 pattern 加 `预算 ?coding agent|含 E2E 1\.5h|票归属/预算`；票 02 圈定 persona L108+L155 两处；票 01 明确 frontmatter 变体串也在清零面。
3. **B4**：统一「操作三源零命中 + ADR 引用块豁免」；AC3/实施#5/US6 措辞对齐。
4. **B5**：在场矩阵改为「核心串『完整用户故事』逐源必命中 + 辅串任一」；钉死 `≥3` 书写式并容忍粗体。
5. **B6**：KD7/KD8 后半并入实施#1 章清单或显式声明不落文本并撤 KD（保持 KD-AC 双向可追溯）。
6. **B7**：载体二选一写死（建议新建 E2E_TEST 任务 + abort 旧草稿）。
7. **B8**：Prerequisites 加「重建 + 重启 :3001」环；票 05 第 0 步版本探针。
8. **B9/B10**：票 03 顺手补 CONTEXT-MAP ADR 列表 0020 行；1.5h 人核改为枚举预期命中清单。
