# 02: 统一弹窗壳

**What to build:** 执行中、待验收、终态三类卡片点开的是**同一个任务控制台壳**：顶栏只剩 标题 + 状态 pill + 用时/成本/commits 元信息 + ⛶/✕（原 8 个动作按钮全部下沉右栏底部），标题栏红黄蓝"红绿灯"装饰删除（消除误点错觉）；页签装配表生效——running：变更·节点·控制台（默认变更，内容先挂既有组件占位）；awaiting_review：对话·变更·走查·日志（后续票逐个填）；←/→ 切页签、Esc 逐层关窗（对话框→弹窗）。composite 与 authoring 两模式原样不动。

参考：spec.md 页签装配表（源自原型状态表）、原型 `taskboard-v2.html`（壳布局/皮肤即真相源）。

**Blocked by:** None (can start immediately)

**Status:** done

- [ ] running / awaiting_review / 终态 三卡打开同一壳组件，旧 simple-execution/done/terminal 三模式收敛（composite 保留）
- [ ] 顶栏无动作按钮、无红绿灯装饰；动作区在右栏底部按状态装配（暂停/中止、通过/打回等，仍接既有实现）
- [ ] 页签按状态表出现且可点；←/→ 键盘切换、Esc 先关对话框再关弹窗
- [ ] 皮肤沿用现 globals.css 净黑 TUI 语义（1.5px 边框、状态色语法不变；takeover=pink、fixing=cyan 两个新语义色预留）
- [ ] 既有验收台/控制台功能在壳内不回退（可点通、数据照常刷新）

> **Closed**: 并入 feat-taskboard-modal-v2（票 commit 616b3130；终 tip 3131acc0）。逐 AC 证据见实现报告与 tmp/tbm-v2-notes.md §已合并票契约；双轴 code-review 八项经 fix 6abe16a7 收口；E2E 终tip复验流①②③⑤ GREEN，流④断言已对齐 form-aware 标记+窗口放宽 120s（待人工确认跑一次）。
