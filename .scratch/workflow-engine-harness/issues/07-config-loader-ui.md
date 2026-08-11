# 07 — 配置加载器 + 系统管理 UI

## What to build
ConfigLoader 加载 + 合并 harness 配置。系统管理页面新增 Harness 配置编辑面板。

## Blocked by
01 (config schema), 06 (API routes)

## Status
done

## Acceptance Criteria
- [ ] AC1: `ConfigLoader` 加载顺序: workflow pipeline.harness (不存在) → ~/.octopus/harness.yaml → 内置 defaults
- [ ] AC2: 三方合并逻辑: 旧默认 vs 新默认 vs 用户当前
- [ ] AC3: setup 命令执行智能合并（保留用户自定义 + 添加新默认项）
- [ ] AC4: 系统管理页面新增 "Harness 配置" 菜单项
- [ ] AC5: YAML 编辑器 + 实时 Zod schema 验证
- [ ] AC6: 保存按钮调用 PUT /harness/config API
- [ ] AC7: 配置变更后正在运行的 execution 不受影响，新 execution 使用新配置

## Verification Method
**Verification type**: unit test + E2E

**Verification steps**:
1. 单元测试: 合并逻辑 — 全局 + defaults 正确合并
2. E2E: 打开系统管理 → 点击 Harness 配置 → 编辑 YAML → 保存 → 验证 API 返回更新内容

**Pass criteria**: 配置加载正确 + UI 编辑保存工作
