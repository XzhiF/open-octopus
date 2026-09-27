# `scripts/pg-perf/` — P1 判据度量手段（事件循环阻塞监控 · 执行链路 p99）

> 对应 `.scratch/20260927-kb-roadmap/plan.html` P1 退出判据的②③两条：
> **② 执行链路 p99 不劣化** · **③ 事件循环阻塞监控为空（异步化后不应再有任何 >50ms
> 同步 DB 调用 —— 这条同时是「漏 await」的探测器）**。
> handoff 文件「遗留」节点名任务：B5/B6 期间建 —— 本目录即该度量手段，供 P1 判据总验用。

## 文件

| 文件 | 职责 |
|---|---|
| `common.mjs` | 公共件：依赖解析（从 `packages/server` 只 import，不触碰其源码）、nearest-rank 百分位、结果 v1 JSON 格式读写、SQLite 临时 scratch 库、PG 随机 perf 库 lifecycle（`octopus_perf_<12hex>`，DROP 护栏正则） |
| `workloads.mjs` | 负载目录：确定性种子数据集（固定种子 PRNG）+ 19 条代表性读/写/事务 op + 1 条 `chain.exec_round`（执行链一轮），每条镜像一个真实 DAO 调用点的两引擎等价 SQL（`dao:` 字段标出处） |
| `bench.mjs` | p95/p99 延迟基准：`--engine both|pg|sqlite`，输出终端表 + JSON 落盘 `results/` |
| `compare.mjs` | 判据②裁决器：两份 bench JSON 对比 p99 表 + PASS/FAIL（exit 0/1） |
| `eloop-monitor.mjs` | 判据③监控：`monitorEventLoopDelay` 窗口采样，`--load pg`（异步 PG 负载）/ `--load sqlite-sync`（正对照标定）/ `--attach -- <cmd>`（活体监控 server） |
| `eloop-bootstrap.mjs` | 经 `NODE_OPTIONS --import` 注入被监控进程的采样探针（零侵入，不改 src） |
| `results/` | 结果落盘目录（`.gitignore` 挡产物；报告引用的数字都来自这里的 JSON 文件） |

## 红线（代码层面已钉死）

- **真库 `postgres://octopus:octopus@127.0.0.1:5432/octopus` 只读**：PG 写基准一律
  `OCTOPUS_PG_TEST_URL` 派生随机库 `octopus_perf_<12hex>`（TEMPLATE `octopus_template` +
  PG schema 幂等重放，模式照 `packages/server/src/db/pg/__tests__/harness.ts`），
  `close()` 里正则不过就拒绝 DROP —— 与测试 harness 同款护栏，代码层面删不到
  `octopus` / `octopus_template`。
- SQLite 写基准打 **系统临时目录的 scratch 库**（重放 `src/db/schema.sql`），绝不碰
  `~/.octopus/db/octopus.db`。
- 本目录**只新增文件**；对 `packages/server/src` 与 DAO/registry/routes 零改动、零 import
  （只 `require` 其 node_modules 里的 `better-sqlite3` / `postgres`，同 pg-migrate 票姿势）。

## 快速开始

```bash
# 判据②：p99 基准（一次跑齐 sqlite 旧路径基线 + pg 现值）
OCTOPUS_PG_TEST_URL=postgres://octopus:octopus@127.0.0.1:5432/octopus \
  node scripts/pg-perf/bench.mjs --label b5-baseline --repeat 3

# 判据②对比（严格不劣化 = 默认容差 0；噪声容忍值由总验人显式给）
node scripts/pg-perf/compare.mjs \
  --baseline scripts/pg-perf/results/bench-sqlite-<stamp>-b5-baseline.json \
  --current  scripts/pg-perf/results/bench-pg-<stamp>-b5-check.json \
  --class chain,tx            # 跨引擎总验口径（见下「判据②的口径」）

# 判据③：事件循环阻塞监控（异步 PG 负载，PASS=无非空阻塞窗口）
OCTOPUS_PG_TEST_URL=postgres://octopus:octopus@127.0.0.1:5432/octopus \
  node scripts/pg-perf/eloop-monitor.mjs --load pg --duration 12000

# 判据③探测器标定（正对照：旧同步路径必须被看见阻塞，否则工具可疑）
node scripts/pg-perf/eloop-monitor.mjs --load sqlite-sync --duration 6000

# 判据③活体监控真实 server（不起负载也要盯：启动 + 驻留期采样）
node scripts/pg-perf/eloop-monitor.mjs --duration 20000 -- \
  node packages/server/dist/index.js
```

各脚本 `--help` 有完整参数表。

## B5/B6 判据总验 Runbook

### 判据②「执行链路 p99 不劣化」

1. **锁基线（B5 开工前，本票合入后即可做）**：
   `bench.mjs --engine sqlite --label BASE --repeat 3`（sqlite 引擎 = 旧路径等价操作集）。
2. **收口复测（B5/B6 各自总验）**：
   `bench.mjs --engine pg --label CHECK --repeat 3`（同机、同 scale/seed/iterations/repeat）。
3. **裁决**：`compare.mjs --baseline BASE --current CHECK [--tolerance <pct>]`。
   - exit 0 = PASS；任一 op p99 超容差 = FAIL（exit 1）。
   - **口径（重要，不隐藏）**：plan 原文是「执行链路」p99。跨引擎逐语句对比会被
     「嵌入式同步调用 vs 客户端-服务器往返」的物理形态支配（本机实测每语句
     ~1.3ms 往返固定成本），这不是「链路劣化」的信号；因此**跨引擎总验用
     `--class chain,tx`**，比的是 `chain.exec_round`（一轮执行实例全生命周期 18 条
     DAO 等价语句串联）与 B5 事务簇形态的链路级 p99；逐语句行做诊断。
     同引擎回归（B5 前后各跑 `--engine pg`）则全类别纳入 —— 形态固定，任何劣化都真。
   - 容差默认 0（判据原文没有放宽额度）；总验若要容忍测量噪声，**由人显式给
     `--tolerance`** 并写进验收记录，工具不代裁。
4. **噪声协议（实测得出，必守）**：
   - `--repeat 3` 起（样本×3 后同配置两次运行 p99 偏差实测收敛到 ±10% 级；
     `--concurrency 8` 下尾噪可到 2 倍，判据用默认 1）。
   - 每个测量周期先跑一次「热机跑」丢弃结果（暖 PG 实例/页缓存），再跑正式跑。
   - 测量写 op 会推进数据状态（claim、乐观锁、chain 状态机）——两引擎同形态，
     对比必须同参数同轮数。

### 判据③「事件循环阻塞监控为空」

1. **有效性标定**：`--load sqlite-sync` 必须**非空**（实测窗口 max 69–142ms 全检出）。
   探测器看不见同步阻塞 = 工具不可信，先修工具再谈判据。
2. **正式监控（两个面都要空）**：
   - `--load pg`（异步 PG 代表性路径 12s+，含 `--pool-max` 10 的排队形态）；
   - `--attach -- node packages/server/dist/index.js`（真实 server 进程驻留采样；
     bootstrap 探针经 `NODE_OPTIONS --import` 注入，**不改 src 任何文件**。启动期、
     调度器与真实流量都在窗口里）。B5/B6 总验时建议挂满一个真实工作流执行周期。
3. **裁决口径**：`monitorEventLoopDelay` 每 250ms 窗口取 max；阈值 50ms（判据原文
   「>50ms 同步 DB 调用」）。**任何窗口 max >50ms → 监控非空 → FAIL**；
   PASS 时打印 min/mean/p99/max + 窗口数 + ops 数（`>阈值阻塞窗口：0 个` 即
   「监控为空」的可核对格式）。JSON 落盘含逐字段统计 + 阻塞窗口清单，可复核。
4. **attach 模式注意**：NODE_OPTIONS 会被 server 再 spawn 的 node 子进程继承 ——
   同文件多进程追加带 pid 的窗口行，聚合端按行合并；语义上等价于「整棵 node 进程树
   都不许阻塞 >50ms」，与判据方向一致（更严不更松）。

## 已知局限（如实登记）

- op 目录镜像 DAO 等价 SQL 而非调 DAO 本体（红线：禁碰 src；且 registry 的 lazyDAO
  会连真实全局池）。B5/B6 后若需「按真实代码路径」复测，正路是把 bench 的 op 表
  升级成对 `src/db/dao/*` 的 vitest harness 引用 —— 届时属 B6 收口票范围，不是本票。
- PG 侧 statement 走 `sql.unsafe(sql, params)`（与 DAO 的 tagged-template 同一
  prepared/extended 协议）；不含 `pool.ts` 计数 Proxy 层（那是应用记账，不影响延迟）。
- 跨引擎链路 p99 的物理差（~1.3ms/往返）在单机 Docker 网络下是常数主导；若判据总验
  要求跨引擎数字直接比，请用 `--class chain,tx` 并在验收记录里写明口径（见上）。
- `sqlite-sync` 标定模式为放大阻塞信号用「整库装载进单同步事务」的超浓形态，
  不代表旧路径单查询的真实阻塞量级。
