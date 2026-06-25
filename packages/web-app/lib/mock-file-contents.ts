const mockContents: Record<string, string> = {
  "/CLAUDE.md": `# Octopus Workspace — xzf

> **定位**: 多组织工具集平台 — CLI + Skill + Agent + Workflow Engine

## 核心范式
- 5步创建流程 — 需求推断与草案 → 按需查询 → 迭代方案确认 → 生成 → 询问验证
- YAML 注册表 + CLI 直连 MCP — MCP 服务信息存储在 mcp/mcp_{env}.yaml
- Workflow Engine — YAML 定义工作流，6种节点执行器

## 开发与测试
\`\`\`bash
pnpm install
pnpm build
pnpm test
octopus version
\`\`\`
`,
  "/.claude/skills/octo-skill-creator/SKILL.md": `---
name: octo-skill-creator
category: coding-assistant
description: 5步流程创建 Skill — 需求推断→按需查询→方案确认→生成→验证
tags: [skill, creator, workflow]
---

# octo-skill-creator

## 触发方式
用户说"创建 Skill" 或输入 /octo-skill-creator

## 5步创建流程

1. **需求推断与草案** — AI推理名称/描述/类别/功能/工作流程，智能提示可能需要的资源(MCP/知识/相似Skill)
2. **按需查询** — 用户触发委托 sub-agent: 查相似Skill / 查可用MCP / 查项目知识 / 查环境信息
3. **迭代方案确认** — 综合需求+查询结果展示方案，直到用户确认生成
4. **生成** — 按确认方案写入 SKILL.md + 辅助文件
5. **询问验证** — 询问是否验证，委托 skill-evaluator

## 验证 6点
1. YAML frontmatter — name 有合法前缀, category 6值, description ≤1024
2. Structural completeness — 无残留标记
3. Production safety — prod profile 有 approval_required=true
4. Content coverage — 至少 1 个 section
5. Self-contained integrity — 引用路径合规
6. MCP 参考 validity — 注册表路径 + 调用含 --org
`,
  "/.claude/skills/octo-skill-evolution/SKILL.md": `---
name: octo-skill-evolution
category: knowledge
description: 创建经验记录/搜索/删除/重建索引，跨项目共享创建经验
tags: [evolution, experience, learning]
---

# octo-skill-evolution

## 触发方式
- 记录经验: /octo-skill-evolution record
- 快速记录: /octo-skill-evolution record-fast
- 删除经验: /octo-skill-evolution remove {name}
- 重建索引: /octo-skill-evolution rebuild

## 经验存储
- 全局经验: ~/.octopus/evolution/global_experience.md (≤30行)
- 用户偏好: ~/.octopus/evolution/user_preference.md
- Org 级偏好: ~/.octopus/{org}/evolution/{org}_user_preference.md

## 经验搜索
- Step 1 自动读 index.md 匹配（类别>关键词≥2重叠>pattern）
- ≤5条结果，无匹配不提示
`,
  "/.claude/agents/mcp-discoverer.md": `# mcp-discoverer

## 触发
用户说"查可用 MCP"

## 职责
从 YAML 注册表（~/.octopus/{org}/mcp/*.yaml）发现 MCP 服务信息

## 输出
返回可用 MCP 服务列表：server名、描述、连接配置、tool列表
`,
  "/.claude/agents/skill-searcher.md": `# skill-searcher

## 触发
用户说"查相似 Skill"

## 职责
搜索已有 Skill，计算相似度百分比

## 引用优先规则
- ≥90% → 强烈建议复用
- ≥70% → 参考其结构改编
- <70% → 无需参考
`,
  "/projects/manifest.yaml": `projects:
  - name: user-service
    git_url: https://gitlab.example.com/backend/user-service.git
    branch: main
    local_path: projects/user-service
    desc: 用户服务 Java Spring Boot 后端
  - name: admin-web-ui
    git_url: https://gitlab.example.com/frontend/admin-web-ui.git
    branch: develop
    local_path: projects/admin-web-ui
    desc: 管理后台 Next.js 前端
  - name: user-proxy
    git_url: https://gitlab.example.com/infra/user-proxy.git
    branch: release/v2.1
    local_path: projects/user-proxy
    desc: 用户代理服务 Go
`,
  "/projects/user-service/pom.xml": `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.0</version>
  </parent>
  <groupId>com.example</groupId>
  <artifactId>user-service</artifactId>
  <version>1.0.0</version>
  <properties>
    <java.version>17</java.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
</project>
`,
  "/projects/user-service/src/main/java/UserServiceApp.java": `package com.example.userservice;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class UserServiceApp {
    public static void main(String[] args) {
        SpringApplication.run(UserServiceApp.class, args);
    }
}
`,
  "/projects/admin-web-ui/package.json": `{
  "name": "admin-web-ui",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^14.2.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  }
}
`,
  "/projects/admin-web-ui/CLAUDE.md": `# admin-web-ui

管理后台前端项目，基于 Next.js 14 + shadcn/ui。

## 开发
\`\`\`bash
pnpm install && pnpm dev
\`\`\`

## 技术栈
- Next.js App Router
- Tailwind CSS + shadcn/ui
- React Hook Form + Zod
`,
  "/projects/admin-web-ui/src/App.tsx": `import { Dashboard } from '@/components/Dashboard'

export default function App() {
  return (
    <div className="min-h-screen bg-background">
      <Dashboard />
    </div>
  )
}
`,
  "/projects/admin-web-ui/src/components/Dashboard.tsx": `import { Card, CardHeader, CardTitle } from '@/components/ui/card'

export function Dashboard() {
  return (
    <div className="p-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>工作空间</CardTitle>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>执行记录</CardTitle>
        </CardHeader>
      </Card>
    </div>
  )
}
`,
  "/projects/user-proxy/main.go": `package main

import (
    "fmt"
    "net/http"
    "os"
)

func main() {
    port := os.Getenv("PORT")
    if port == "" {
        port = "8080"
    }

    http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "ok")
    })

    fmt.Printf("user-proxy listening on :%s\\n", port)
    http.ListenAndServe(":"+port, nil)
}
`,
  "/projects/user-proxy/config.yaml": `server:
  port: 8080
  upstream: http://user-service:3000

proxy:
  timeout: 30s
  retry_count: 3

logging:
  level: info
  format: json
`,
  "/workflows/deploy.yaml": `name: Deploy Production
nodes:
  - id: pull_code
    type: bash
    command: git pull origin main
    description: Pull latest code from main branch
  - id: install_deps
    type: bash
    command: pnpm install
    depends_on:
      - pull_code
    description: Install project dependencies
  - id: run_tests
    type: bash
    command: pnpm test
    depends_on:
      - install_deps
    description: Run all unit and integration tests
  - id: approve_deploy
    type: approval
    depends_on:
      - run_tests
    description: Manual approval before deploying to production
    risk_level: write
  - id: build_app
    type: bash
    command: pnpm build
    depends_on:
      - approve_deploy
    description: Build production bundle
  - id: deploy_server
    type: agent
    prompt: Deploy the built application to production servers using the standard deployment playbook
    depends_on:
      - build_app
    description: Deploy to production servers
`,
  "/workflows/migrate.yaml": `name: Database Migration
nodes:
  - id: backup_db
    type: bash
    command: ./scripts/backup-db.sh
    description: Backup current database state
  - id: check_health
    type: condition
    depends_on:
      - backup_db
    description: Check if backup succeeded
    cases:
      - when: backup_db.output.status == 'success'
        then: run_migration
      - when: backup_db.output.status == 'failed'
        then: notify_ops
  - id: run_migration
    type: python
    script: scripts/migrate.py
    description: Execute database migration scripts
  - id: notify_ops
    type: agent
    prompt: Notify operations team that backup failed and migration is blocked
    description: Alert ops team about backup failure
  - id: verify_migration
    type: bash
    command: pnpm prisma db pull
    depends_on:
      - run_migration
    description: Verify migration completed successfully
`,
  "/workflows/test.yaml": `name: Integration Test Suite
nodes:
  - id: setup_env
    type: bash
    command: docker-compose up -d test-env
    description: Spin up test environment containers
  - id: seed_data
    type: python
    script: scripts/seed_test_data.py
    depends_on:
      - setup_env
    description: Seed test database with fixture data
  - id: run_api_tests
    type: bash
    command: pnpm test:api
    depends_on:
      - seed_data
    description: Run API integration tests
  - id: run_ui_tests
    type: bash
    command: pnpm test:e2e
    depends_on:
      - seed_data
    description: Run UI end-to-end tests
  - id: check_results
    type: condition
    depends_on:
      - run_api_tests
      - run_ui_tests
    description: Check if all test suites passed
    cases:
      - when: run_api_tests.output.exit_code == 0 and run_ui_tests.output.exit_code == 0
        then: approve_release
      - when: run_api_tests.output.exit_code != 0 or run_ui_tests.output.exit_code != 0
        then: debug_failures
  - id: approve_release
    type: approval
    description: Approve release candidate after successful tests
  - id: debug_failures
    type: loop
    depends_on:
      - check_results
    description: Iterate over failing tests to collect debug info
    iterations: 3
    loop_body:
      - type: agent
        prompt: Analyze test failure $iteration and provide remediation steps
  - id: teardown_env
    type: bash
    command: docker-compose down
    depends_on:
      - approve_release
      - debug_failures
    description: Tear down test environment
`,
  "/state/deploy-20240310.json": `{
  "workflow_id": "deploy",
  "execution_id": "exec-1",
  "started_at": "2024-03-10T14:00:00Z",
  "status": "running",
  "current_node": "build_app",
  "vars": {
    "env": "production",
    "version": "1.2.3"
  },
  "node_states": {
    "pull_code": "completed",
    "install_deps": "completed",
    "run_tests": "completed",
    "approve_deploy": "pending",
    "build_app": "running"
  }
}`,
  "/state/migrate-20240309.json": `{
  "workflow_id": "migrate",
  "execution_id": "exec-2",
  "started_at": "2024-03-09T16:45:00Z",
  "status": "pending",
  "current_node": null,
  "vars": {
    "env": "staging",
    "db_host": "db-staging.internal"
  },
  "node_states": {
    "backup_db": "pending",
    "check_health": "pending",
    "run_migration": "pending",
    "verify_migration": "pending"
  }
}`,
  "/logs/exec-1.jsonl": `{"ts":"2024-03-10T14:00:00Z","node":"pull_code","event":"start","msg":"Pulling latest code from main"}
{"ts":"2024-03-10T14:00:30Z","node":"pull_code","event":"complete","msg":"Successfully pulled 3 commits","exit_code":0}
{"ts":"2024-03-10T14:00:30Z","node":"install_deps","event":"start","msg":"Installing dependencies"}
{"ts":"2024-03-10T14:02:00Z","node":"install_deps","event":"complete","msg":"Installed 245 packages","exit_code":0}
{"ts":"2024-03-10T14:02:00Z","node":"run_tests","event":"start","msg":"Running unit and integration tests"}
{"ts":"2024-03-10T14:05:00Z","node":"run_tests","event":"complete","msg":"All 45 tests passed","exit_code":0}
{"ts":"2024-03-10T14:05:00Z","node":"approve_deploy","event":"waiting","msg":"Waiting for manual approval"}
{"ts":"2024-03-10T14:06:00Z","node":"approve_deploy","event":"approved","msg":"Deployment approved by admin"}
{"ts":"2024-03-10T14:06:00Z","node":"build_app","event":"start","msg":"Building production bundle"}
`,
  "/logs/exec-2.jsonl": `{"ts":"2024-03-09T16:45:00Z","node":"backup_db","event":"start","msg":"Starting database backup"}
{"ts":"2024-03-09T16:46:00Z","node":"backup_db","event":"complete","msg":"Backup completed: 2.1GB","exit_code":0}
{"ts":"2024-03-09T16:46:00Z","node":"check_health","event":"start","msg":"Checking backup health status"}
{"ts":"2024-03-09T16:46:15Z","node":"check_health","event":"complete","msg":"Backup verified successfully","exit_code":0}
`,
}

export const mockFileContents: Record<string, string> = mockContents

export function getFileContent(path: string): string | undefined {
  return mockContents[path]
}