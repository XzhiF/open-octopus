# 10 — 前端产出查看器：全文弹窗 + 工作流日志 + MoA 采纳

## What to build
编写页右半 = 产出查看器（US7/10/11/D11，参照 VariantL OutputViewer）：产物列表（GET artifacts）→ 点击弹 ArtifactViewerDialog（GET content 全文，缺失文件降级态）；工作流运行记录 → WorkflowLogDialog（GET assist run logs）；chat 内 agent 建议气泡 + MoA 卡片：三段式产出勾选采纳（ac→spec-field ac；建议→spec-field decisions）；决策备忘区；SSE task_artifacts_update / assist_run_update 刷新。

## Blocked by
06 — artifacts 路由 · 07 — assist workflows · 09 — 两阶段骨架

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: 产物列表渲染索引（图标/标题/路径/来源 skill/更新时间）；点击 → 全文弹窗（等宽渲染），底部提示「有意见在对话里说」（无审批按钮，D11）
- [ ] AC2: content 403/404 → 弹窗降级态（越权/文件缺失提示），不白屏
- [ ] AC3: 工作流运行记录行（状态 badge）→ 日志弹窗：时间戳 + icon + 文本逐行渲染
- [ ] AC4: agent 建议气泡含 [运行][跳过]；运行 → POST assist-workflows → 卡片进入运行态（专家列表 ●●●）→ SSE assist_run_update 驱动完成态
- [ ] AC5: 采纳面板：ac 候选 checkbox（带专家来源）+ 方案建议 checkbox + 风险只读；[采纳勾选项] → 合并后 spec-field(ac) + spec-field(decisions)；右侧 ac 出现 🧠 来源标记，决策备忘区列出已采纳建议
- [ ] AC6: output_parse_error=true → 降级卡展示 output_raw（SW-BP10 UI 侧）
- [ ] AC7: SSE task_artifacts_update → 产物列表自动刷新（无需手动）

## Verification Method
**Verification type**: browser E2E + manual checklist

**Verification steps**:
```bash
cd packages/web-app && pnpm playwright test e2e/task-authoring-v3.spec.ts -g "viewer|assist"
```
E2E：预置 artifacts.json + 磁盘文件 → 打开弹窗断言全文 == 磁盘内容；越权构造 → 降级态；触发 assist（小白名单模板）→ 日志弹窗非空 → 完成后采纳面板勾选 → DB ac/decisions 断言。Manual：agent 建议气泡出现时机、对话改产物链路。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
