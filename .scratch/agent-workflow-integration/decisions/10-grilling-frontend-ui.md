# 10 — Grilling: Frontend Version Management UI

Type: grilling
Status: resolved
Blocked by: 07

## Question

版本管理在前端怎么呈现？

## Answer

**Decision: 分身详情页 + 版本 Tab**

- 在现有分身管理页面增加 "Versions" Tab
- 版本列表：版本号 + stage badge + status + 发布日期
- 版本详情：changelog、persona 查看、config 查看、diff 对比、回滚操作
- Main Agent 在系统设置页加版本 Tab（同样的模式）
- API 设计以分身维度为主：`GET /api/clones/:name/versions`
- Publish 和 Compare 操作按钮
