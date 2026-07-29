## Main Agent 优化 + Memory 闭环 + Clone 记忆对齐

本 PR 包含三个迭代，将 Main Agent 从半成品升级为完整的自主 Agent 工作台，实现记忆系统闭环，并将完整记忆管线扩展到 clone 分身。

### Development Iterations

| # | Feature | Date | Tickets | Status |
|---|---------|------|---------|--------|
| 8 | main-agent-optimization | 07-29 | 10/10 done | ✅ Skill 详情、进化管道、记忆改进 |
| 9 | memory-closed-loop | 07-29 | 6/6 done | ✅ 记忆写入/归档/蒸馏闭环 |
| 10 | clone-memory-alignment | 07-29 | 8/8 done | ✅ Clone 记忆管线对齐 main agent |

### 迭代 10: Clone Memory Pipeline Alignment

将 main agent 的完整记忆管线镜像到 clone 分身，使长期培养的专业分身拥有同等记忆能力：

- **`record_daily` tool** — Clone 复用 main agent 的 tool，handler 按 clone context 路由写入路径
- **FTS 统一索引** — `source` 字段区分 main / clone-name，支持按来源过滤搜索
- **Scheduler 全目录扫描** — 自动归档所有 clone 的 daily 文件到各自 `archive/` 子目录
- **`assembleForClone()` 恢复** — Clone 获得完整的 SystemPromptAssembler 优先级截断
- **Clone refine** — 归档后自动触发 long-term memory 精炼（去重/截断/备份）
- **冲突检测** — `writeIsolatedMemory()` 加 mtime-based 冲突检测
- **Bug fix** — `X-Clone-Name` header 未传递导致 clone record_daily 写入错误目录

### 迭代 9: Memory 闭环系统

- **`record_daily` tool** — Agent 自主判断对话价值，调用工具写入 daily memory + session 摘要
- **正反例指引** — System prompt 包含明确的 ✅/❌ 示例
- **Scheduler auto-seed** — Server 启动时自动创建 `system:daily-archive` 定时任务
- **Archive → Refine 联动** — 归档后自动触发 long-term memory 精炼
- **归档提醒** — 未归档 >3 天时 Agent 自动提醒用户

### 迭代 8: Main Agent 优化

- **Skill 详情子页面** — 三栏可拖拽布局，搜索过滤 + 高亮，frontmatter 卡片化
- **进化管道接通** — `insight_marks` 表 + 5 个 Agent 工具自主驱动进化
- **UI 改进** — Skill 列表显示文件大小，Memory tab 完善

### E2E Verification（迭代 10 — clone-memory-alignment）

| AC | Condition | Status |
|----|-----------|--------|
| AC1 | Clone record_daily → clone dir + FTS source | ✅ PASS |
| AC2 | 不写入 main agent daily 目录 | ✅ PASS |
| AC3 | Clone daily 自动归档 | ✅ PASS |
| AC4 | 归档触发 clone refine + .bak | ✅ PASS |
| AC5 | search 返回 clone 记录 + source 字段 | ✅ PASS |
| AC6 | assembleForClone() 预算截断 | ✅ PASS |
| AC7 | writeIsolatedMemory mtime 冲突检测 | ✅ PASS |
| AC8 | search?source= 过滤 | ✅ PASS |

### E2E Verification（迭代 9 — memory-closed-loop）

| AC | Condition | Status |
|----|-----------|--------|
| AC1~AC5 | 5 项全部通过 | ✅ PASS |

### E2E Verification（迭代 8 — main-agent-optimization）

| AC | Condition | Status |
|----|-----------|--------|
| AC-1 ~ AC-10 | 10 项全部通过 | ✅ PASS |

### Remaining Issues

| # | Issue | Impact |
|---|-------|--------|
| 1 | Claude SDK 不可用时 record_daily 无法触发 | Low — fallback 模式本身功能有限 |
