# Octopus — Loop Engineering 平台

> TypeScript monorepo · AI 工作流编排 + 多项目隔离 + 角色/技能资产库
> v1.0.0 · https://github.com/XzhiF/octopus

## 源码结构

```
octopus/
├── packages/
│   ├── shared/      ← @octopus/shared (Zod schemas + VarPool + config)
│   ├── providers/   ← @octopus/providers (AI Provider 抽象, Claude SDK)
│   ├── cli/         ← octopus (Commander.js CLI)
│   ├── engine/      ← @octopus/engine (7 executors + SQLite + JSONL)
│   ├── server/      ← @octopus/server (Hono REST API + SSE + WebSocket)
│   ├── web-app/     ← @octopus/web-app (Next.js 前端)
│   └── core-pack/   ← @octopus/core-pack (skills/agents/workflows)
├── scripts/         ← dev.mjs, prod.mjs, branch-port.mjs
├── pnpm-workspace.yaml
└── vitest.workspace.ts
```

### 包间依赖

```
shared ← (无依赖)        providers ← shared
cli ← shared+engine+core-pack    engine ← shared+providers
server ← shared+engine+core-pack+providers
web-app ← shared (类型)          core-pack ← (纯数据)
```

## Workflow Engine

YAML 定义工作流。**7 种执行器**: Bash / Python / Agent / Condition / Approval / Loop / Swarm。
**4 种编排模式**: chain / DAG / swarm / dynamic。

Swarm 子模式: review(1轮审查) · debate(N轮讨论+共识检测) · dispatch(DAG调度) · swarm(动态路由) · moa(多专家+聚合器)。

变量: `$vars.xxx` 全局池 · `$node-id.output.xxx` 前序节点 · `$last_output` · `$iteration`。

## Workspace 隔离

| 模式 | Server | Web | DB |
|------|--------|-----|-----|
| dev (主仓库) | 3001 | 3000 | `~/.octopus/db/octopus.db` |
| dev (worktree) | 3100-3598 | +1 | `octopus-{branch}.db` |
| prod | 3099 | 3098 | `octopus-prod.db` |

## 开发与测试

```bash
pnpm install          # 安装依赖
pnpm build            # 构建所有包
pnpm dev              # 主仓库开发 (server:3001 web:3000)
pnpm dev --isolated   # 隔离模式
pnpm prod             # 生产模式 (server:3099 web:3098)
pnpm port             # 查看端口分配
pnpm test             # Vitest 测试
pnpm test:watch       # 监听模式
```

### 环境变量

| 变量 | 默认值 |
|------|--------|
| `PORT` | 3001 (主仓库) / hash (worktree) |
| `OCTOPUS_DB_PATH` | `~/.octopus/db/octopus.db` |
| `NEXT_PUBLIC_SERVER_URL` | `http://localhost:3001` |

### Worktree 并行开发

```bash
git worktree add .worktrees/feat-xxx octopus-feat-xxx
cd .worktrees/feat-xxx && pnpm install && pnpm build && pnpm dev
```

## CLI 常用命令

```bash
octopus init <dir> --org <org>        # 初始化项目
octopus setup [--org]                 # 初始化 ~/.octopus/{org}/
octopus workflow run <yaml>           # 执行工作流
octopus workflow validate <yaml>      # 验证工作流
octopus workspace list/create/get/delete/tree
octopus repos update/pull/clone/rebuild-index
```

## 命名规范

- Skill 前缀 `octo-` · Agent 前缀描述性名称 · 包名 `@octopus/{name}`
- CLI: `octopus` · MCP 注册表: `mcp_{env}.yaml`
- 单一版本来源: root package.json → shared/src/version.ts

## Agent Skills

- Issue tracker: `.scratch/<feature>/` 目录下的 markdown 文件
- Triage labels: needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix
- Domain docs: root `CONTEXT-MAP.md` → per-package `CONTEXT.md`


## 可用资源 (Octopus 资源库)
<!-- octopus-resources -->

### Skills
- brainstorming (superpowers-zh)
- chinese-code-review (superpowers-zh)
- chinese-commit-conventions (superpowers-zh)
- chinese-documentation (superpowers-zh)
- chinese-git-workflow (superpowers-zh)
- dispatching-parallel-agents (superpowers-zh)
- executing-plans (superpowers-zh)
- finishing-a-development-branch (superpowers-zh)
- mcp-builder (superpowers-zh)
- receiving-code-review (superpowers-zh)
- requesting-code-review (superpowers-zh)
- subagent-driven-development (superpowers-zh)
- systematic-debugging (superpowers-zh)
- test-driven-development (superpowers-zh)
- using-git-worktrees (superpowers-zh)
- using-superpowers (superpowers-zh)
- verification-before-completion (superpowers-zh)
- workflow-runner (superpowers-zh)
- writing-plans (superpowers-zh)
- writing-skills (superpowers-zh)
- octo-agent-config (built-in)
- octo-agent-debug (built-in)
- octo-agent-evolution (built-in)
- octo-agent-memory (built-in)
- octo-agent-orchestrator (built-in)
- octo-agent-safety (built-in)
- octo-agent-scheduler (built-in)
- octo-agent-sessions (built-in)
- octo-agent-workspace (built-in)
- octo-browser-debug (built-in)
- octo-browser-vision (built-in)
- octo-dev-copilot (built-in)
- octo-e2e-assurance (built-in)
- octo-guide (built-in)
- octo-resource-manager (built-in)
- octo-scheduler (built-in)
- octo-skill-creator (built-in)
- octo-skill-evolution (built-in)
- octo-source-analyzer (built-in)
- octo-swarm-dev (built-in)
- octo-workflow-dev (built-in)
- octo-actuator-guide (built-in)
- octo-agent-clones (built-in)
- design-an-interface (mattpocock-skills)
- qa (mattpocock-skills)
- request-refactor-plan (mattpocock-skills)
- ubiquitous-language (mattpocock-skills)
- ask-matt (mattpocock-skills)
- code-review (mattpocock-skills)
- codebase-design (mattpocock-skills)
- diagnosing-bugs (mattpocock-skills)
- domain-modeling (mattpocock-skills)
- grill-with-docs (mattpocock-skills)
- implement (mattpocock-skills)
- improve-codebase-architecture (mattpocock-skills)
- prototype (mattpocock-skills)
- research (mattpocock-skills)
- resolving-merge-conflicts (mattpocock-skills)
- setup-matt-pocock-skills (mattpocock-skills)
- tdd (mattpocock-skills)
- to-spec (mattpocock-skills)
- to-tickets (mattpocock-skills)
- triage (mattpocock-skills)
- wayfinder (mattpocock-skills)
- claude-handoff (mattpocock-skills)
- loop-me (mattpocock-skills)
- setup-ts-deep-modules (mattpocock-skills)
- wizard (mattpocock-skills)
- writing-beats (mattpocock-skills)
- writing-fragments (mattpocock-skills)
- writing-shape (mattpocock-skills)
- git-guardrails-claude-code (mattpocock-skills)
- migrate-to-shoehorn (mattpocock-skills)
- scaffold-exercises (mattpocock-skills)
- setup-pre-commit (mattpocock-skills)
- edit-article (mattpocock-skills)
- obsidian-vault (mattpocock-skills)
- grill-me (mattpocock-skills)
- grilling (mattpocock-skills)
- handoff (mattpocock-skills)
- teach (mattpocock-skills)
- writing-great-skills (mattpocock-skills)
- octo-xzf-clarify (built-in)
- octo-xzf-implementer (built-in)
- octo-xzf-init (built-in)
- octo-xzf-orchestrator (built-in)
- octo-xzf-research (built-in)
- octo-xzf-ship (built-in)
- octo-xzf-spec-designer (built-in)
- octo-xzf-story-writer (built-in)
- octo-xzf-task-planner (built-in)
- octo-xzf-brief-maker (built-in)
- octo-xzf-decomposer (built-in)
- octo-xzf-verification (built-in)
- octo-workflow-repair (built-in)
- octo-notify (built-in)
- octo-workflow-test (built-in)
- octo-workflow-ops (built-in)
- octo-xzf-story-walker (built-in)
- octo-xzf-spec-to-tasks (built-in)
- task-author (built-in)

### Agents
- academic-anthropologist (agency-agents-zh)
- academic-geographer (agency-agents-zh)
- academic-historian (agency-agents-zh)
- academic-narratologist (agency-agents-zh)
- academic-psychologist (agency-agents-zh)
- academic-study-planner (agency-agents-zh)
- design-brand-guardian (agency-agents-zh)
- design-image-prompt-engineer (agency-agents-zh)
- design-inclusive-visuals-specialist (agency-agents-zh)
- design-persona-walkthrough (agency-agents-zh)
- design-ui-designer (agency-agents-zh)
- design-ux-architect (agency-agents-zh)
- design-ux-researcher (agency-agents-zh)
- design-visual-storyteller (agency-agents-zh)
- design-whimsy-injector (agency-agents-zh)
- engineering-ai-data-remediation-engineer (agency-agents-zh)
- engineering-ai-engineer (agency-agents-zh)
- engineering-autonomous-optimization-architect (agency-agents-zh)
- engineering-backend-architect (agency-agents-zh)
- engineering-cms-developer (agency-agents-zh)
- engineering-code-reviewer (agency-agents-zh)
- engineering-codebase-onboarding-engineer (agency-agents-zh)
- engineering-data-engineer (agency-agents-zh)
- engineering-database-optimizer (agency-agents-zh)
- engineering-devops-automator (agency-agents-zh)
- engineering-dingtalk-integration-developer (agency-agents-zh)
- engineering-drupal-shopping-cart (agency-agents-zh)
- engineering-email-intelligence-engineer (agency-agents-zh)
- engineering-embedded-firmware-engineer (agency-agents-zh)
- engineering-embedded-linux-driver-engineer (agency-agents-zh)
- engineering-feishu-integration-developer (agency-agents-zh)
- engineering-filament-optimization-specialist (agency-agents-zh)
- engineering-fpga-digital-design-engineer (agency-agents-zh)
- engineering-frontend-developer (agency-agents-zh)
- engineering-git-workflow-master (agency-agents-zh)
- engineering-incident-response-commander (agency-agents-zh)
- engineering-iot-solution-architect (agency-agents-zh)
- engineering-it-service-manager (agency-agents-zh)
- engineering-mechanical-design-engineer (agency-agents-zh)
- engineering-minimal-change-engineer (agency-agents-zh)
- engineering-mobile-app-builder (agency-agents-zh)
- engineering-multi-agent-systems-architect (agency-agents-zh)
- engineering-orgscript-engineer (agency-agents-zh)
- engineering-pc-host-engineer (agency-agents-zh)
- engineering-prompt-engineer (agency-agents-zh)
- engineering-rapid-prototyper (agency-agents-zh)
- engineering-security-engineer (agency-agents-zh)
- engineering-senior-developer (agency-agents-zh)
- engineering-software-architect (agency-agents-zh)
- engineering-solidity-smart-contract-engineer (agency-agents-zh)
- engineering-sre (agency-agents-zh)
- engineering-technical-writer (agency-agents-zh)
- engineering-threat-detection-engineer (agency-agents-zh)
- engineering-voice-ai-integration-engineer (agency-agents-zh)
- engineering-wechat-mini-program-developer (agency-agents-zh)
- engineering-wordpress-shopping-cart (agency-agents-zh)
- finance-bookkeeper-controller (agency-agents-zh)
- finance-financial-analyst (agency-agents-zh)
- finance-financial-forecaster (agency-agents-zh)
- finance-fpa-analyst (agency-agents-zh)
- finance-fraud-detector (agency-agents-zh)
- finance-investment-researcher (agency-agents-zh)
- finance-invoice-manager (agency-agents-zh)
- finance-tax-strategist (agency-agents-zh)
- blender-addon-engineer (agency-agents-zh)
- game-audio-engineer (agency-agents-zh)
- game-designer (agency-agents-zh)
- godot-gameplay-scripter (agency-agents-zh)
- godot-multiplayer-engineer (agency-agents-zh)
- godot-shader-developer (agency-agents-zh)
- level-designer (agency-agents-zh)
- narrative-designer (agency-agents-zh)
- roblox-avatar-creator (agency-agents-zh)
- roblox-experience-designer (agency-agents-zh)
- roblox-systems-scripter (agency-agents-zh)
- technical-artist (agency-agents-zh)
- unity-architect (agency-agents-zh)
- unity-editor-tool-developer (agency-agents-zh)
- unity-multiplayer-engineer (agency-agents-zh)
- unity-shader-graph-artist (agency-agents-zh)
- unreal-multiplayer-architect (agency-agents-zh)
- unreal-systems-engineer (agency-agents-zh)
- unreal-technical-artist (agency-agents-zh)
- unreal-world-builder (agency-agents-zh)
- gis-3d-scene-developer (agency-agents-zh)
- gis-analyst (agency-agents-zh)
- gis-bim-specialist (agency-agents-zh)
- gis-cartography-designer (agency-agents-zh)
- gis-drone-reality-mapping (agency-agents-zh)
- gis-geoai-ml-engineer (agency-agents-zh)
- gis-geoprocessing-specialist (agency-agents-zh)
- gis-qa-engineer (agency-agents-zh)
- gis-solution-engineer (agency-agents-zh)
- gis-spatial-data-engineer (agency-agents-zh)
- gis-spatial-data-scientist (agency-agents-zh)
- gis-technical-consultant (agency-agents-zh)
- gis-web-gis-developer (agency-agents-zh)
- hr-performance-reviewer (agency-agents-zh)
- hr-recruiter (agency-agents-zh)
- legal-contract-reviewer (agency-agents-zh)
- legal-policy-writer (agency-agents-zh)
- marketing-aeo-foundations (agency-agents-zh)
- marketing-agentic-search-optimizer (agency-agents-zh)
- marketing-ai-citation-strategist (agency-agents-zh)
- marketing-app-store-optimizer (agency-agents-zh)
- marketing-baidu-seo-specialist (agency-agents-zh)
- marketing-bilibili-strategist (agency-agents-zh)
- marketing-book-co-author (agency-agents-zh)
- marketing-carousel-growth-engine (agency-agents-zh)
- marketing-china-ecommerce-operator (agency-agents-zh)
- marketing-china-market-localization-strategist (agency-agents-zh)
- marketing-content-creator (agency-agents-zh)
- marketing-cross-border-ecommerce (agency-agents-zh)
- marketing-daily-news-briefing (agency-agents-zh)
- marketing-douyin-strategist (agency-agents-zh)
- marketing-ecommerce-operator (agency-agents-zh)
- marketing-email-strategist (agency-agents-zh)
- marketing-global-podcast-strategist (agency-agents-zh)
- marketing-growth-hacker (agency-agents-zh)
- marketing-instagram-curator (agency-agents-zh)
- marketing-knowledge-commerce-strategist (agency-agents-zh)
- marketing-kuaishou-strategist (agency-agents-zh)
- marketing-linkedin-content-creator (agency-agents-zh)
- marketing-livestream-commerce-coach (agency-agents-zh)
- marketing-multi-platform-publisher (agency-agents-zh)
- marketing-podcast-strategist (agency-agents-zh)
- marketing-pr-communications-manager (agency-agents-zh)
- marketing-private-domain-operator (agency-agents-zh)
- marketing-reddit-community-builder (agency-agents-zh)
- marketing-seo-specialist (agency-agents-zh)
- marketing-short-video-editing-coach (agency-agents-zh)
- marketing-social-media-strategist (agency-agents-zh)
- marketing-tiktok-strategist (agency-agents-zh)
- marketing-twitter-engager (agency-agents-zh)
- marketing-video-optimization-specialist (agency-agents-zh)
- marketing-wechat-official-account (agency-agents-zh)
- marketing-wechat-operator (agency-agents-zh)
- marketing-weibo-strategist (agency-agents-zh)
- marketing-weixin-channels-strategist (agency-agents-zh)
- marketing-x-twitter-intelligence-analyst (agency-agents-zh)
- marketing-xiaohongshu-operator (agency-agents-zh)
- marketing-xiaohongshu-specialist (agency-agents-zh)
- marketing-zhihu-strategist (agency-agents-zh)
- paid-media-auditor (agency-agents-zh)
- paid-media-creative-strategist (agency-agents-zh)
- paid-media-paid-social-strategist (agency-agents-zh)
- paid-media-ppc-strategist (agency-agents-zh)
- paid-media-programmatic-buyer (agency-agents-zh)
- paid-media-search-query-analyst (agency-agents-zh)
- paid-media-tracking-specialist (agency-agents-zh)
- product-behavioral-nudge-engine (agency-agents-zh)
- product-feedback-synthesizer (agency-agents-zh)
- product-manager (agency-agents-zh)
- product-sprint-prioritizer (agency-agents-zh)
- product-trend-researcher (agency-agents-zh)
- project-management-experiment-tracker (agency-agents-zh)
- project-management-jira-workflow-steward (agency-agents-zh)
- project-management-meeting-notes-specialist (agency-agents-zh)
- project-management-project-shepherd (agency-agents-zh)
- project-management-studio-operations (agency-agents-zh)
- project-management-studio-producer (agency-agents-zh)
- project-manager-senior (agency-agents-zh)
- sales-account-strategist (agency-agents-zh)
- sales-coach (agency-agents-zh)
- sales-deal-strategist (agency-agents-zh)
- sales-discovery-coach (agency-agents-zh)
- sales-engineer (agency-agents-zh)
- sales-offer-lead-gen-strategist (agency-agents-zh)
- sales-outbound-strategist (agency-agents-zh)
- sales-pipeline-analyst (agency-agents-zh)
- sales-proposal-strategist (agency-agents-zh)
- security-appsec-engineer (agency-agents-zh)
- security-architect (agency-agents-zh)
- security-blockchain-security-auditor (agency-agents-zh)
- security-cloud-security-architect (agency-agents-zh)
- security-compliance-auditor (agency-agents-zh)
- security-incident-responder (agency-agents-zh)
- security-penetration-tester (agency-agents-zh)
- security-senior-secops (agency-agents-zh)
- security-threat-detection-engineer (agency-agents-zh)
- security-threat-intelligence-analyst (agency-agents-zh)
- macos-spatial-metal-engineer (agency-agents-zh)
- terminal-integration-specialist (agency-agents-zh)
- visionos-spatial-engineer (agency-agents-zh)
- xr-cockpit-interaction-specialist (agency-agents-zh)
- xr-immersive-developer (agency-agents-zh)
- xr-interface-architect (agency-agents-zh)
- accounts-payable-agent (agency-agents-zh)
- agentic-identity-trust (agency-agents-zh)
- agents-orchestrator (agency-agents-zh)
- automation-governance-architect (agency-agents-zh)
- business-strategist (agency-agents-zh)
- change-management-consultant (agency-agents-zh)
- chief-financial-officer (agency-agents-zh)
- corporate-training-designer (agency-agents-zh)
- customer-success-manager (agency-agents-zh)
- data-consolidation-agent (agency-agents-zh)
- data-privacy-officer (agency-agents-zh)
- esg-sustainability-officer (agency-agents-zh)
- gaokao-college-advisor (agency-agents-zh)
- government-digital-presales-consultant (agency-agents-zh)
- grant-writer (agency-agents-zh)
- healthcare-customer-service (agency-agents-zh)
- healthcare-marketing-compliance (agency-agents-zh)
- hospitality-guest-services (agency-agents-zh)
- hr-onboarding (agency-agents-zh)
- identity-graph-operator (agency-agents-zh)
- language-translator (agency-agents-zh)
- legal-billing-time-tracking (agency-agents-zh)
- legal-client-intake (agency-agents-zh)
- legal-document-review (agency-agents-zh)
- livestock-archive-auditor (agency-agents-zh)
- loan-officer-assistant (agency-agents-zh)
- lsp-index-engineer (agency-agents-zh)
- ma-integration-manager (agency-agents-zh)
- medical-billing-coding-specialist (agency-agents-zh)
- operations-manager (agency-agents-zh)
- organizational-psychologist (agency-agents-zh)
- personal-growth-mentor (agency-agents-zh)
- prompt-engineer (agency-agents-zh)
- real-estate-buyer-seller (agency-agents-zh)
- recruitment-specialist (agency-agents-zh)
- report-distribution-agent (agency-agents-zh)
- retail-customer-returns (agency-agents-zh)
- sales-data-extraction-agent (agency-agents-zh)
- specialized-ai-policy-writer (agency-agents-zh)
- specialized-chief-of-staff (agency-agents-zh)
- specialized-civil-engineer (agency-agents-zh)
- specialized-cultural-intelligence-strategist (agency-agents-zh)
- specialized-developer-advocate (agency-agents-zh)
- specialized-document-generator (agency-agents-zh)
- specialized-french-consulting-market (agency-agents-zh)
- specialized-korean-business-navigator (agency-agents-zh)
- specialized-mcp-builder (agency-agents-zh)
- specialized-meeting-assistant (agency-agents-zh)
- specialized-model-qa (agency-agents-zh)
- specialized-pricing-analyst (agency-agents-zh)
- specialized-pricing-optimizer (agency-agents-zh)
- specialized-risk-assessor (agency-agents-zh)
- specialized-salesforce-architect (agency-agents-zh)
- specialized-strategy-duel-agent (agency-agents-zh)
- specialized-workflow-architect (agency-agents-zh)
- study-abroad-advisor (agency-agents-zh)
- technical-translator-agent (agency-agents-zh)
- zk-steward (agency-agents-zh)
- supply-chain-garment-factory-planning-engineer (agency-agents-zh)
- supply-chain-inventory-forecaster (agency-agents-zh)
- supply-chain-route-optimizer (agency-agents-zh)
- supply-chain-strategist (agency-agents-zh)
- supply-chain-vendor-evaluator (agency-agents-zh)
- support-analytics-reporter (agency-agents-zh)
- support-executive-summary-generator (agency-agents-zh)
- support-finance-tracker (agency-agents-zh)
- support-infrastructure-maintainer (agency-agents-zh)
- support-legal-compliance-checker (agency-agents-zh)
- support-recruitment-specialist (agency-agents-zh)
- support-support-responder (agency-agents-zh)
- testing-accessibility-auditor (agency-agents-zh)
- testing-api-tester (agency-agents-zh)
- testing-embedded-qa-engineer (agency-agents-zh)
- testing-evidence-collector (built-in)
- testing-performance-benchmarker (agency-agents-zh)
- testing-reality-checker (built-in)
- testing-test-results-analyzer (agency-agents-zh)
- testing-tool-evaluator (agency-agents-zh)
- testing-workflow-optimizer (agency-agents-zh)
- architecture-explorer (built-in)
- devil-advocate (built-in)
- testing-engineering-software-architect (built-in)
- testing-qa-engineer (built-in)
- vision-analyzer (built-in)
- poet (archive-extracted)
- octo-xzf-architect (built-in)
- octo-xzf-backend-expert (built-in)
- octo-xzf-frontend-expert (built-in)
- octo-xzf-product-manager (built-in)
- octo-xzf-security-expert (built-in)
- octo-xzf-test-architect (built-in)
- octo-xzf-codebase-architect (built-in)
- octo-xzf-external-researcher (built-in)
- octo-xzf-risk-analyst (built-in)
- harness-agent (built-in)

### 使用方式
- 搜索更多: 使用 octo-resource-manager skill
- 浏览全部: octopus resource list

<!-- /octopus-resources -->