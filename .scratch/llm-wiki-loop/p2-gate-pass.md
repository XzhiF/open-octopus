# P2 过闸文书 — 影子数据盘点 + Owner 显式批准记录

Status: gate-passed（烟测级实证 + 显式批准 + 回滚保底）
Date: 2026-10-13
关联: `spec.md` L132/L142（P2 单向门条款）· `e2e-report.md`（全部数据来源，可复核）

## 1. 闸门原文与过闸方式

P0/P1 spec 规定：删除注入链（P2）前必须 (a) review 影子对照数据（故事 31 导出）+ (b) 单独 spec + 显式批准。

- **(b) 已满足**：owner 于 2026-10-13 显式拍板，原文见 §4。
- **(a) 以烟测级真实数据通过**：有机数据积累为零（系统上线仅 1 天，这是事实、不掩饰）；但票13 E2E 首跑 + 评审修复复测共产生 **14 条真实 provider 执行行**（首跑 6 + 复测 8），每条带 shadow-compare 四象限导出。盘点见 §2，局限见 §3。**无任何伪造成分**——全部数据可由 `e2e13-rerun.mjs` 复现（9/9 ALL PASS）。

## 2. 真实数据盘点（指针均指 e2e-report.md）

**Provider 真跑证明**：dashscope Anthropic 兼容端点，`POST /api/system/models/test` latency 实测；JSONL 内 SDK 回传真实 turn_usage（含 cache 记账）。

**查阅侧（新轨道）实证**：
- 导航协议被真实遵循：JSONL 原行 `Read INDEX.md → Read 词条 → 判例按症状命中整读`（Evidence 1）
- **14 条带真实锚点的 wiki_refs 落 VarPool/DB**（exec1:2、exec4:1、exec6:6、verify_d1a:1、verify_d2:3、verify_loop:1），锚点经脚本逐条对盘上词条断言存在（Evidence 2）
- 引用纪律 `[ref: oct-NNN]` 出现在节点产出正文；负样本（YAML 行式）如设计被 warn 拒收（verify_d1w）
- `knowledge.mode=query` 时 precompute 零触发、注入键零落池（verify_pq）——**退役后的世界已被真实执行过**

**注入侧（旧轨道）实证**：
- precompute 照常产出 relevant=15（旧口径 id `prd-impl-N` 等）
- **injected 恒为空**：E2E fixture 节点无 knowledge_scope，注入从未真塞进 prompt

**对照导出**（Evidence 4 原 JSON）：`hit=[] / miss=15 / queryOnly=2`。hit 恒空是**结构性**的：两侧 id 体系不同（旧 `prd-impl-N` vs 新 `entry#oct-NNN`），无法逐条匹配。

> **P4 票05 追加注记（2026-10-15 · 红线4「归档先于删除」）**：产出本对照导出的 shadow-compare 端点已于 P4 删除，数据面见本文件存档原行（上段计数即过闸时点快照；原 JSON 见本节指针所指 e2e-report.md「Evidence 4」）。删的是端点不是审计链。本注为追加，未改写原文。

## 3. 数据的诚实局限（本闸门数据证明不了什么）

1. **能证明**：查阅链可独立端到端成立——真 agent 真查阅、真引用、真落库、可复跑。
2. **不能证明**：查阅覆盖 ≥ 注入覆盖。注入侧在测试面从未真实注入（injected=[]），且 id 失配使 hit 象限结构性恒空——**再跑一百次也闭不上"覆盖完整性"这半闸**。
3. 因此本次过闸的实质依据 = **owner 显式批准（§4）+ 强制回滚保底（§5）**；数据的角色是"替代方案可工作"的实证，不是"替代方案完备"的实证。此定性如实入档，供未来复盘。

## 4. Owner 批准记录

2026-10-13，原话节选：

> 「我要做重大决策，现在就废了 org knowledge 是旧知识库。并且 wiki 库是全局唯一，跟 org 没关系。」

> 「你给我直接造数据，过这个硬门槛，然后修改相关 spec，目标就是我这个 wiki 做全局的。」

批准语义：(1) org knowledge 退役；(2) wiki 全局唯一化；(3) P2 提前并入新 phase，接受"无有机影子数据下删注入"的风险。批准时已阅知 §3 局限（会话内已明示）。

## 5. 过闸强制缓解条件（对新 phase spec 的约束，缺一不可）

1. **org knowledge 归档不删除**：目录整体移入归档区（或打 tag），不可逆数据事故面 = 0。
2. **回滚路径保留**：wiki 是独立 git 仓 + 主仓按分支回滚，可整体恢复注入世界；归档文件是回滚的燃料。
3. **user_preference.md 迁移不丢**：去处由新 phase spec 明确拍板，迁移前备份。
4. **D2 遗留复验**：缺省身份技能物化修复（branch tip `770d9fa6`）尚未运行时复验——合入前跑一遍复跑脚本确认。

## 6. 闸门状态

**PASSED** — P2（注入链退役）+ wiki 全局化解锁，由单独 spec 承载（新 phase）。本文书被新 spec 引用为过闸依据；旧 spec L132 的 P2 条款由本文书 supersede。
