# 04: task-doer 反向硬闸 — ws 批次目录物理拒写

> Spec: `.scratch/plan-writeback/spec.md` Implementation Decisions 之 S2

**What to build:** 给 task-doer 会话装 clone-runtime 路径守卫（与 task-author 守卫同机制、方向相反）：对话里试图直接写 ws 侧批次目录（.scratch 位）被**当场拒绝**并返回可见原因（指向计划回写 REST 通道），模型拿到原因即改道；`projects/` 代码写权与 [quick-edit] 提交照旧。自此规格文件永不走 ws —— "下轮 seed 覆盖回滚 doer 改动"的断层物理性死亡。

**Blocked by:** 02（拒写消息里给模型的指路形状须是真端点）。

**Status:** done

- [x] doer 会话写 ws 批次目录（含建目录/改既有票）被守卫拦截，返回文本含拒绝原因与 REST 指路；同路径**读**不受影响
- [x] doer 写 projects/ 正常，quick-edit 每改即 commit 行为零变化（既有测试回归绿）
- [x] 守卫仅装 doer：task-author 与其余分身会话行为零变化（authoring-guard 既有测试绿 + 一次他分身会话抽测）
- [x] 拦截行为有集成级测试（先例：authoring-guard 测试面），断言拒绝消息可被模型理解（含指路端点形状，不含行话）
- [x] 修复流引擎节点**不加**此闸（引擎无 clone 守卫挂载点，纪律走 prompt 归 05 票）—— 本票 AC 明确不触碰 engine

> **Closed**: 并入 feat-plan-writeback（octopus-pwb-04@644d005f；拒写消息定稿含 REST 指路与 Windows UTF-8 curl 注意；偏离三小处：guard 签名加 taskId 实值、Bash 目标自写字面切分防反斜杠漏拦、指路预含票03 形状）。2026-10-10。
