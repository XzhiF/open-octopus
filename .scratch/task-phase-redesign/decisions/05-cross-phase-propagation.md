# 05 — 重大决策跨 phase 传播

Type: grilling
Status: resolved
Blocked by: ~~04~~（resolved）

## Question

打回 Round 产生重大决策变更时，如何同步修改后续 phase 的 spec：agent 起草 diff + 人逐条确认？改 spec 后已生成未开始的 phase 执行入口是否需要重新绑定/重估 workflow 适配？传播的边界（什么算"重大决策"）。

## Answer

Q5.1 裁决 A（四条全收），见 map D14：

1. **锚点**：传播挂 spec-r2 事件（非打回事件）；修复流不传播。agent 写 spec-r2 时对照后续 pending phase spec 产影响清单
2. **边界机械化**：「重大决策」= Key Decisions 表行 diff（比对表格不比对散文）；升级 skill 硬约定 rN 修订保持决策表行结构与编号稳定（改行内不删行，新增标 `NEW-rN`）
3. **确认流**：影响清单并进打回确认弹窗同屏，人逐项/整批批准；批准后 agent 直改后续 phase spec 文件 + phases[] JSON（version 乐观锁），人不手编
4. **workflow 重估**：被命中 pending phase 的绑定适配建议同卡批准；未命中不动、运行中不动
