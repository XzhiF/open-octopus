# 04 — System Prompt 详情滚动与完整显示

Type: grilling
Status: resolved
Blocked by: None

## Question

DebugLogViewer 的右侧详情面板显示 System Prompt 组装详情时：
- content_preview 只截取前 200 字符
- 整体不可滚动
- 无法查看完整的 segment 内容

需要什么级别的改进？
1. 让 content_preview 可扩展（点击展开/折叠）
2. 右侧面板整体可滚动
3. 提供"查看完整内容"的弹窗/抽屉

## Answer

**决定**: 可展开/折叠方案
- 后端 `GET /debug/assemble/:chat_id` 返回完整 `content` 字段（不再只返回 200 字符 preview）
- 前端每个 segment 用可折叠区域显示，默认折叠只显示前 200 字符，点击展开查看完整内容
- 右侧详情面板统一使用 Radix ScrollArea，解决滚动不一致问题
