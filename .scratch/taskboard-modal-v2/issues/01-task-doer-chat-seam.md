# 01: task-doer 内置分身 + 任务对话 seam（S1）

**What to build:** 任务获得一个"会干活的嘴"：新内置分身 **task-doer（任务执行者）** 登记上线（ADR-0025），并新增任务级对话 API（唯一新 seam S1）——对任意执行/验收态任务 `GET /api/tasks/:id/chat` 取得或懒建该 task 唯一的 doer 会话（任务表新增可空字段指向，跨 Round 延续、不裂变），`POST` 消息经 SSE 回复。server 侧解析会话归属、经 workspace-chat 通道运行（cwd=任务执行 workspace，不触碰 task-home 写权环），并把任务上下文注入对话：当前 phase/round、批次目录 spec 家族、启动 Runbook、写纪律（大改动由模型判断劝退转修复轮，不做关键词正则）。有效编辑每改即 commit 进执行分支（提交信息含 quick-edit 标记）。

参考：spec.md §Implementation Decisions（S1/task-doer 两条）、ADR-0025、原型 `taskboard-v2.html`（对话形态与工具卡）。

**Blocked by:** None (can start immediately)

**Status:** done

- [ ] task-doer 出现在内置分身清单，setup/初始化落位其 persona 与最小技能族；内置分身相关数量断言/词条同步更新
- [ ] `GET /api/tasks/:id/chat` 首次调用懒建会话并持久绑定到该 task，二次调用返回同一会话（幂等）；草稿期 task-author 会话不受影响
- [ ] `POST /api/tasks/:id/chat`（SSE）消息由 task-doer 应答；组装证据中可见注入的任务上下文（spec 目录/反馈/runbook 字样的 prompt 段）
- [ ] 对 running / awaiting_review 任务发"把某文件某处改成 X"→ 执行分支新增一个带 quick-edit 标记的 commit，回复含改动摘要
- [ ] 大改动请求（跨多文件逻辑/新接口类）→ 回复为劝退+建议打回修复轮，不产生 commit；判断为模型行为、无硬编码关键词表
- [ ] 多任务隔离：A 任务的对话改动不落入 B 任务工作区
- [ ] API 集成测试覆盖以上各条（防自证：期望来自独立断言）

> **Closed**: 并入 feat-taskboard-modal-v2（票 commit d4fe99d3；终 tip 3131acc0）。逐 AC 证据见实现报告与 tmp/tbm-v2-notes.md §已合并票契约；双轴 code-review 八项经 fix 6abe16a7 收口；E2E 终tip复验流①②③⑤ GREEN，流④断言已对齐 form-aware 标记+窗口放宽 120s（待人工确认跑一次）。
