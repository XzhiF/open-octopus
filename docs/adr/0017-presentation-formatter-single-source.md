# ADR-0017: PresentationFormatter — 展示层格式化器单源（五函数收 113 处 toFixed，拆秒/毫秒同名雷）

Date: 2026-08-30
Status: Accepted
Related: 承接 ADR-0016（C3 把 `—/≈/$` 三态数据源 `totals.cost` 备到 wire，本篇是其展示端终点）；豁免机制 `// fmt-ok:` 同构于 ADR-0016 的 `// ledger-ok:`

## Context

C3 之后，web 拿到的每个数字都语义正确，但**渲染它们的笔有 100+ 支**：

- **两套旧库并存**：`lib/format.ts` 与 `lib/analytics-format.ts` 各持 `formatDuration`——同名不同单位（秒 vs 毫秒），import 错文件即静默 1000 倍误差；各持 `formatTokenCount`（幸而行为等价）。合计 6 个导出、零测试。
- **货币 33 处各写各的**：`formatCost` 逐字内联副本 ×3（dashboard 排行榜三胞胎）+ 变体 ×4（model-usage-row 丢 `complete`、execution-summary 自适应精度孤例）；同一屏 hero 显示 `$0.05`、排行榜显示 `$0.0500`；null 文案三种（`未定价` / `-` / `—`）；`≈` 位置两种（前缀/后缀）；observability 面板列表行把未定价 `?? 0` 渲染成 `$0.00`（假 0 病的展示端表亲）。
- **时长 8 种方言**：`45s` / `26min 21s` / `2m 5s` / `2m5s` / `1.2min` / `2分5秒` / `1h 5m` / `1.5s`——14 份私有副本 + 15 处裸 `(ms/1000).toFixed(1)}s`。
- **Token 12 份实现**：summary-bar 缺 M 档（长会话出 `1500.0K`）、cost-tab `toFixed(0)K`（与他处 1 位不一致）、archive 行内 `fmt` ×2。
- **百分比 16 处裸拼**：同一指标 cacheHitRate 一处 0 位一处 1 位；一处 `>1` 嗅探入参量纲（脏快照防御混进了格式化层）。

deletion test：删掉「格式化单源」这个概念，108 处内联 `toFixed` 在原地复活，秒/毫秒雷继续埋着。

## Decision

1. **单一 home = `lib/format.ts` 单文件**；`lib/analytics-format.ts` 整文件删除、不留 alias（C1/C3 先例）。
2. **五函数定稿接口**：
   - `formatCost(usd: number|null, complete = true)` —— C3 `LedgerCost` 三态的展示端唯一解释器：`null → "—"`（未定价，全站统一破折号，中文「未定价」退出）；`complete=false → "≈$"` 前缀；**自适应精度 ≥$1 两位 / <$1 四位**（终结同屏双版本，qwen 级小金额不失真）；千分位。
   - `formatTokenCount(n: number|null)` —— 十进制 1000、K/M 一档一个小数；M 档全站必有。
   - `formatDuration(ms: number|null)` —— **全站唯一毫秒入参**（秒版废除，调用方对秒制字段显式 `* 1000` 换算）；四档 `850ms / 45s / 26m 21s / 1h 17m`；null/NaN/≤0 → `"—"`；业务态文案（「进行中」）留在调用方 wrapper。
   - `formatPercent(rate: number|null, digits = 0)` —— 入参量纲强制 0–1（与 C3 cacheHitRate 同轨）；脏快照的量纲嗅探属数据入口清洗，不进格式化器。
   - `formatBytes(n: number|null)` —— 1024 家族唯一实现（token 1000 与 bytes 1024 是两个合法家族，勿混用），SI 空格惯例。
3. **有意不收编**（防过度收敛）：score 域 `toFixed(2/3)`（matchScore/consensus——语义数字非量纲）；明细弹层 `.toLocaleString()` 全量值（详情精确/徽章缩写是**分层**，不是分歧）；recharts 轴刻度、chat 流式协议文本以 `// fmt-ok:` 行内豁免（helper 化收敛豁免点，如 histogram `fmtAxisSec`）。
4. **防复活门禁** = `lib/__tests__/formatter-revival-gate.test.ts`：扫 web 全部生产源码，禁四类正则（`$${}` 货币模板 / 私有 `format*` 副本定义 / `toFixed(…)}s|m` 时长拼接 / `toFixed(…)}%` 百分比拼接），豁免须带 `fmt-ok:` 标记；并锁 `lib/format.ts` 为全站唯一 `format*` 导出点。

## Consequences

- **正向**：locality——金额精度、时长档位、破折号文案的任何再决策只改 `lib/format.ts` 一个文件；leverage——`totals.cost` 三态到 UI 只经一个解释器，`≈`/`—` 语义不可能再渲染分歧；秒/毫秒同名雷从根拆除（tsc 曾抓不到的那类静默 1000 倍 bug 不再有产生面）；`1500.0K`、未定价 `$0.00` 假数、`formatCost` 丢 `complete` 变体随副本删除而结构性消失。
- **代价与可见变化**（纠错性）：`1.5s→2s`、`26min 21s→26m 21s`、`2分5秒→2m 5s`（中文档收编）；`未定价`→`—`；<$1 金额统一 4 位（hero 总成本、cost-line 等）；成功率徽标 0 位小数统一；archive 快照 0 耗时从 `0s` 变 `—`。
- **已知边界**：`ChatArea` 的 `contextUsage.percentage` 量纲未经 server 端核实（providers wire 无注释），以 `fmt-ok` 豁免挂观察，待查后收编；web `lib/analytics-types.ts` 已对齐 C3 三态，但 `archive-analysis-assembler.ts:103` 在 server 侧把 null cost 折 0 聚合（archive 域遗留，非本篇半径）；`harness-floating-panel` 等 3 例基线红（DOM 交互测试）与本刀无关，未顺手修。
- **测试基线**：`lib/__tests__/format.test.ts` 49 例金表（三态/精度跳档/K↔M 阈值/四档时长/1024 边界）+ 门禁 3 例；tsc/vitest 与 HEAD 基线例级 comm 零新增，顺治 `token-detail-popover` 2 例基线红（新签名吸收 `undefined`）。
