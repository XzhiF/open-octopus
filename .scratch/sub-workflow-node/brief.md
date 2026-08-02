# Requirement Brief — Sub-Workflow Node

## Overview
为 Octopus 工作流引擎新增 `sub_workflow` 节点类型，支持在一个工作流中引用并执行另一个工作流，变量通过显式 I/O mapping 传递，UI 流程图中以容器框形式展示子工作流内部节点。

## Projects Involved
- [x] shared (类型定义、Schema、VarPool)
- [x] engine (SubWorkflowExecutor、执行器工厂)
- [x] server (API 适配、SSE 事件传播)
- [x] web-app (流程图渲染、节点组件、创建对话框、执行面板)
- [x] core-pack (无变更)

## Feature Scope
**Do:**
- 新增 `sub_workflow` 节点类型，通过名称引用同工作空间下的子工作流
- 支持两种执行模式：`inline`（内联）和 `linked`（链接子执行），通过 YAML `execution_mode` 字段配置
- 变量隔离：子工作流拥有独立 VarPool，通过 `input_mapping` / `output_mapping` 显式传递
- UI 流程图：sub_workflow 以容器框（类似 loop）展示，编辑态预览子工作流内部节点，运行时叠加实时状态
- 节点创建：YAML 编辑 + 可视化对话框（含工作流选择器）都支持
- 错误处理：默认子工作流失败 → 父节点 failed，可通过 `on_error` 配置
- E2E 浏览器验证测试：创建工作空间 → 创建子/父工作流 → 执行 → 截图验证

**Don't:**
- 不支持跨工作空间引用子工作流
- 不支持 inline 定义子工作流（仅 by name 引用）
- 不修改现有节点类型的行为
- 不做 sub_workflow 的暂停/恢复（首版）
- 不做 sub_workflow 的并发执行（linked 模式预留接口，首版只实现串行）

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | 引用方式 | By name（`workflow: "child-name"`） | 可复用、独立测试、YAML 简洁 |
| 2 | 变量传递 | Scoped pool + 显式 I/O mapping | 隔离性好，子工作流可独立测试和复用 |
| 3 | 执行模型 | 双模式：inline / linked，YAML 可配置 | inline 简单场景高效；linked 为并发和动态节点预留 |
| 4 | UI 渲染 | 编辑态预览 + 运行时状态叠加 | 完整体验，与 loop 容器模式一致 |
| 5 | 节点创建 | YAML + 可视化对话框都支持 | 覆盖两种用户习惯 |
| 6 | 错误处理 | 默认 fail，可通过 `on_error` 配置 continue | 安全优先，灵活配置 |
| 7 | Session | 正常保持，兼容当前 session 模型 | 用户明确要求 |
| 8 | 事件命名 | `{sub_workflow_name}:{event_name}` | 用户明确要求，UI 右侧事件面板显示 |

## Data Model Changes
| Table | Operation | Details |
|-------|-----------|---------|
| `executions` | 新增字段 | `parent_execution_id?: string` — linked 模式下关联父执行 |
| NodeTypeSchema | 扩展枚举 | 新增 `"sub_workflow"` |
| NodeDef | 新增字段 | `workflow`, `execution_mode`, `input_mapping`, `output_mapping`, `on_error` |

### Sub_workflow Node YAML Schema
```yaml
- id: run-child
  type: sub_workflow
  workflow: child-workflow-name    # 必需：引用的子工作流名称
  execution_mode: inline           # 可选：inline(默认) | linked
  on_error: fail                   # 可选：fail(默认) | continue
  input_mapping:                   # 可选：parent → child 变量映射
    child_var: $vars.parent_var
    literal: "static-value"
  output_mapping:                  # 可选：child → parent 变量映射
    parent_var: child_var_name
  depends_on: [prev-node]
```

### NodeDef 类型扩展
```typescript
// workflow.ts — NodeDef 新增字段
// sub_workflow
workflow?: string                              // 引用的子工作流名称
execution_mode?: "inline" | "linked"           // 执行模式，默认 inline
input_mapping?: Record<string, string>         // parent → child 变量映射
output_mapping?: Record<string, string>        // child → parent 变量映射
on_error?: "fail" | "continue"                 // 错误处理，默认 fail
```

## API Contracts
| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| GET | `/api/workspaces/:wsId/workflows` | Server | - | Workflow[] | 用于可视化对话框的工作流选择器 |
| GET | `/api/workspaces/:wsId/workflows/:name` | Server | - | Workflow YAML | 编辑态预览子工作流内部节点 |

> 注：以上 API 大概率已存在，需确认。若不存在则新增。

## Design Specs (if any)
- Figma link: none
- Fidelity: 遵循现有 loop 容器视觉风格，图标和 Badge 做区分

### UI 视觉规格
- **容器框**：虚线边框（与 loop 一致），颜色跟随状态
- **头部**：`Layers` 图标（区分 loop 的 `Repeat`）+ 名称 + 引用子工作流名 + 执行模式标签 + "子工作流" Badge
- **内部节点**：编辑态从引用的子工作流 YAML 解析渲染，运行时叠加执行状态
- **节点详情面板**：新增 `sub-workflow-detail-tabs.tsx`（参照 `loop-detail-tabs.tsx`）

## Acceptance Criteria
| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| 1 | 用户创建 sub_workflow 节点 | YAML 中写 `type: sub_workflow` + `workflow: name`，解析通过无报错 | Unit test + E2E |
| 2 | 流程图显示子工作流容器 | 流程图中 sub_workflow 渲染为容器框，内含子工作流的节点 | E2E screenshot |
| 3 | 执行 sub_workflow（inline 模式） | 父工作流执行时，子工作流节点被正确执行，状态变为 completed | E2E execution |
| 4 | 变量 input_mapping 生效 | 子工作流内能读到父工作流传入的变量 | E2E + 检查 vars_snapshot |
| 5 | 变量 output_mapping 生效 | 子工作流完成后，父工作流能读到映射回来的变量 | E2E + 检查 vars_snapshot |
| 6 | 子工作流失败 → 父节点 failed | 子工作流执行失败时，sub_workflow 节点状态为 failed，父工作流 failed | E2E execution |
| 7 | on_error: continue 生效 | 配置 on_error: continue 后，子工作流失败不影响后续节点 | E2E execution |
| 8 | 可视化对话框创建节点 | create-node-dialog 中选择 sub_workflow 类型，工作流选择器列出可用工作流 | E2E screenshot |
| 9 | 事件面板显示子工作流事件 | 执行时右侧事件面板显示 `{sub_workflow_name}:{event_name}` 格式的事件 | E2E screenshot |

## Verification Strategy

### Global Config
- Environment: local dev（`pnpm dev`）
- Test user: 无需登录
- Data prefix: `E2E_SUBWF_`

### Per-layer Methods
#### Unit Tests
- `SubWorkflowExecutor` 类：input_mapping 解析、output_mapping 回写、on_error 处理
- `workflow-parser.ts`：sub_workflow 节点解析，容器尺寸计算
- 表达式求值：input_mapping 中 `$vars.xxx` 的解析

#### Integration Tests
- Server API：工作流列表接口（用于工作流选择器）
- 执行引擎：inline 模式下 sub_workflow 节点的完整执行链路

#### Browser E2E (Playwright)
核心测试文件：`packages/web-app/e2e/sub-workflow.spec.ts`

测试步骤：
1. 打开工作空间管理页面
2. 创建新工作空间 `E2E_SUBWF_workspace`（无 codebase）
3. 在工作空间中创建子工作流 `E2E_SUBWF_child`（2 个 bash 节点）
4. 在同一工作空间中创建父工作流 `E2E_SUBWF_parent`（包含 sub_workflow 节点引用子工作流）
5. 验证流程图渲染：sub_workflow 容器框 + 内部节点 → 截图 `flow-render.png`
6. 执行父工作流
7. 等待执行完成
8. 验证执行状态面板：sub_workflow 节点状态、事件列表 → 截图 `execution-status.png`
9. 验证变量传递：检查父工作流执行后的 vars_snapshot → 截图 `vars-check.png`
10. 清理测试数据

#### Contract Tests
- NodeDef TypeScript 类型 ↔ YAML Schema 字段一致性

#### Manual Checklist
- N/A（全部自动化）

### Prerequisites
- [ ] `pnpm dev` 本地启动（server:3001 + web:3000）
- [ ] Playwright 已安装
- [ ] 无前置工作流依赖（测试中动态创建）

## Risks & Notes
- R1: 子工作流 YAML 可能不存在或无效 — 需在解析阶段做存在性和有效性校验
- R2: inline 模式下的 session 隔离 — 子工作流的 agent session 不能污染父工作流的 globalSessionId
- R3: linked 模式的异步等待 — 首版仅实现串行等待，并发为未来扩展
- R4: 子工作流递归引用 — 需要检测并阻止（A 引用 B，B 引用 A）
- R5: 工作流选择器性能 — 大量工作流时需分页或搜索

## Glossary (new domain terms)
| Term | Meaning |
|------|---------|
| **Sub-workflow Node** | 引用并执行同工作空间下另一个工作流的节点类型。通过名称引用，变量通过 I/O mapping 传递。 |
| **Execution Mode (inline/linked)** | sub_workflow 节点的执行策略。inline 在父执行上下文内运行；linked 创建独立子执行。 |
| **Input Mapping** | 子工作流启动前，将父工作流变量映射到子工作流 VarPool 的配置。 |
| **Output Mapping** | 子工作流完成后，将子工作流变量映射回父工作流 VarPool 的配置。 |
| **Sub-workflow Container** | UI 流程图中用于展示子工作流内部节点的容器框，视觉风格类似 loop 容器。 |
