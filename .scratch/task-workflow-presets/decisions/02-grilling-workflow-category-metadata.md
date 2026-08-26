# 02 — workflow "task-dev 专用" 分类元数据落点

Type: grilling
Status: resolved
Blocked by: None

## Question

怎么标记"这个工作流适合 task/开发任务直接绑定"?候选:
- A. 扩展 WorkflowSchema:新增 YAML 顶层字段(如 `category: task-dev`)- 注册表/BuiltInWorkflowService.get 顺带返回;1 个字段服务所有层。
- B. 只做注册表侧约定(组名/目录命名),不碰 schema;代价:丢失结构化含义、agent/API 拿不到。
- C. 独立 catalog 配置文件(org 级)。

给出推荐,说明对 agent 推荐、spec-field、括号 supply 三处的传播路径。

## Answer

**SUPERSEDED(2026-08-27,用户推翻):** 不扩展 WorkflowSchema 加 category/skills 字段。理由:技能"组"概念本身模糊,不该让 workflow 作者维护"适合哪些组";分类/预设应作为**独立映射层**(见 09 票 preset catalog)。workflow YAML 保持纯净。

> 原(已否决)A 方案留档:WorkflowSchema 加可选 `category: "task-dev" | "generic"`,BuiltInWorkflowService 传播 + `?category=` 过滤。否决原因:污染 workflow schema + "组即语义"脆弱。