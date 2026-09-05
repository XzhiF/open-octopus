# 0019 — phase 衔接信道：ship 产 handoff.md + accepted 时 server 自动注入 prev_handoff_paths

## 状态

Accepted（2026-09-05）· 扩展 ADR-0018 §2 spec 家族表（新增 `handoff.md` 行）；不改写其任何决策

## 背景

v4 多 phase 任务的跨 phase 上下文信道只有 spec 文本（起草期人工转述）。phase i accepted → `dispatchPhaseRound(i+1,1)` 即时开下一 phase，但 i+1 的执行会话对 i 的 round-report / 修订后 spec 终态 / PR / 遗留缺口**运行时不可见**——衔接断点与「人工转述」是同一根因的两面。

`matt-spec-dev` 的 handoff 方法论是半截活：`requires.skills` 已挂 `mattpocock-skills/handoff`、`ship-pr` 提示词写「使用 handoff skill 方法论」，但无文件产物定义、无放位、无消费方（每轮实际只产 `round-report.md`，受众=验收人）。

同仓库先例：`matt-dev-pipeline` ship 段用 handoff 产 `iteration-handoff.md`（Protected Decisions / Confirmed Interfaces / Gap Targets）解了**迭代级**衔接；缺的是 **phase 级**。

## 决策

### 1. 产物：handoff.md = ship 每轮末产/覆写，落批次目录

- 写方 = `matt-spec-dev` 的 `ship-pr` 节点（ws 批次目录），collect 自然回流 home——seed/collect/mtime 协议零触碰。
- 结构 = 头块（phase · 终态轮次 rN · PR 链接 · 批次路径）+ 三段式沿用 `iteration-handoff.md`。与 round-report.md 的分工：**round-report 给验收人（全量轮报），handoff 给下游执行会话（精选短页，一屏内，引用不复制）**。
- 覆写语义 ⇒ accepted 那刻它天然是终态交接；打回轮的交接也不丢（裁决人可对照上轮 handoff 决策——被视为优点）。

### 2. 信道：server 自动注入 `prev_handoff_paths`（内置键，非占位符）

- `acceptance()` accepted→下一 phase 与手动推进两处，`dispatchPhaseRound` 把**全部已 accepted 前序**的 `{specDir}/handoff.md` 绝对路径（存在性过滤、换行连接）append 进 materialized input_values——与 `feedback`/`task_artifacts_dir` 注入同族。
- **否决的备选**：
  - `${prev.*}` 词表扩展——把信道可靠性押回起草纪律，每 phase 要记得绑、绑错静默失效；且占位符只搬路径不解决「作者会不会写」。
  - ws sibling 批次枚举（spec-resolve 自扫）——**各 phase 可绑不同 workspace**，前序批次目录在 i+1 的 ws 根本不保证存在，先天残缺。
  - accepted 后专产 handoff 的独立 agent/流段——多一次调度，且失败轮交接信息丢失。
  - 草稿会话（task-author clone）跨 phase 续聊——会话记忆的价值恰是 handoff 要产物化的东西，文件是更好的记忆（可审/diff/留档）。
- home 绝对路径直读的安全性论证：phase i accepted 后其 home 终态**不再变化**（不会再跑），无 ws/home 漂移面——同 ADR-0018 §5 打回 fix 路由 `feedback_path` 直读 home 的先例。
- 只注路径不注内容：input_values 保持瘦，agent 自己 Read；空列表不注入键。

### 3. 消费：spec-resolve 探测 → vars → 三处提示词

`spec-resolve` bash 逐行探测存在性写 `vars.prev_handoffs`；`spec-review` / `ticket-dag` 票模板 / `ship-pr` 提示词各加「先读前序交接」。自定义流不消费 = 信道静默失效，由 task-author SKILL 提醒作者（纪律载体=SKILL/提示词，不是 server 代码——ADR-0018 §6 延续）。

### 4. 不变量

信封 `phases[]` 冻结不破（K16）；`template-resolver.ts` 零改动；无 DB schema 变更；无新端点。UI 最小可见面 = 验收弹窗一行提示（衔接要在决策点可见；批次清单靠既有 home-file LIST 自动呈现 handoff.md）。

## 后果

- 正面：phase→phase 上下文交接从「人工转述」变「自动产物环」；handoff 方法论在两个粒度（iteration/phase）统一；起草 spec 更薄（引用前序而非抄写）。
- 负面/风险：bash 节点对 home 绝对路径的可读性需实现第一跳验证（基线 path-guard 域有红），退路=seed 顺带拷前序 handoff（动 seed 协议，尽量避免）；ship 崩溃轮无 handoff → 信道静默缺一角（存在性过滤吞掉，验收人批次清单可见缺失）；存量任务不迁移。
