# 05 — 闭环协议: Agent 如何处理测试失败并迭代?

Type: grilling
Status: resolved
Blocked by: 01, 02

## Answer

**全自动修复，最多 3 轮**

流程:
1. Agent 运行 `octopus workflow simulate wf.yaml --json`
2. 解析 JSON 结果，分析 assertionReport
3. 如果失败: 分析根因 (mock 缺值 / 变量名错 / 条件不匹配)
4. 修改 test.yaml (添加 update_vars / 修正 output / 调整 assertions)
5. 重新运行 simulate
6. 最多 3 轮自动迭代
7. 3 轮后仍失败 → 输出结构化诊断报告，交开发者决策
