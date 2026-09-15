# Issue 01 — agent 节点固定开销 ~2.5s 的结构性优化（常驻进程 vs boot 裁剪）

Label: needs-triage → **B 已实验证伪，仅剩 A 决策**（见文末实验结果）
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

~~B 的实验（半天）→ 拿数据定 A 要不要立项。~~ **已执行，结果见下。**

## 候选 B 实验结果（2026-09-15，provider 临时 env 开关，测毕已移除）

**扩样本两臂对照（5 节点 continue 链 ×2，tiny prompt / sonnet，共 10 个节点样本）：**

| 臂 | n | first_msg 中位 | 均值 | 范围 | boot/init/result |
|---|---|---|---|---|---|
| default（claude_code preset） | 5 | 1855ms | 2173ms | 1758-2768 | 持平 |
| min-prompt（极简 systemPrompt） | 5 | 2020ms | 2049ms | 1742-2417 | 持平 |

均值差 124ms（σ≈400ms，噪声带内；中位数还反向）→ **preset 系统提示的本地组装/上传不是那 1.45s**，
B 判死。`NO_SETTINGS` 组未跑（其作用区间在 init 前，init 全程 ≈0.5s，上限 ~0.2s）。

**副产品——resume 历史增长不抬 TTFT**：default 臂序号↔first_msg 相关 **-0.85**（n1/n2 2661/2768 →
n3-5 ~1800），即链上越跑越快，服务端 prompt cache 预热压过了历史变重的影响。含义：
`context: new` 的卫生化省的是 token 钱（真实任务池 cache_read 22k-50k/节点），**不是时延**。
（tiny 规模结论，大 transcript 下可能反转。）

## A 的收益重估（决策前必读）

A 省不了 TTFT。常驻进程可消灭的是每节点的 boot(0.4s)+init(0.12s)+部分 result 后收尾(0.5s)
+ 节点间空隙(0.5s) 中属于"进程生命周期"的部分 → **诚实预期 ≈1.0-1.5s/节点**（不是最初口头的 2s）。
碎节点工作流（15-30 agent 节点）一轮省 15-45s；是否值当引擎"一节点=一次 sendQuery"假设重构 +
取消/重试/预算归属重设计 + ADR，由用户拍板。

**零代码替代（定位修正）**：独立小节点 `context: new` 省的是 **token 钱**（真实任务池 resume 每节点
重发 22k-50k 历史）——上面的副产品实验显示它对**时延无益**（链上 cache 预热反而越跑越快），
别拿它当性能手段，只当成本控制手段。

## 已落地的前置项（本分支 feat-exec-perf）

- `OCTOPUS_EXEC_TIMING=1` 埋点四件套：provider-query / agent-pre / node-tail / syncStateJson
- JSONL 批量写、事件热路径 findById 缓存、WAL synchronous=NORMAL
