# 06 — 进程隔离与沙箱

Type: grilling
Status: resolved
Blocked by: None

## Question

Bash/Python 节点怎么隔离才不会影响宿主进程？

## Answer

### 渐进式安全模型

```
基础层 (全平台, 必须有):
  1. 进程组管理 — 确保 kill 干净
  2. 端口保护 — 检测并阻止占用宿主端口
  3. PID 保护 — 拦截杀死宿主进程的命令
  4. Wrapper 拦截 — 用 safe_kill/safe_rm 包裹危险命令

增强层 (Linux/macOS, 可选):
  5. OS 沙箱 — macOS seatbelt / Linux bubblewrap
  6. 文件系统白名单 — 限制可操作目录
  7. 网络策略 — 可选网络隔离
```

### 基础层实现 (全平台)

**1. 进程组管理 (修复 Python 漏洞)**
- Bash (Unix): 已有 `kill(-pid)` ✅
- Bash (Windows): 已有 `taskkill /T /F` ✅
- Python (Unix): 修复 → 改用 `os.killpg(pgid, signal.SIGTERM)`
- Python (Windows): 修复 → 改用 `taskkill /PID ${pid} /T /F`
- 超时后强制 kill: SIGTERM → 等待 5s → SIGKILL

**2. 端口保护**
- 执行前: 检查脚本中是否引用宿主端口 (3001/3000)
- 如果匹配: 自动替换为隔离端口 (3100+) 或阻断并报告
- 实现: 正则扫描 + 环境变量注入 `OCTOPUS_HOST_PORTS`

**3. PID 保护**
- 注入环境变量: `OCTOPUS_HOST_PID=${process.pid}`
- Wrapper 函数拦截 kill/taskkill/pkill:
  - 如果目标 == OCTOPUS_HOST_PID → 阻断 + 报告
  - 否则放行

**4. Wrapper 拦截 (全平台)**
- Bash: 注入 shell 函数覆盖 kill/rm/taskkill
- Python: 通过 PYTHONSTARTUP 注入安全拦截
- 被拦截的命令记录到 harness 事件流

### 增强层实现 (Linux/macOS)

**5. OS 沙箱**
- macOS: `sandbox-exec -f harness.sb bash -c script`
  - harness.sb: deny default, allow specific paths, deny process-fork
- Linux: `bwrap --bind /workspace /workspace --unshare-pid bash -c script`
- 自动检测可用: `detectSandbox()` → seatbelt | bubblewrap | wrapper_fallback

**6. 文件系统白名单**
- 配置: `fs_whitelist: [".", "/tmp", workspace_dir]`
- seatbelt/bubblewrap 原生支持路径限制
- Wrapper fallback: `cd` 命令拦截

**7. 网络策略 (可选)**
- 默认允许 (不限制)
- 可配置: `network_policy: deny | whitelist`
- seatbelt/bubblewrap 原生支持

### 与 Harness 的集成
- 进程冲突检测器 (ProcessConflictDetector) 使用基础层的事件流
- 当 Wrapper 拦截到危险操作时:
  → 生成 DiagnosisReport { detector: "process_conflict", severity: "critical" }
  → Strategy 层立即阻断 (不重试)
  → SSE: harness_diagnosis + harness_intervention 事件
  → UI: 悬浮面板显示拦截详情
