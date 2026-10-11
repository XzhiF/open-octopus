# 09: 待执行规格签 — SpecPanel 只读镜像

> Spec: 同 07 追加裁决轮；原型 ⓬ readySpecHtml

**What to build:** ready 控制台「▤ 规格」= 草稿右栏 SpecPanel 的只读重展：phases 卡（名/spec 目录/绑定流）、入队清单全 ✓ 行（含"绑定确认已废"口径，ADR-0028）、输出区批次目录树（可点文件开只读查看弹窗）。所有编辑入口（＋添加/点卡改/绑定弹窗/auto_advance 开关）在只读态**不渲染**。

**Blocked by:** 07。

**Status:** done

- [x] SpecPanel 加 `readOnly` 入参（单源换装，不复制组件）：true 时隐藏全部写动作与按钮、清单只显 ✓ 态、树照常可点开 HomeFileViewerDialog；草稿工作台传 false 行为零变化
- [x] ready 控制台取数走任务详情既有 payload（task_spec + gate 同源计算，server 零新端点；gateHits 复用 authoring 现成的入队清单计算通路，必要时提为共享函数）
- [x] 组件测试：readOnly 态无写控件断言 + 草稿态回归全绿（既有 spec-panel/authoring 测试面）

> **Closed**: 并入 feat-plan-writeback（octopus-pwb-09@ab354713；gateHits 计算提为共享纯函数 spec-gate.ts（authoring 侧同吃）；[↻] 与 ✗ 明细在只读态保留系有意；票07 spec 占位锚点迁移授权在案）。2026-10-10。
