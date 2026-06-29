# 03 — 知识注入

## 1. 注入策略：三级加载

知识文件可能有几十到上百条规则。全部注入会浪费 token，不注入可能遗漏关键规则。

```
工作流启动时（一次性）:
  precomputeRelevantRules(org, workflowName, inputs)
    → 读全局 + Org 的 index.md
    → 一次 haiku 调用判断相关规则 ID
    → 结果存入 VarPool: __relevant_rule_ids
    ↓
每个 agent 节点执行前:
  injectKnowledge(node, pool)
    → 读 VarPool 缓存（不再调 LLM）
    → 从两层知识文件中读取相关规则段落
    → 拼接到 prompt
```

**关键**：相关性判断在工作流启动时做一次，所有 agent 节点共享结果。

## 2. 工作流 YAML 声明

agent 节点通过 `knowledge_scope` 字段声明需要注入什么：

```yaml
- id: implement
  type: agent
  knowledge_scope:
    projects: ["$inputs.project_dir"]     # 注入哪个项目的知识
    workflows: ["$workflow.name"]         # 注入哪个工作流的知识
  prompt: |
    实现需求...
```

引擎在执行 agent 节点前调用 `injectKnowledge()`。

## 3. 引擎实现

```typescript
// packages/engine/src/engine.ts
private async injectKnowledge(
  node: NodeDef,
  pool: VarPool,
): Promise<string> {
  if (!node.knowledge_scope) return ''

  const org = pool.get('org')
  const dirs = getKnowledgeDirs(org)  // [全局, Org] 两层

  const sections: string[] = []

  // Step 1: 永远注入 user_preference（全局 + Org 合并）
  sections.push(getEffectiveUserPreference(org))

  // Step 2: 从 VarPool 缓存读取预计算的相关规则 ID
  //   （工作流启动时由 precomputeRelevantRules() 计算一次，
  //    不在此处调 LLM，避免每个 agent 节点都触发 haiku）
  const relevantIds: string[] = JSON.parse(
    pool.get('__relevant_rule_ids') ?? '[]'
  )

  if (relevantIds.length === 0) {
    return sections.join('\n\n---\n\n')
  }

  // Step 3: 从两层知识文件中读取相关规则
  for (const ruleId of relevantIds) {
    for (const dir of dirs) {
      const files = readdir(dir).filter(f => f.endsWith('.md') && f !== 'index.md' && f !== 'user_preference.md')
      for (const file of files) {
        const content = await readFile(join(dir, file), 'utf-8')
        const ruleText = extractRuleSection(content, ruleId)
        if (ruleText) {
          sections.push(ruleText)
          break  // 找到了就不用继续搜
        }
      }
    }
  }
    }
  }

  return sections.length > 0
    ? sections.join('\n\n---\n\n') + '\n\n'
    : ''
}
```

## 4. 相关性判断（Step 2 详细）

## 4. 相关性预计算（工作流启动时）

```typescript
// 工作流启动时调用一次，结果缓存到 VarPool
async function precomputeRelevantRules(
  org: string,
  workflowName: string,
  inputValues: Record<string, string>,
): Promise<string[]> {
  const dirs = getKnowledgeDirs(org)

  // 合并两层 index.md
  let indexContent = ''
  for (const dir of dirs) {
    const indexPath = join(dir, 'index.md')
    if (existsSync(indexPath)) {
      indexContent += await readFile(indexPath, 'utf-8') + '\n'
    }
  }

  if (!indexContent.trim()) return []

  // 一次 haiku 调用判断相关性
  const prompt = `判断以下知识规则中，哪些与当前工作流相关。

工作流: ${workflowName}
输入: ${JSON.stringify(inputValues).slice(0, 300)}

知识索引:
${indexContent}

输出相关规则的 ID 列表（如 ["oct-007", "oct-008"]），不相关的不要列出。
如果全部不相关，输出 []。`

  const result = await llmCall(prompt, 'haiku')
  return result.relevant  // ["oct-007", "oct-008", "bh-001"]
}
```

## 5. Token 预算控制

| 知识类型 | 预估行数 | 预估 tokens | 策略 |
|---------|---------|-------------|------|
| user_preference.md | ~20 行 | ~200 | 永远全量注入 |
| index.md 扫描 | ~50 行 | ~500 | 工作流启动时一次 haiku |
| 相关规则详情 | ~30 行 (3-8 条) | ~300 | 每个 agent 节点从缓存读取 |
| **总计** | | **~1000** | 占 agent prompt 的 5-10% |

**上限保护**：如果相关规则超过 10 条，按 relevance_score 排序取前 10。

## 6. 注入时机

```
工作流引擎执行 agent 节点:
  │
  ├── 1. 解析 knowledge_scope
  ├── 2. 调用 injectKnowledge()
  ├── 3. 将返回的知识文本拼接到 prompt 前面
  └── 4. 发送给 LLM

Agent 收到的 prompt:
  "📋 用户偏好:
   - 当前项目快速迭代，不考虑安全性/鉴权
   - 测试默认用 uat01 环境
   
   📋 相关知识 (octopus, 3 条):
   - Promise.allSettled 聚合调用必须设全局超时
   - stale 检测一律用 updated_at
   - 修改 shared/ 后先 build shared
   
   ---
   
   [原始 prompt: 实现需求...]"
```
