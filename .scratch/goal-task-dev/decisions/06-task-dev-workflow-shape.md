# 06 — D5/D6 task-dev 形态 + preset 换绑

Type: grilling
Status: resolved
Blocked by: 01, 02, 05

## Question

默认推荐工作流 task-dev 的最终形状与 preset 换绑。

## Answer

**task-dev = 两节点**(用户拍板):

```yaml
name: task-dev            # skills-free,无 requires
inputs:
  goal:       { required: true }
  ac:         { required: true }
  max_turns:  { required: false, default: "200" }   # ① 做成工作流参数,默认 200
nodes:
  - id: develop           # ② goal 模式
    type: agent
    max_turns: $inputs.max_turns
    goal: |
      $inputs.goal
      动手前先看产物目录 $vars.task_artifacts_dir 是否有计划/设计文档,有则以其为依据,无则自行拆解。
      完成定义——逐条对照以下验收标准自查修正,每条能指出证据才算达成:
      $inputs.ac
      若反复遇到相同阻塞且无进展,停止并输出阻塞原因清单与已尝试方案。   # 软退出条款
  - id: ship              # ③ prompt 模式(程序性:ship-report 落产物→commit→gh pr create/edit)
    type: agent
    depends_on: [develop]
    prompt: …(superpowers-task-dev ship 三阶段简化版)
```

- **无 cr-fix 节点**(task-dev 的自查修正折进 develop 的 goal condition + evaluator 外置判据);**独立 cr+fix 归 superpowers-task-dev**(其 cr-fix 节点改写为 goal 模式,属本需求 engine 落地后的工作流改造)。
- preset 换绑:general-dev fallback → `built-in/task-dev`,inputs `{goal:"${goal}", ac:"${ac}"}`(max_turns 走 default,不占位);superpowers-zh 组推荐不变。
- **接线细节**:max_turns 节点字段类型 `number | string`;executor 对 string 跑 substituteVarsFull + Number 化,解析失败按未设置(=不限制,与 CC 语义一致)。binding dialog 输入表单天然渲染该参数供用户调整。
