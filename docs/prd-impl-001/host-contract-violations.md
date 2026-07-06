# Host Contract Violations Report

> PRD: prd-001 · 统一资源管理系统
> 检查时间: 2026-07-07
> 基准: ./docs/prd-impl-001/host-contract.md

---

## 检查结果

| # | 契约条款 | 违反情况 | 严重性 | 状态 |
|---|----------|----------|--------|------|
| HC1 | "Zod schemas: 从 shared barrel export" | web-app API client 可能存在本地类型重定义 | 🟡 RISK | 待 Phase 4 实施时验证 |
| HC2 | 测试 ≥80% 覆盖率 | Phase 5 测试文件尚未创建 | 🔴 BLOCKED | 需实施 Task 5.1-5.3 |
| HC3 | "rehype-sanitize" 依赖 | web-app package.json 未安装 | 🔴 BLOCKED | 需实施 Task 5.5 |

## 技术约束检查

| 约束 | 检查 | 状态 |
|------|------|------|
| 后端框架 Hono 4 | ✅ 未引入其他框架 | 合规 |
| 数据库 better-sqlite3 | ✅ 未引入其他 DB | 合规 |
| ORM: 无 | ✅ 使用 ResourceManager 直接 fs 操作 | 合规 |
| 验证 Zod | ✅ types.ts 使用 Zod Schema | 合规 |
| 前端 Next.js 16 + React 19 | ✅ 未偏离 | 合规 |
| CSS Tailwind CSS 4 | ✅ 未引入其他 CSS 方案 | 合规 |
| 组件库 Radix UI + shadcn/ui | ✅ 未引入其他 UI 库 | 合规 |
| 包管理 pnpm workspace | ✅ 未使用 npm/yarn | 合规 |

## 违规统计

- **host_contract_violations**: 3
- **BLOCKED**: 2（HC2 测试覆盖率, HC3 rehype-sanitize）
- **RISK**: 1（HC1 类型导入待验证）
- **合规**: 8/8 技术约束全部合规
