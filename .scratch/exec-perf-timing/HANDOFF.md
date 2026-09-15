# Handoff — feat-exec-perf（workflow 执行性能优化）

日期：2026-09-15 · 分支：`feat-exec-perf`（本地已建，未推送时以本文为准）
上一会话产出：分析 → 3 项写路径优化 + 耗时埋点 + 归因实验（2 commits：`33b0a170`、`16f20547`）

## 任务背景

用户反馈 workflow 运行慢，怀疑 JSONL 日志写 / DB event 写是同步导致。结论：**部分是（JSONL 每事件
`appendFileSync`；事件热路径每 delta 一次同步 `findById`），但不是主因**——真正的每节点固定开销在
Claude Agent SDK 子进程链路。完整实测分解与两条候选路线已落盘：

- `.scratch/exec-perf-timing/findings.md` — 阶段耗时表 + 两处被修正的误判（勿重复推导）
- `.scratch/exec-perf-timing/issues/01-per-node-fixed-cost.md` — 候选 A（常驻 streaming-input 进程）vs
  候选 B（先拆 boot→首token 的 ~1.45s：settingSources 关闭 + 极简 systemPrompt 对照实验），含 A 的硬约束与 ADR 要求

## 下一会话聚焦（用户指定）

先做 **候选 B 的对照实验**，再定 A 是否立项：

1. 在 `packages/providers/src/claude/provider.ts` 的 `sdkOptions` 构造处（约 L323）加两个 env 开关（临时、不上 YAML）：
   - `OCTOPUS_TIMING_NO_SETTINGS=1` → `settingSources: []`
   - `OCTOPUS_TIMING_MIN_PROMPT=1` → `systemPrompt` 用极简字符串替换 `{type:'preset',preset:'claude_code'}`
2. 复用现有埋点跑 `/tmp/exec-timing-probe2.yaml`（p1→p2→p3，3 个 tiny agent 节点，覆盖 continue→resume）：
   `OCTOPUS_EXEC_TIMING=1 node packages/cli/dist/index.js workflow run <yaml> | grep exec-timing`
   对比默认值 `boot_ms≈400 / first_msg_ms≈2000`（sonnet）。
3. 判读：`first_msg_ms` 显著下降 → 本地组装占大头，B 直接落地（评估把开关正式化为 node 级配置）；
   基本不动 → 大头是 API TTFT，B 无肉，按 issues/01 启动 A（**先出 ADR**：常驻进程生命周期/取消/重试/预算归属）。
4. 实验后**移除两个临时 env 开关**（保持 provider 干净），埋点保留（env 门控，默认零开销）。

## 已落地改动速查（细节看 diff，别重读全部）

- `logger.ts`：JSONL 每事件 `appendFileSync` → 每宏任务批量 `writeSync`（持久 fd；`flush()/close()`，
  compactFile 读前自 drain）。**语义变化：文件内容晚一个宏任务可见**（SSE/DB 不受影响，compact 后终态完整）。
- `EngineCallbacks.ts`：每 agent 事件的同步 `findById` → 每执行闭包缓存一次 `workflowRef`。
- `connection.ts`：WAL 补 `synchronous=NORMAL`。
- 埋点四件套（`OCTOPUS_EXEC_TIMING=1`）：`provider-query` / `agent-pre` / `node-tail` / `syncStateJson`。
- **明确不做**：syncStateJson 去抖（实测非瓶颈 + 前端消费该文件）；`#5 见 findings.md`。

## 验证基线（改动前 main 即如此，勿误判为回归）

- server：42 failed（本分支 36，转绿的 6 个是 logger 同 tick 可见性用例，测试里补了 `logger.flush()`）
- engine：4 failed（swarm-host-agent TC-037 ×3、outputs-resolver、wf-e2e-tester/pr-workflows 文件级）
- providers：11 failed
- 全绿项：`pnpm --filter @octopus/{shared,providers,engine,server,octopus} build` + engine/providers/server 中本次触及的测试文件
- 跑新测试前先 `pnpm --filter @octopus/engine build`（server 测试 import 的是 dist）

## 注意事项

- 工作区曾有未提交改动混入：本分支 commit 前 `git status` 核对 diff 范围。
- 仓库没有 swe-report.md 要求；feature 收尾面 = spec / ADR / index。A 立项才需要 ADR。
- findings/issues 已提交进 git；若远端分支已建可 `gh` 查看（origin: XzhiF/octopus）。
- 测量用 tiny prompt，真慢工作流的节点还有推理时长/工具轮差异——别把探针数字当节点墙钟总账。

## 建议调用的技能（suggested skills）

- `octo-engine-debug` — 引擎回调/SSE/VarPool 排查手册（改 provider/engine 热路径前先过一遍心智模型）
- `octo-debug-workflow` — 造测试 workflow + 执行监控，候选 B 实验可直接复用其流程
- `tdd` / `matt-verification-report` — 若 B 转正为 node 配置或做 A，先立验证判据再实现
- `code-review` — 每个实现 commit 后
- `grilling` / `domain-modeling` — A 的 ADR 决策（生命周期、失败语义）适合对抗性审一遍再写
- `matt-verified-requirement` — 若用户决定正式立项 A（含 spec + 验证策略）

## 快速接手指令

```bash
git log --oneline main..feat-exec-perf
git show 33b0a170 --stat; git show 16f20547 --stat
cat .scratch/exec-perf-timing/findings.md .scratch/exec-perf-timing/issues/01-per-node-fixed-cost.md
```
