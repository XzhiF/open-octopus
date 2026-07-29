# 03 — 调试日志增强

Type: grilling
Status: resolved
Blocked by: None

## Question

DebugLogViewer 目前只展示最近的日志条目，缺少：
1. 分页 — 后端已支持分页参数，但前端没有加载更多/翻页
2. 搜索 — 用户无法按关键词、chat_id、时间范围过滤日志
3. 列表项太少 — max-height 400px 限制了可见条目

需要什么级别的增强？最小可行 vs 完整体验？

## Answer

**研究发现**:
- 后端**不支持分页** — `cursor` 参数在签名中存在但从未使用，实际是全量读取
- 初始加载固定 `limit: 20`，无"加载更多"
- 左侧列表用 Radix ScrollArea (`max-h-[400px]`)，右侧详情用原生 `overflow-auto` — 视觉不一致
- 日志列表项的 summary 用 CSS `.truncate` 单行省略

**决定**: MVP 级增强
- 后端实现真 cursor-based 分页
- 前端"加载更多"按钮
- 基础搜索: 关键词 + 时间范围过滤
- 统一两侧滚动机制为 Radix ScrollArea
