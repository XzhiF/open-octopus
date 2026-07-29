## Memory 闭环系统 + Main Agent 优化

本 PR 包含两个迭代，将 Main Agent 从半成品升级为完整的自主 Agent 工作台，并实现记忆系统闭环。

### Development Iterations

| # | Feature | Date | Tickets | Status |
|---|---------|------|---------|--------|
| 8 | main-agent-optimization | 07-29 | 10/10 done | ✅ Skill 详情、进化管道、记忆改进 |
| 9 | memory-closed-loop | 07-29 | 6/6 done | ✅ 记忆写入/归档/蒸馏闭环 |

### 迭代 9: Memory 闭环系统

Agent 记忆系统（daily / long-term / session）形成完整闭环：

- **`record_daily` tool** — Agent 自主判断对话价值，调用工具写入 daily memory + session 摘要（FTS 可搜索）
- **正反例指引** — System prompt 包含明确的 ✅/❌ 示例，防止 Agent 记流水账
- **Scheduler auto-seed** — Server 启动时自动创建 `system:daily-archive` 定时任务（每天凌晨 3 点归档）
- **Archive → Refine 联动** — 归档后自动触发 long-term memory 精炼（去重/截断），.bak 备份可回退
- **归档提醒** — 未归档 >3 天时 Agent 自动提醒用户

### 迭代 8: Main Agent 优化

- **Skill 详情子页面** — 三栏可拖拽布局（列表 | 内容 | diff），搜索过滤 + 高亮
- **进化管道接通** — `insight_marks` 表 + 5 个 Agent 工具自主驱动进化
- **UI 改进** — Skill 列表显示文件大小，移除 Tasks tab，Memory tab 完善

### E2E Verification（迭代 9 — memory-closed-loop）

| AC | Condition | Status |
|----|-----------|--------|
| AC1 | record_daily tool 在 system prompt + handler | ✅ PASS |
| AC2 | GET /memory/daily 返回数组带日期 | ✅ PASS |
| AC3 | system:daily-archive 在 scheduler | ✅ PASS |
| AC4 | archive 触发 auto-refine | ✅ PASS |
| AC5 | >3 daily 文件触发归档提醒 | ✅ PASS |

### E2E Verification（迭代 8 — main-agent-optimization）

| AC | Condition | Status |
|----|-----------|--------|
| AC-1 ~ AC-10 | 10 项全部通过 | ✅ PASS |

### Changed Files (203 files, +13982 -945)

<!-- MANUAL-START -->
<!-- MANUAL-END -->

### Remaining Issues

| # | Issue | Impact |
|---|-------|--------|
| 1 | merge_skills tool 是 stub | Low — 后续迭代 |
| 2 | Claude SDK 不可用时 record_daily 无法触发 | Low — fallback 模式本身功能有限 |
