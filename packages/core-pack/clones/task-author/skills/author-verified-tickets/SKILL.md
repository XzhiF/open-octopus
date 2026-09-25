---
name: author-verified-tickets
description: Enhancement of to-tickets. Adds verification method binding — every ticket gets executable verification steps. Used as a guide by the main session during author-verified-requirement.
reference-only: true
---

# Verified Tickets — Enhancement of `to-tickets`

Follow `to-tickets` for the base process — tracer-bullet slicing, blocking edges, one ticket per file under `<artifacts.dir>/<feature-slug>/issues/<NN>-<slug>.md`, numbered in dependency order. Split ordering stops at **Pages**: an end-to-end walkthrough is not a DAG stage (③).

The one enhancement: every ticket carries a **Verification Method** beside its Acceptance Criteria. A methodology reference — read while writing issues/, never auto-invoked.

## Template — insert after Acceptance Criteria

```markdown
## Verification Method

**Verification type**: [unit test / integration test / contract test / manual checklist]
（功能票限此四类；走查步归走查票 —— ③）

**Prerequisites**:
- [ ] [e.g. backend compiles / test data ready]

**Verification steps** — 可执行断言，按类型挑一段:
- unit: `pnpm test -t <name>` → 全 PASS
- integration: token → 记 DB 前态 → 调 API → 断业务字段 → DB/缓存回查 → 三方交叉 → 清理
- contract: VO ↔ 前端 interface 的字段、路径、类型逐条对（盯 String vs Number）
- manual: V1/V2… 具体核对项
- walkthrough（仅走查票，形状见 ④）: 登录 → 进入页面 → 操作 → 断言业务值 → 留证据

**Pass criteria**: All steps PASS, evidence chain complete
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
```

## Additional Rules

Apply in order; cite as ①–④.

### ① Verification is executable, and only this ticket's own

具体命令、具体 SQL、具体断言 —— 不是 "test the API"。**只列本票改动/新增的用例**（`vitest run <files>`、`-t <name>`）；**全量套件归 code-review 终检，票内禁跑**。

### ② DAG depth ≤ 2

**深度是硬纪律，票数上限只是它的推论** —— 时长由关键路径决定，不由工作量决定（5 票 4 层串行 58min，并行只救回 17min）。一条 Blocked-by 把图拉成三层链就别拆；被链逼成串行、体量又小（≤1h，走查票 1.5h）的两票**必须合并** —— "地基 + 若干并行 + 汇聚"是最坏形状。一张票 = 一个 session 装得下的实现 + 验证，无互阻的票同阶段并行。

### ③ 端到端走查只有一个归属

一个 phase 只容得下**一张** `NN-e2e-*` 走查票，且**只给末 phase 产**。功能票不起浏览器、不做故事走查 —— UI 的渲染与交互断言收编为走查步，功能票验到 API 响应 + DB 直查为止；写了 browser E2E 就是与走查票双跑。

走查票**是声明，不是开发票**：只写「动作 → 断言」，禁写「编写 Playwright 套件 / 补全量 E2E / 跑全量回归」—— 真起浏览器、选什么框架归 `e2e-verify` 节点（几何见 `task-author`「验证声明」）。它不进 ticket-dag；绑自己按 DAG 跑票的流时它就是普通票、`Blocked by` 是真依赖，两种流票面写法不变。

中间 phase 不产票，改在 spec 写 `Verification Tier: unit-only` 让节点整轮跳过（单节点 25min+），正确性由票的 unit/integration + code-review 兜底；攒下的验收面并进末 phase 那张。模式随验收面自动选：有 UI → browser 走查，无 UI → API 级走查（curl + sqlite + 手算，不给不存在的页面烧成本；spec 显式拍板不做浏览器 E2E 时同样降级，但功能票那条禁令无条件）。既不产票又不写 `unit-only` → 入队 gate 409 `no-final-verification`。

### ④ 走查票形状 —— 验货台的「验收剧本」从它机械解析

形状不对，用户验收时面对空剧本柜。**实票方言**（中文票，推荐）；每步 `动作 → 断言`，可执行断言放行反引号且以命令词起头（curl/sqlite3/mvn/pnpm/node…散文步会降级成人工核对），≤8 步，**节标题必须 h2**（h1 里写「故事走查」不算数）：

```markdown
**类型**: E2E（浏览器走查）      ← 或 E2E（API 级走查，不开浏览器）；裸 `Type:`、「走查模式：」同样认

## 走查步骤
1. 打开 系统管理→Token 计费 → 价格表渲染，列齐全
2. `curl -sf 'http://localhost:8080/api/x?no=123'` → data == true
3. `kill java` → 端口拒连

**Pass criteria**: 全部断言成立，证据贴票尾      ← 裸 `**Pass**:` 同样认
```

**正典方言**：`## Acceptance Criteria` 子弹 + `**Verification type**:` 行 + bash 围栏（取最后一段、≤3 probe）。
