# exec-perf 归因发现（2026-09-15）

`OCTOPUS_EXEC_TIMING=1` 埋点（provider-query / agent-pre / node-tail / syncStateJson），CLI 直跑 3 节点
agent 链（tiny prompt / sonnet / continue→resume），每节点墙钟 ≈ 3.1-3.4s，分解如下：

| 阶段 | 实测 | 性质 |
|------|------|------|
| spawn → 首事件(`system:hook_started`) | **366-434ms** | 子进程 boot |
| → `system:init` | +~120ms | CLI 初始化握手 |
| → `message_start`(API 首 token) | **~1.45s** | 请求组装（claude_code preset 系统提示 + CLAUDE.md/settingSources 加载）+ API TTFT |
| → `result` | 0.6-0.7s | 真实推理（tiny prompt） |
| result → runner 返回 | ~0.5s | 流收尾 |
| 引擎节点间空隙 | ~0.5s | DAG 调度 + 执行器构建（agent-pre ≈ 0ms） |
| node-tail（onNodeEnd/compact/persist） | **1-3ms** | 可忽略 |

**修正先前两个错误结论：**
1. ~~节点尾 1-9s~~ —— 那是 llm_calls(epoch-ms) 与 node_executions(ISO) 跨表时钟/解析错位的伪影，实测尾开销 ≈ 2ms。
2. ~~每节点 setup 1.5-7.2s 全是子进程冷启动~~ —— boot 只有 ~0.4s；固定开销 ≈ **2.5-2.7s/节点**，大头在
   boot 后到首 token 前（~1.45s）与 result 后收尾（~0.5s）。

**resume 成本 ≈ 0**（boot 419 vs 361ms、首消息 +34ms，小 transcript 下）；globalSessionId 续会话本身不是问题，
历史变大的成本是 API 输入 token（cache_read 22k-50k 已见于真实任务池），属钱/推理时长，不是本地开销。

**日志/DB 写路径结论（本轮已优化项）：**
- DB agent_events 早已批量（50 条/2s 一事务），非逐条；每事件的同步 `findById` 已缓存掉。
- JSONL 从"每 delta 一次 appendFileSync(open+write+close)"改为"每宏任务一次批量 writeSync(持久 fd)"；
  compactFile 读前自 drain，执行结束 `close()` 收尾。语义变化：**文件内容延迟一个宏任务可见**（DB/SSE 不受影响）。
- WAL 补 `synchronous=NORMAL`。
- syncStateJson：当前每工作区 executions ≤9 行，实测非瓶颈，**不动**（前端消费该文件，去抖有无谓的陈旧风险）。

**下一票方向（未定，见 issues/01）：** ~~B 实验~~ **B 已做且证伪**（min-prompt 对照无差异 → 1.45s
主要是 API TTFT，详见 issues/01 文末结果表）；A（常驻进程）收益重估为 ~1.0-1.5s/节点，待用户拍板。
零代码先行：独立小节点 YAML 写 `context: new` 削历史重发。

## 测量复现

```bash
OCTOPUS_EXEC_TIMING=1 node packages/cli/dist/index.js workflow run <probe.yaml> | grep exec-timing
# probe 样例见 /tmp/exec-timing-probe2.yaml（p1→p2→p3 全 continue，覆盖 resume 路径）
```
