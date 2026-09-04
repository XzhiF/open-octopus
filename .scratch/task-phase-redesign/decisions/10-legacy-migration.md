# 10 — 存量兼容与迁移

Type: grilling
Status: resolved

## Question

现存 draft/ready/running/completed 任务如何处置：schema 双轨 vs 一次性迁移；running 中的老任务跑完自然终结？scheduler 定时触发的 task 信封兼容；spec.json 快照格式版本化。

## Answer

Q10.1 裁决 A（五条全收），见 map D17：`task_spec.format:"v4"` flag 分叉（gate/物化/UI）；存量 v3 沿旧链路自然跑完不迁移，UI 读时派生 legacy 单 phase 时间线；v3 草稿绑定数据源切 built-in 清单；不提供旧→新一键升级（重聊新草稿）；composite/schedule 信封零改动；测试清单引用票 09。
