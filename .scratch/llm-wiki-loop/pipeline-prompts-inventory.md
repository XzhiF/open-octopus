# pipeline.yaml prompts 存量清单（票05 · 本期只登记不迁移）

> 登记时间：2026-10-12 · 来源：`C:/Users/EDY/.octopus` 全量扫描（37 个 pipeline.yaml，含中文/空格目录名，null-delimited 遍历）
> 用途：P2 影子期人工分流输入——每条 prompt 的去向（迁 workflows/ 词条 或 并入 workflow-operator persona）。分流完成是 P2 删除 PromptInjector 的前置。

## 结论

**存量 prompt 内容为零。** 37 个 pipeline.yaml 中仅 1 个带 `prompts:` 键，且两条列表均为空（脚手架模板默认）；无任何 global/targeted 实际内容需要分流。P2 删除注入链不存在 pipeline.yaml 侧的遗留 prompt 资产。

## 明细

| # | 文件 | prompts 键 | global 条数 | targeted 条数 |
|---|------|-----------|------------|--------------|
| 1 | `C:\Users\EDY\.octopus\default\archive\test-loop-dev\pipeline.yaml` | 有（第 17-25 行） | 0（`global: []`） | 0（`targeted: []`） |
| 2-37 | 其余 36 个（E2E_TBV2_org_f2/f3/f6、E2E_TD_org、miyuan、xzf 各 workspaces/*/pipeline.yaml） | 无此键 | — | — |

唯一带键文件的原文（存档目录 test-loop-dev，已删除工作流的归档副本）：

```yaml
# ── Prompt 注入 ───────────────────────────────────────────
prompts:
  global: []                    # 注入到所有 agent 节点的全局 prompt
  targeted: []                  # 按 workflow + node 精确注入
  # 示例:
  # targeted:
  #   - workflow: "hermes-dev-flow"
  #     node: "e2e-test"
  #     prompt: "使用 Playwright 执行 E2E 测试"
```

注：其中 `使用 Playwright 执行 E2E 测试` 是注释掉的模板示例，非生效配置，不计入分流清单。

## 扫描口径

- 判定标准：`prompts:` 下 `global`/`targeted` 是否含非注释内容；对全部 37 文件做 `grep 'prompts:'` + 大小写不敏感 `prompt|workflow:` 双重确认。
- 引擎/服务侧 PromptInjector 读取的是各 workspace 的 pipeline.yaml（`PipelineConfigSchema.prompts`，shared/src/types/pipeline.ts），即本清单覆盖的同一族文件；org `xzf-dev` 的 workspaces 目录当前为空。
- 若 P2 前新工作流写入了 prompts 字段，重跑本清单命令即可（登记产物按 hash 幂等，见票05 迁移器 `_migration/state.json` 机制）。
