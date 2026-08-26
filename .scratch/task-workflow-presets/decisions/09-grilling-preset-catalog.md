# 09 — workflow preset catalog:映射层形状与放置

Type: grilling
Status: resolved
Blocked by: None

## Question

用户推翻 02/03(不改 workflow schema),改为**独立映射层**:把"task-dev 分类"和"技能组预设"都表达为工作流之外的元数据。关键决策点:

1. **形状**:catalog 一条预设 = ?
   ```yaml
   presets:
     - name: matt-pocock-dev
       category: task-dev            # task-dev 契约 = 消费 $vars.goal/ac/projects
       skills: [mattpocock-skills]   # 空 [] = 兜底(所有组)
       workflow: built-in/basic-dev-flow
       inputs: {}                     # 可选骨架,可含 ${goal}
   ```
   (单 ref / 多 ref?要不要 `description`。)

2. **放置位置**:
   - A. 全局 `~/.octopus/workflow-presets.yaml`(跨 org 共享,平台默认预设)
   - B. org 级 `~/.octopus/orgs/{org}/workflow-presets.{yaml,json}`(按 org 隔离,同 org 网络/协作)
   - C. 全局默认 + org 覆盖(合成:org 存在同名 preset 覆盖全局)
   - D. 资源库类型(ResourceManager 新 resource type,从源仓库 install) — 重量级

3. **消费 API**:
   - `GET /api/workflow-presets?skills=a,b` → 过滤出的 presets(含 workflow ref + inputs 骨架)
   - agent 推荐 = skills 过滤;UI 绑定 = skills 过滤 + category 标注;兜底 = 未打任何 preset 的任务仍可用 generic 手动选

(推荐倾向:B 或 C;D 过重。给出推荐并说明对 agent 枚举、UI、org 隔离三处的影响。)

## Answer

**放置**:task-author clone 目录 `~/.octopus/agent/built-in/task-author/workflow-presets.yaml`(用户拍板 —— agent 行为资产,与提示词同源)。server 读 clone dir + API,agent Read 自身文件,一处定义双端消费。非 org 级。

**形状(已定,用户选 A)**:每条 preset = **单 workflow + 单 inputs**(1:1 对齐);候选广度靠多条 preset + 通用列表叠加,不塞进一条。**不用 B 多 ref 共享 inputs**(不同 workflow input 形状不同 → 白给/空值,踩"白执行"坑),**不用 C map**(啰嗦)。

```yaml
presets:
  - name: matt-pocock-dev
    skills_group: [mattpocock-skills]
    workflow: built-in/basic-dev-flow
    inputs:
      requirement: "${goal}"
      base_branch: "main"
```

**字段(最终形状)**:`name` / `skills_group`(数组,空 = 兜底)/ `workflow`(单 ref)/ `inputs`(对象,值可含 `${goal}` `${ac}`)。**无 `category`(用户已删:在册即 task-dev,category 冗余;此前在 workflow schema 里加 category 的方案也一并推翻)**。

**兜底逻辑(已定,B+C)**:catalog 自带一条 `skills_group: []` 的 general 兜底条目(空数组命中所有组,如 general-dev → basic-impl-flow + ${goal});catalog 完全无可用条目时弹窗退化为全部工作流 (A);UI 顶部始终标注当前是"推荐"还是"手动"模式。

**API 形态(拟定,实现细节随 06 落地)**:`GET /api/workflow-presets?skills_group=a,b`(server 读 clone dir)→ 命中 presets"推荐"列表 + tail 全部内置;绑定弹窗合并展示。