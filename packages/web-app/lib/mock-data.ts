import type {
  ChatMessage,
  ChatSession,
  DashboardStats,
  Execution,
  ExecutionTreeNode,
  FileNode,
  Workflow,
  WorkflowOption,
  Workspace,
} from "./types"

// ============ Workspaces ============
export const mockWorkspaces: Workspace[] = [
  {
    id: "ws-1",
    name: "Octopus Demo",
    description: "Octopus 工作流演示和管理",
    status: "active",
    org: "xzf",
    projectCount: 3,
    workflowCount: 8,
    createdAt: "2024-01-15T08:00:00Z",
    updatedAt: "2024-03-10T14:30:00Z",
    lastActivityAt: "2024-03-10T14:30:00Z",
    path: "/projects/octopus-demo",
  },
  {
    id: "ws-2",
    name: "Data Pipeline",
    description: "数据处理和 ETL 工作流管理",
    status: "active",
    org: "xzf",
    projectCount: 2,
    workflowCount: 5,
    createdAt: "2024-02-01T10:00:00Z",
    updatedAt: "2024-03-09T16:45:00Z",
    lastActivityAt: "2024-03-09T16:45:00Z",
    path: "/projects/data-pipeline",
  },
  {
    id: "ws-3",
    name: "ML Training Jobs",
    description: "机器学习模型训练和部署流程",
    status: "error",
    org: "xzf",
    projectCount: 1,
    workflowCount: 3,
    createdAt: "2024-02-20T09:00:00Z",
    updatedAt: "2024-03-08T11:20:00Z",
    lastActivityAt: "2024-03-08T11:20:00Z",
    path: "/projects/ml-training",
  },
  {
    id: "ws-4",
    name: "Infrastructure",
    description: "基础设施自动化和配置管理",
    status: "active",
    org: "xzf",
    projectCount: 4,
    workflowCount: 12,
    createdAt: "2024-01-05T12:00:00Z",
    updatedAt: "2024-03-10T09:15:00Z",
    lastActivityAt: "2024-03-10T09:15:00Z",
    path: "/projects/infrastructure",
  },
  {
    id: "ws-5",
    name: "Mobile App CI/CD",
    description: "移动应用持续集成和部署",
    status: "inactive",
    org: "xzf",
    projectCount: 2,
    workflowCount: 4,
    createdAt: "2024-01-25T15:00:00Z",
    updatedAt: "2024-02-28T10:00:00Z",
    lastActivityAt: "2024-02-28T10:00:00Z",
    path: "/projects/mobile-cicd",
  },
  {
    id: "ws-6",
    name: "New Project",
    description: "新项目 — 无执行记录，用于测试空状态",
    status: "active",
    org: "xzf",
    projectCount: 0,
    workflowCount: 0,
    createdAt: "2024-03-15T08:00:00Z",
    updatedAt: "2024-03-15T08:00:00Z",
    lastActivityAt: "2024-03-15T08:00:00Z",
    path: "/projects/new-project",
  },
]

// ============ Workflows ============
export const mockWorkflows: Workflow[] = [
  {
    id: "wf-1",
    projectId: "proj-1",
    workspaceId: "ws-1",
    name: "Deploy Production",
    description: "部署到生产环境的完整流程",
    status: "valid",
    steps: [
      { id: "s1", name: "Pull Latest Code", type: "shell", command: "git pull origin main" },
      { id: "s2", name: "Install Dependencies", type: "shell", command: "pnpm install", dependsOn: ["s1"] },
      { id: "s3", name: "Run Tests", type: "shell", command: "pnpm test", dependsOn: ["s2"] },
      { id: "s4", name: "Build Application", type: "shell", command: "pnpm build", dependsOn: ["s3"] },
      { id: "s5", name: "Deploy to Server", type: "script", command: "./scripts/deploy.sh", dependsOn: ["s4"] },
    ],
    yamlContent: `name: Deploy Production
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
    description: Deploy to production servers`,
    createdAt: "2024-01-20T10:00:00Z",
    updatedAt: "2024-03-05T14:00:00Z",
  },
  {
    id: "wf-2",
    projectId: "proj-1",
    workspaceId: "ws-1",
    name: "Database Migration",
    description: "数据库迁移脚本执行",
    status: "valid",
    steps: [
      { id: "s1", name: "Backup Database", type: "script", command: "./scripts/backup-db.sh" },
      { id: "s2", name: "Run Migrations", type: "shell", command: "pnpm prisma migrate deploy", dependsOn: ["s1"] },
      { id: "s3", name: "Verify Migration", type: "shell", command: "pnpm prisma db pull", dependsOn: ["s2"] },
    ],
    yamlContent: `name: Database Migration
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
    description: Verify migration completed successfully`,
    createdAt: "2024-02-10T08:00:00Z",
    updatedAt: "2024-03-01T11:00:00Z",
  },
  {
    id: "wf-3",
    projectId: "proj-1",
    workspaceId: "ws-1",
    name: "API Health Check",
    description: "API 端点健康检查",
    status: "valid",
    steps: [
      { id: "s1", name: "Check Auth Service", type: "api", command: "curl https://api.example.com/auth/health" },
      { id: "s2", name: "Check User Service", type: "api", command: "curl https://api.example.com/users/health" },
      { id: "s3", name: "Check Order Service", type: "api", command: "curl https://api.example.com/orders/health" },
      { id: "s4", name: "Generate Report", type: "script", command: "./scripts/health-report.sh", dependsOn: ["s1", "s2", "s3"] },
    ],
    yamlContent: `name: Integration Test Suite
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
    description: Tear down test environment`,
    createdAt: "2024-02-15T08:00:00Z",
    updatedAt: "2024-03-08T11:00:00Z",
  },
  {
    id: "wf-4",
    projectId: "proj-1",
    workspaceId: "ws-1",
    name: "Backup & Cleanup",
    description: "系统备份和清理",
    status: "valid",
    steps: [
      { id: "s1", name: "Backup Logs", type: "shell", command: "tar -czf logs.tar.gz /var/log/app" },
      { id: "s2", name: "Backup Database", type: "script", command: "./scripts/backup-db.sh" },
      { id: "s3", name: "Upload to S3", type: "script", command: "./scripts/upload-s3.sh", dependsOn: ["s1", "s2"] },
      { id: "s4", name: "Cleanup Old Files", type: "shell", command: "find /tmp -mtime +7 -delete", dependsOn: ["s3"] },
    ],
    yamlContent: `name: Backup & Cleanup
nodes:
  - id: backup_logs
    type: bash
    command: tar -czf logs.tar.gz /var/log/app
    description: Compress and archive application logs
  - id: backup_db
    type: bash
    command: ./scripts/backup-db.sh
    description: Backup current database state
  - id: upload_s3
    type: agent
    prompt: Upload all backup artifacts to S3 storage bucket using the standard upload playbook
    depends_on:
      - backup_logs
      - backup_db
    description: Upload backups to S3 storage
  - id: verify_upload
    type: condition
    depends_on:
      - upload_s3
    description: Verify S3 upload integrity
    cases:
      - when: upload_s3.output.status == 'success'
        then: cleanup_files
      - when: upload_s3.output.status == 'failed'
        then: retry_upload
  - id: cleanup_files
    type: bash
    command: find /tmp -mtime +7 -delete
    description: Cleanup old temporary files
  - id: retry_upload
    type: loop
    depends_on:
      - verify_upload
    description: Retry failed S3 uploads
    iterations: 3
    loop_body:
      - type: agent
        prompt: Retry S3 upload for iteration $iteration`,
    createdAt: "2024-01-25T08:00:00Z",
    updatedAt: "2024-03-02T09:00:00Z",
  },
  {
    id: "wf-5",
    projectId: "proj-2",
    workspaceId: "ws-2",
    name: "Data Sync Job",
    description: "数据同步任务",
    status: "valid",
    steps: [
      { id: "s1", name: "Extract Data", type: "script", command: "./scripts/extract.py" },
      { id: "s2", name: "Transform Data", type: "script", command: "./scripts/transform.py", dependsOn: ["s1"] },
      { id: "s3", name: "Load to Warehouse", type: "script", command: "./scripts/load.py", dependsOn: ["s2"] },
    ],
    yamlContent: `name: Data Sync Job
nodes:
  - id: extract_data
    type: python
    script: scripts/extract.py
    description: Extract raw data from source systems
  - id: validate_data
    type: condition
    depends_on:
      - extract_data
    description: Validate extracted data quality
    cases:
      - when: extract_data.output.record_count > 0
        then: transform_data
      - when: extract_data.output.record_count == 0
        then: notify_empty
  - id: transform_data
    type: python
    script: scripts/transform.py
    description: Transform and normalize data
  - id: notify_empty
    type: agent
    prompt: Notify data team that extraction returned zero records and investigate the source
    description: Alert about empty extraction
  - id: load_warehouse
    type: bash
    command: ./scripts/load.sh
    depends_on:
      - transform_data
    description: Load transformed data to warehouse`,
    createdAt: "2024-02-01T10:00:00Z",
    updatedAt: "2024-03-09T16:45:00Z",
  },
  {
    id: "wf-6",
    projectId: "proj-3",
    workspaceId: "ws-3",
    name: "Model Training",
    description: "机器学习模型训练和评估流程",
    status: "valid",
    steps: [
      { id: "s1", name: "Prepare Dataset", type: "shell", command: "./scripts/prepare_data.sh" },
      { id: "s2", name: "Train Model", type: "script", command: "python train.py", dependsOn: ["s1"] },
      { id: "s3", name: "Evaluate Model", type: "script", command: "python evaluate.py", dependsOn: ["s2"] },
      { id: "s4", name: "Deploy Model", type: "shell", command: "./scripts/deploy_model.sh", dependsOn: ["s3"] },
    ],
    yamlContent: `name: Model Training
nodes:
  - id: prepare_dataset
    type: bash
    command: ./scripts/prepare_data.sh
    description: Prepare and preprocess training dataset
  - id: validate_data
    type: condition
    depends_on:
      - prepare_dataset
    description: Validate dataset quality and completeness
    cases:
      - when: prepare_dataset.output.record_count > 1000
        then: train_model
      - when: prepare_dataset.output.record_count <= 1000
        then: notify_insufficient
  - id: train_model
    type: python
    script: train.py
    description: Train ML model with GPU acceleration
  - id: notify_insufficient
    type: agent
    prompt: Notify data team that training dataset is insufficient and suggest data augmentation strategies
    description: Alert about insufficient training data
  - id: evaluate_model
    type: python
    script: evaluate.py
    depends_on:
      - train_model
    description: Evaluate model accuracy and performance metrics
  - id: approve_deploy
    type: approval
    depends_on:
      - evaluate_model
    description: Approve model for production deployment
    risk_level: write
  - id: deploy_model
    type: agent
    prompt: Deploy the trained model to production inference servers following the ML deployment playbook
    depends_on:
      - approve_deploy
    description: Deploy model to production`,
    createdAt: "2024-02-20T09:00:00Z",
    updatedAt: "2024-03-08T11:20:00Z",
  },
]

// ============ Executions ============
export const mockExecutions: Execution[] = [
  {
    id: "exec-1",
    workflowId: "wf-1",
    workflowName: "Deploy Production",
    workspaceId: "ws-1",
    workspaceName: "Octopus Demo",
    status: "running",
    progress: 60,
    currentStep: "build_app",
    steps: [
      { stepId: "pull_code", stepName: "Pull latest code from main branch", status: "completed", startedAt: "2024-03-10T14:00:00Z", completedAt: "2024-03-10T14:00:30Z", duration: 30 },
      { stepId: "install_deps", stepName: "Install project dependencies", status: "completed", startedAt: "2024-03-10T14:00:30Z", completedAt: "2024-03-10T14:02:00Z", duration: 90 },
      { stepId: "run_tests", stepName: "Run all unit and integration tests", status: "completed", startedAt: "2024-03-10T14:02:00Z", completedAt: "2024-03-10T14:05:00Z", duration: 180 },
      { stepId: "approve_deploy", stepName: "Manual approval before deploying to production", status: "completed", startedAt: "2024-03-10T14:05:00Z", completedAt: "2024-03-10T14:05:05Z", duration: 5 },
      { stepId: "build_app", stepName: "Build production bundle", status: "running", startedAt: "2024-03-10T14:05:05Z" },
      { stepId: "deploy_server", stepName: "Deploy to production servers", status: "pending" },
    ],
    startedAt: "2024-03-10T14:00:00Z",
    triggeredBy: "manual",
    logs: [
      "[14:00:00] Starting workflow: Deploy Production",
      "[14:00:00] Step: pull_code — Pull latest code",
      "[14:00:30] pull_code completed successfully",
      "[14:00:30] Step: install_deps — Install dependencies",
      "[14:02:00] install_deps completed successfully",
      "[14:02:00] Step: run_tests — Run tests",
      "[14:05:00] run_tests completed successfully (45 tests passed)",
      "[14:05:00] Step: approve_deploy — Approval granted",
      "[14:05:05] Step: build_app — Building...",
      "[14:05:15] Building Next.js application...",
    ],
  },
  {
    id: "exec-2",
    workflowId: "wf-2",
    workflowName: "Database Migration",
    workspaceId: "ws-1",
    workspaceName: "Octopus Demo",
    status: "pending",
    progress: 0,
    steps: [
      { stepId: "backup_db", stepName: "Backup current database state", status: "pending" },
      { stepId: "check_health", stepName: "Check if backup succeeded", status: "pending" },
      { stepId: "run_migration", stepName: "Execute database migration scripts", status: "pending" },
      { stepId: "notify_ops", stepName: "Alert ops team about backup failure", status: "pending" },
      { stepId: "verify_migration", stepName: "Verify migration completed successfully", status: "pending" },
    ],
    startedAt: "2024-03-10T14:10:00Z",
    triggeredBy: "chat",
    logs: [],
  },
  {
    id: "exec-3",
    workflowId: "wf-5",
    workflowName: "Data Sync Job",
    workspaceId: "ws-2",
    workspaceName: "Data Pipeline",
    status: "running",
    progress: 30,
    currentStep: "transform_data",
    steps: [
      { stepId: "extract_data", stepName: "Extract raw data from source systems", status: "completed", startedAt: "2024-03-10T13:30:00Z", completedAt: "2024-03-10T13:45:00Z", duration: 900 },
      { stepId: "validate_data", stepName: "Validate extracted data quality", status: "completed", startedAt: "2024-03-10T13:45:00Z", completedAt: "2024-03-10T13:46:00Z", duration: 60 },
      { stepId: "transform_data", stepName: "Transform and normalize data", status: "running", startedAt: "2024-03-10T13:46:00Z" },
      { stepId: "notify_empty", stepName: "Alert about empty extraction", status: "pending" },
      { stepId: "load_warehouse", stepName: "Load transformed data to warehouse", status: "pending" },
    ],
    startedAt: "2024-03-10T13:30:00Z",
    triggeredBy: "schedule",
    logs: [
      "[13:30:00] Starting scheduled job: Data Sync",
      "[13:30:00] Extracting data from source...",
      "[13:45:00] Extraction complete. 1.2M records extracted.",
      "[13:46:00] Validation passed.",
      "[13:46:00] Starting data transformation...",
    ],
  },
  {
    id: "exec-4",
    workflowId: "wf-1",
    workflowName: "Deploy Production",
    workspaceId: "ws-1",
    workspaceName: "Octopus Demo",
    status: "completed",
    progress: 100,
    steps: [
      { stepId: "pull_code", stepName: "Pull latest code from main branch", status: "completed", duration: 25 },
      { stepId: "install_deps", stepName: "Install project dependencies", status: "completed", duration: 85 },
      { stepId: "run_tests", stepName: "Run all unit and integration tests", status: "completed", duration: 165 },
      { stepId: "approve_deploy", stepName: "Manual approval before deploying to production", status: "completed", duration: 3 },
      { stepId: "build_app", stepName: "Build production bundle", status: "completed", duration: 120 },
      { stepId: "deploy_server", stepName: "Deploy to production servers", status: "completed", duration: 45 },
    ],
    startedAt: "2024-03-10T10:00:00Z",
    completedAt: "2024-03-10T10:07:20Z",
    duration: 440,
    triggeredBy: "manual",
    logs: [],
  },
  {
    id: "exec-5",
    workflowId: "wf-6",
    workflowName: "Model Training",
    workspaceId: "ws-3",
    workspaceName: "ML Training Jobs",
    status: "failed",
    progress: 45,
    currentStep: "train_model",
    steps: [
      { stepId: "prepare_dataset", stepName: "Prepare and preprocess training dataset", status: "completed", duration: 300 },
      { stepId: "validate_data", stepName: "Validate dataset quality and completeness", status: "completed", duration: 60 },
      { stepId: "train_model", stepName: "Train ML model with GPU acceleration", status: "failed", error: "CUDA out of memory" },
      { stepId: "notify_insufficient", stepName: "Alert about insufficient training data", status: "skipped" },
      { stepId: "evaluate_model", stepName: "Evaluate model accuracy and performance metrics", status: "skipped" },
      { stepId: "approve_deploy", stepName: "Approve model for production deployment", status: "skipped" },
      { stepId: "deploy_model", stepName: "Deploy model to production", status: "skipped" },
    ],
    startedAt: "2024-03-10T08:00:00Z",
    completedAt: "2024-03-10T08:15:00Z",
    duration: 900,
    triggeredBy: "webhook",
    logs: [],
  },
  {
    id: "exec-6",
    workflowId: "wf-4",
    workflowName: "Backup & Cleanup",
    workspaceId: "ws-4",
    workspaceName: "Infrastructure",
    status: "completed",
    progress: 100,
    steps: [
      { stepId: "backup_logs", stepName: "Compress and archive application logs", status: "completed", duration: 15 },
      { stepId: "backup_db", stepName: "Backup current database state", status: "completed", duration: 10 },
      { stepId: "upload_s3", stepName: "Upload backups to S3 storage", status: "completed", duration: 20 },
      { stepId: "verify_upload", stepName: "Verify S3 upload integrity", status: "completed", duration: 5 },
      { stepId: "cleanup_files", stepName: "Cleanup old temporary files", status: "completed", duration: 3 },
      { stepId: "retry_upload", stepName: "Retry failed S3 uploads", status: "skipped" },
    ],
    startedAt: "2024-03-10T12:00:00Z",
    completedAt: "2024-03-10T12:00:53Z",
    duration: 53,
    triggeredBy: "schedule",
    logs: [],
  },
  {
    id: "exec-7",
    workflowId: "wf-1",
    workflowName: "Deploy Production",
    workspaceId: "ws-1",
    workspaceName: "Octopus Demo",
    status: "failed",
    progress: 45,
    currentStep: "run_tests",
    steps: [
      { stepId: "pull_code", stepName: "Pull latest code from main branch", status: "completed", duration: 30 },
      { stepId: "install_deps", stepName: "Install project dependencies", status: "completed", duration: 90 },
      { stepId: "run_tests", stepName: "Run all unit and integration tests", status: "failed", error: "Test suite timeout" },
      { stepId: "approve_deploy", stepName: "Manual approval before deploying", status: "skipped" },
      { stepId: "build_app", stepName: "Build production bundle", status: "skipped" },
      { stepId: "deploy_server", stepName: "Deploy to production servers", status: "skipped" },
    ],
    startedAt: "2024-03-10T10:00:00Z",
    completedAt: "2024-03-10T10:15:00Z",
    duration: 900,
    triggeredBy: "manual",
    logs: [],
  },
  {
    id: "exec-8",
    workflowId: "wf-3",
    workflowName: "Integration Test Suite",
    workspaceId: "ws-1",
    workspaceName: "Octopus Demo",
    status: "cancelled",
    progress: 55,
    currentStep: "debug_failures",
    steps: [
      { stepId: "setup_env", stepName: "Spin up test environment containers", status: "completed", startedAt: "2024-03-10T15:00:00Z", completedAt: "2024-03-10T15:00:25Z", duration: 25 },
      { stepId: "seed_data", stepName: "Seed test database with fixture data", status: "completed", startedAt: "2024-03-10T15:00:25Z", completedAt: "2024-03-10T15:00:37Z", duration: 12 },
      { stepId: "run_api_tests", stepName: "Run API integration tests", status: "cancelled", startedAt: "2024-03-10T15:00:37Z", error: "Workflow terminated by user" },
      { stepId: "run_ui_tests", stepName: "Run UI end-to-end tests", status: "skipped" },
      { stepId: "check_results", stepName: "Check if all test suites passed", status: "failed", startedAt: "2024-03-10T15:01:00Z", completedAt: "2024-03-10T15:01:02Z", duration: 2, error: "Missing input: run_api_tests.output" },
      { stepId: "approve_release", stepName: "Approve release candidate after successful tests", status: "pending" },
      { stepId: "debug_failures", stepName: "Iterate over failing tests to collect debug info", status: "running", startedAt: "2024-03-10T15:05:00Z" },
      { stepId: "teardown_env", stepName: "Tear down test environment", status: "pending" },
    ],
    startedAt: "2024-03-10T15:00:00Z",
    completedAt: "2024-03-10T15:08:00Z",
    duration: 480,
    triggeredBy: "manual",
    logs: [
      "[15:00:00] Starting workflow: Integration Test Suite",
      "[15:00:00] Step: setup_env — Spin up test environment containers",
      "[15:00:25] setup_env completed successfully",
      "[15:00:25] Step: seed_data — Seed test database with fixture data",
      "[15:00:37] seed_data completed successfully",
      "[15:00:37] Step: run_api_tests — Run API integration tests",
      "[15:01:00] check_results failed: Missing input: run_api_tests.output",
      "[15:05:00] Step: debug_failures — Iterate over failing tests",
      "[15:08:00] Workflow terminated by user",
    ],
  },
]
export const mockExecutionTree: ExecutionTreeNode[] = [
  {
    id: "et-1",
    parentId: "0",
    executionId: "exec-1",
    workflowId: "wf-1",
    workflowName: "Deploy Production",
    executionStatus: "completed",
    gateStatus: "open",
    rollback: "git-revert",
    progress: 100,
    startedAt: "2024-03-10T14:00:00Z",
    completedAt: "2024-03-10T14:07:20Z",
    duration: 440,
    childrenCount: 3,
    isLeaf: false,
    triggeredBy: "manual",
    logs: [
      "[14:00:00] Starting workflow: Deploy Production",
      "[14:07:20] All steps completed successfully",
    ],
    steps: [
      { stepId: "s1", stepName: "Pull Latest Code", status: "completed", duration: 30 },
      { stepId: "s2", stepName: "Install Dependencies", status: "completed", duration: 90 },
      { stepId: "s3", stepName: "Run Tests", status: "completed", duration: 180 },
      { stepId: "s4", stepName: "Build Application", status: "completed", duration: 120 },
      { stepId: "s5", stepName: "Deploy to Server", status: "completed", duration: 45 },
    ],
    name: "Deploy Production",
    workflowRef: "deploy",
    rollbackOnError: true,
    childIndex: 0,
    inputValues: { environment: "dev", version: "1.2.3" },
    output: null,
    createdAt: "2024-03-10T14:00:00Z",
    updatedAt: "2024-03-10T14:07:20Z",
    workspaceId: "ws-1",
    org: "xzf",
  },
  {
    id: "et-2",
    parentId: "et-1",
    executionId: "exec-2",
    workflowId: "wf-2",
    workflowName: "Database Migration",
    executionStatus: "pending",
    gateStatus: "closed",
    rollback: "git-revert",
    progress: 0,
    startedAt: "2024-03-10T14:10:00Z",
    childrenCount: 0,
    isLeaf: true,
    triggeredBy: "chat",
    logs: [],
    steps: [
      { stepId: "s1", stepName: "Backup Database", status: "pending" },
      { stepId: "s2", stepName: "Run Migrations", status: "pending" },
      { stepId: "s3", stepName: "Verify Migration", status: "pending" },
    ],
    name: "Database Migration",
    workflowRef: "migrate",
    rollbackOnError: true,
    childIndex: 0,
    inputValues: { target_db: "prod_db", dry_run: "false" },
    output: null,
    createdAt: "2024-03-10T14:10:00Z",
    updatedAt: "2024-03-10T14:10:00Z",
    workspaceId: "ws-1",
    org: "xzf",
  },
  {
    id: "et-3",
    parentId: "et-1",
    executionId: "exec-4",
    workflowId: "wf-1",
    workflowName: "Deploy Production (fork)",
    executionStatus: "completed",
    gateStatus: "open",
    rollback: "git-revert",
    progress: 100,
    startedAt: "2024-03-10T13:30:00Z",
    completedAt: "2024-03-10T14:00:00Z",
    duration: 1800,
    childrenCount: 1,
    isLeaf: false,
    triggeredBy: "manual",
    logs: [
      "[13:30:00] Starting scheduled job: Data Sync",
    ],
    steps: [
      { stepId: "s1", stepName: "Extract Data", status: "completed", duration: 900 },
      { stepId: "s2", stepName: "Transform Data", status: "completed", duration: 600 },
      { stepId: "s3", stepName: "Load to Warehouse", status: "completed", duration: 300 },
    ],
    name: "Deploy Production (fork)",
    workflowRef: "deploy",
    rollbackOnError: true,
    childIndex: 1,
    inputValues: { environment: "staging", version: "1.2.3" },
    output: null,
    createdAt: "2024-03-10T13:30:00Z",
    updatedAt: "2024-03-10T14:00:00Z",
    workspaceId: "ws-1",
    org: "xzf",
  },
  {
    id: "et-4",
    parentId: "et-3",
    executionId: "exec-7",
    workflowId: "wf-1",
    workflowName: "Deploy Production",
    executionStatus: "failed",
    gateStatus: "closed",
    rollback: "git-revert",
    progress: 45,
    startedAt: "2024-03-10T10:00:00Z",
    completedAt: "2024-03-10T10:15:00Z",
    duration: 900,
    childrenCount: 0,
    isLeaf: true,
    triggeredBy: "manual",
    logs: [],
    steps: [
      { stepId: "s1", stepName: "Prepare Dataset", status: "completed", duration: 300 },
      { stepId: "s2", stepName: "Train Model", status: "failed", error: "CUDA out of memory" },
      { stepId: "s3", stepName: "Evaluate Model", status: "skipped" },
    ],
    name: "Deploy Production",
    workflowRef: "deploy",
    rollbackOnError: true,
    childIndex: 0,
    inputValues: { environment: "prod", version: "1.2.3" },
    output: null,
    createdAt: "2024-03-10T10:00:00Z",
    updatedAt: "2024-03-10T10:15:00Z",
    workspaceId: "ws-1",
    org: "xzf",
  },
  {
    id: "et-5",
    parentId: "et-1",
    executionId: "exec-5",
    workflowId: "wf-6",
    workflowName: "Model Training",
    executionStatus: "pending",
    gateStatus: "bypassed",
    rollback: "none",
    progress: 0,
    startedAt: "2024-03-10T14:12:00Z",
    childrenCount: 0,
    isLeaf: true,
    triggeredBy: "webhook",
    logs: [],
    steps: [],
    name: "Model Training",
    workflowRef: "test",
    rollbackOnError: false,
    childIndex: 2,
    inputValues: {},
    output: null,
    createdAt: "2024-03-10T14:12:00Z",
    updatedAt: "2024-03-10T14:12:00Z",
    workspaceId: "ws-1",
    org: "xzf",
  },
]

export function getExecutionTreeByWorkspace(workspaceId: string): ExecutionTreeNode[] {
  return mockExecutionTree.filter((node) => node.workspaceId === workspaceId)
}

// ============ Workflow Options (for CreateNodeDialog) ============
export const mockWorkflowOptions: WorkflowOption[] = [
  { value: "deploy", label: "Deploy Production", name: "Deploy Production", description: "生产环境部署工作流", group: "built-in",
    inputs: {
      environment: { description: "部署环境", required: true, default: "dev" },
      version: { description: "版本号", required: true, default: "" },
    } },
  { value: "migrate", label: "Database Migration", name: "Database Migration", description: "数据库迁移工作流", group: "built-in",
    inputs: {
      target_db: { description: "目标数据库", required: true, default: "" },
      dry_run: { description: "试运行模式", required: false, default: "true" },
    } },
  { value: "test", label: "Integration Test Suite", name: "Integration Test Suite", description: "集成测试套件", group: "built-in",
    inputs: {
      test_scope: { description: "测试范围", required: false, default: "all" },
    } },
  { value: "ci/build", label: "CI Build", name: "CI Build", description: "持续集成构建", group: "local", path: "workflows/ci/build.yaml" },
  { value: "ci/test", label: "CI Test", name: "CI Test", description: "持续集成测试", group: "local", path: "workflows/ci/test.yaml" },
  { value: "deploy/staging", label: "Deploy Staging", name: "Deploy Staging", description: "预发环境部署", group: "local", path: "workflows/deploy/staging.yaml" },
]

export function getWorkflowOptions(): WorkflowOption[] {
  return mockWorkflowOptions
}

// ============ Chat Sessions ============
export const mockChatSessions: ChatSession[] = [
  {
    id: "chat-1",
    workspaceId: "ws-1",
    title: "部署咨询",
    messages: [],
    createdAt: "2024-03-10T14:00:00Z",
    updatedAt: "2024-03-10T14:30:00Z",
    isActive: true,
  },
  {
    id: "chat-2",
    workspaceId: "ws-1",
    title: "数据库问题",
    messages: [],
    createdAt: "2024-03-09T10:00:00Z",
    updatedAt: "2024-03-09T11:30:00Z",
    isActive: false,
  },
  {
    id: "chat-3",
    workspaceId: "ws-1",
    title: "性能优化",
    messages: [],
    createdAt: "2024-03-08T09:00:00Z",
    updatedAt: "2024-03-08T10:00:00Z",
    isActive: false,
  },
  {
    id: "chat-4",
    workspaceId: "ws-2",
    title: "ETL 任务调试",
    messages: [],
    createdAt: "2024-03-07T14:00:00Z",
    updatedAt: "2024-03-07T15:30:00Z",
    isActive: true,
  },
]

export const mockChatMessages: ChatMessage[] = [
  {
    id: "msg-1",
    sessionId: "chat-1",
    role: "user",
    displayType: "user",
    content: "帮我执行生产环境部署",
    timestamp: "2024-03-10T14:00:00Z",
  },
  {
    id: "msg-2",
    sessionId: "chat-1",
    role: "assistant",
    displayType: "text",
    content: "好的，我将为您执行 Deploy Production 工作流。这将包括以下步骤：\n\n1. 拉取最新代码\n2. 安装依赖\n3. 运行测试\n4. 构建应用\n5. 部署到服务器\n\n确认执行吗？",
    timestamp: "2024-03-10T14:00:05Z",
  },
  {
    id: "msg-3",
    sessionId: "chat-1",
    role: "user",
    displayType: "user",
    content: "确认执行",
    timestamp: "2024-03-10T14:00:10Z",
  },
  {
    id: "msg-4",
    sessionId: "chat-1",
    role: "assistant",
    displayType: "text",
    content: "已启动工作流执行",
    timestamp: "2024-03-10T14:00:12Z",
  },
]

// ============ File Tree ============
export const mockFileTree: FileNode[] = [
  { id: "f1", name: "CLAUDE.md", type: "file", path: "/CLAUDE.md", extension: "md" },
  {
    id: "f2",
    name: ".claude",
    type: "directory",
    path: "/.claude",
    isExpanded: true,
    children: [
      {
        id: "f3",
        name: "skills",
        type: "directory",
        path: "/.claude/skills",
        isExpanded: true,
        children: [
          {
            id: "f4",
            name: "octo-skill-creator",
            type: "directory",
            path: "/.claude/skills/octo-skill-creator",
            isExpanded: false,
            children: [
              { id: "f5", name: "SKILL.md", type: "file", path: "/.claude/skills/octo-skill-creator/SKILL.md", extension: "md" },
            ],
          },
          {
            id: "f6",
            name: "octo-skill-evolution",
            type: "directory",
            path: "/.claude/skills/octo-skill-evolution",
            isExpanded: false,
            children: [
              { id: "f7", name: "SKILL.md", type: "file", path: "/.claude/skills/octo-skill-evolution/SKILL.md", extension: "md" },
            ],
          },
        ],
      },
      {
        id: "f8",
        name: "agents",
        type: "directory",
        path: "/.claude/agents",
        isExpanded: false,
        children: [
          { id: "f9", name: "mcp-discoverer.md", type: "file", path: "/.claude/agents/mcp-discoverer.md", extension: "md" },
          { id: "f10", name: "skill-searcher.md", type: "file", path: "/.claude/agents/skill-searcher.md", extension: "md" },
        ],
      },
    ],
  },
  {
    id: "f11",
    name: "projects",
    type: "directory",
    path: "/projects",
    isExpanded: true,
    children: [
      { id: "f12", name: "manifest.yaml", type: "file", path: "/projects/manifest.yaml", extension: "yaml" },
      {
        id: "f13",
        name: "user-service",
        type: "directory",
        path: "/projects/user-service",
        isExpanded: false,
        children: [
          { id: "f14", name: "pom.xml", type: "file", path: "/projects/user-service/pom.xml", extension: "xml" },
          {
            id: "f15",
            name: "src",
            type: "directory",
            path: "/projects/user-service/src",
            isExpanded: false,
            children: [
              {
                id: "f16",
                name: "main",
                type: "directory",
                path: "/projects/user-service/src/main",
                isExpanded: false,
                children: [
                  {
                    id: "f17",
                    name: "java",
                    type: "directory",
                    path: "/projects/user-service/src/main/java",
                    isExpanded: false,
                    children: [
                      { id: "f18", name: "UserServiceApp.java", type: "file", path: "/projects/user-service/src/main/java/UserServiceApp.java", extension: "java" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "f19",
        name: "admin-web-ui",
        type: "directory",
        path: "/projects/admin-web-ui",
        isExpanded: false,
        children: [
          { id: "f20", name: "package.json", type: "file", path: "/projects/admin-web-ui/package.json", extension: "json" },
          { id: "f21", name: "CLAUDE.md", type: "file", path: "/projects/admin-web-ui/CLAUDE.md", extension: "md" },
          {
            id: "f22",
            name: "src",
            type: "directory",
            path: "/projects/admin-web-ui/src",
            isExpanded: false,
            children: [
              { id: "f23", name: "App.tsx", type: "file", path: "/projects/admin-web-ui/src/App.tsx", extension: "tsx" },
              {
                id: "f24",
                name: "components",
                type: "directory",
                path: "/projects/admin-web-ui/src/components",
                isExpanded: false,
                children: [
                  { id: "f25", name: "Dashboard.tsx", type: "file", path: "/projects/admin-web-ui/src/components/Dashboard.tsx", extension: "tsx" },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "f26",
        name: "user-proxy",
        type: "directory",
        path: "/projects/user-proxy",
        isExpanded: false,
        children: [
          { id: "f27", name: "main.go", type: "file", path: "/projects/user-proxy/main.go", extension: "go" },
          { id: "f28", name: "config.yaml", type: "file", path: "/projects/user-proxy/config.yaml", extension: "yaml" },
        ],
      },
    ],
  },
  {
    id: "f29",
    name: "workflows",
    type: "directory",
    path: "/workflows",
    isExpanded: true,
    children: [
      { id: "f30", name: "deploy.yaml", type: "file", path: "/workflows/deploy.yaml", extension: "yaml" },
      { id: "f31", name: "migrate.yaml", type: "file", path: "/workflows/migrate.yaml", extension: "yaml" },
      { id: "f32", name: "test.yaml", type: "file", path: "/workflows/test.yaml", extension: "yaml" },
    ],
  },
  {
    id: "f33",
    name: "state",
    type: "directory",
    path: "/state",
    isExpanded: false,
    children: [
      { id: "f34", name: "deploy-20240310.json", type: "file", path: "/state/deploy-20240310.json", extension: "json" },
      { id: "f35", name: "migrate-20240309.json", type: "file", path: "/state/migrate-20240309.json", extension: "json" },
    ],
  },
  {
    id: "f36",
    name: "logs",
    type: "directory",
    path: "/logs",
    isExpanded: false,
    children: [
      { id: "f37", name: "exec-1.jsonl", type: "file", path: "/logs/exec-1.jsonl", extension: "jsonl" },
      { id: "f38", name: "exec-2.jsonl", type: "file", path: "/logs/exec-2.jsonl", extension: "jsonl" },
    ],
  },
]

// ============ Dashboard Stats ============
export const mockDashboardStats: DashboardStats = {
  activeWorkspaces: 3,
  totalWorkspaces: 5,
  runningExecutions: 2,
  pendingExecutions: 1,
  completedToday: 8,
  failedToday: 1,
}

// ============ Helper Functions ============
export function getWorkspaceById(id: string): Workspace | undefined {
  return mockWorkspaces.find((ws) => ws.id === id)
}

export function getExecutionsByWorkspace(workspaceId: string): Execution[] {
  return mockExecutions.filter((exec) => exec.workspaceId === workspaceId)
}

export function getRunningExecutions(): Execution[] {
  return mockExecutions.filter((exec) => exec.status === "running")
}

export function getPendingExecutions(): Execution[] {
  return mockExecutions.filter((exec) => exec.status === "pending")
}

export function getRecentExecutions(limit: number = 10): Execution[] {
  return [...mockExecutions]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, limit)
}

export function getWorkflowsByWorkspace(workspaceId: string): Workflow[] {
  return mockWorkflows.filter((wf) => wf.workspaceId === workspaceId)
}

export function getChatSessionsByWorkspace(workspaceId: string): ChatSession[] {
  return mockChatSessions.filter((session) => session.workspaceId === workspaceId)
}

export function getMessagesBySession(sessionId: string): ChatMessage[] {
  return mockChatMessages.filter((msg) => msg.sessionId === sessionId)
}

export { getFileContent } from "./mock-file-contents"

