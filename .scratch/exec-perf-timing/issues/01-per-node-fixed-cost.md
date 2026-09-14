# Issue 01 — agent 节点固定开销 ~2.5s 的结构性优化（常驻进程 vs boot 裁剪）

Label: needs-triage
Blocked-on: findings.md 的分解数据

## 背景

3 节点 tiny-prompt 探针实测：每 agent 节点固定开销 ≈ **2.5-2.7s**（不含推理），构成：

```
spawn/boot          0.4s
init                0.1s
组装+API 首 token    1.45s   ← 最大单项
流收尾              0.5s
引擎节点间空隙       0.5s
```

碎 agent 节点多的工作流（spec-dag T-x、loop 多迭代、swarm 专家）按节点数线性付这笔税。
prewarm 只能藏 0.4s，价值低；真正的两条路：

## 候选 A：常驻 streaming-input 进程

SDK `query({ prompt: AsyncIterable })` 支持进程挂活、多条 user 消息续写。把"一节点 = 一次 sendQuery =
一次子进程"改为"连续节点 = 同一进程内的续轮"。

- 预估收益：boot+init+部分组装 ≈ **1.5-2s/节点**
- 硬约束：相邻节点的 SDK options 必须同构（model/systemPrompt/skills/agents/tools/hooks/maxTurns）——
  异或则退化为新开进程；`setModel` 可热切换 model，其余字段不行
- 引擎改造面：节点=进程的假设渗透在 runner 重试/resume、取消（每节点独立 AbortController）、
  usage/result 边界归属（result 消息 = 进程轮终态，常驻后需新边界信号）、swarm/loop 嵌套复用
- **需要先写 ADR**（生命周期、失败语义、预算归属）

## 候选 B：boot 后 1.45s 拆解 + 裁剪

先做一次对照实验，把 1.45s 拆成「本地组装」vs「API TTFT」：

1. 同一 tiny prompt，节点级开关 `setting_sources: []`（不加载项目/用户设置与 CLAUDE.md）
2. `systemPrompt` 从 `claude_code` preset 换成极简字符串（preset 是数十 KB 上传）
3. 对比 `first_msg_ms` 的变化量

若组装占大头 → B 直接吃掉 1s+/节点，零引擎重构，A 可以缓一缓；若 TTFT 占大头 → B 没肉，全力 A。

## 建议顺序

B 的实验（半天）→ 拿数据定 A 要不要立项。A 若立项，按 repo 流程出 spec + ADR-00xx。

## 已落地的前置项（本分支 feat-exec-perf）

- `OCTOPUS_EXEC_TIMING=1` 埋点四件套：provider-query / agent-pre / node-tail / syncStateJson
- JSONL 批量写、事件热路径 findById 缓存、WAL synchronous=NORMAL
