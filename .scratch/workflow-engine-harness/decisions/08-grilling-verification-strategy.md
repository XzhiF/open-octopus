# 08 — 验证策略

Type: grilling
Status: resolved
Blocked by: All above

## Answer

### 四层验证

| # | 级别 | 验证什么 | 方法 |
|---|------|---------|------|
| ① | 单元测试 | Detector 检测逻辑、Strategy 匹配逻辑、新回调向后兼容 | Vitest |
| ② | 集成测试 | 异常 workflow 端到端: 检测→策略→干预→状态变化 | 测试 workflow YAML + dev 环境 |
| ③ | 浏览器 E2E | 悬浮面板、DAG 标记、chatbot 干预 UI | Playwright |
| ④ | 接口测试 | SSE 事件格式、harness-intervene API、harness.yaml 加载 | API 断言 |

### 测试 workflow 设计

需要创建一组触发各种异常模式的测试 workflow:

```yaml
# test-harness-stupid-retry.yaml
pipeline:
  nodes:
    - id: fail-same-error
      type: bash
      script: |
        echo "error: missing dependency" >&2
        exit 1
      # 会触发 StupidRetryDetector

# test-harness-model-mismatch.yaml
pipeline:
  nodes:
    - id: vision-task
      type: agent
      model: haiku  # 不支持 vision
      prompt: "读取这张图片的内容"
      # 会触发 ModelMismatchDetector

# test-harness-process-conflict.yaml
pipeline:
  nodes:
    - id: kill-host
      type: bash
      script: |
        kill $OCTOPUS_HOST_PID
      # 会触发 ProcessConflictDetector + Wrapper 拦截
```

### 反假运行标准 (R1-R8)
| # | 标准 | 说明 |
|---|------|------|
| R1 | 真实服务 | 用 dev 环境真跑，不 mock |
| R2 | 业务数据 | 断言具体的状态变化，不只断言"成功" |
| R3 | 交叉验证 | API 响应 ↔ DB 状态 ↔ SSE 事件三方一致 |
| R4 | 证据 | 截图 + DB 查询 + API 响应 |
| R5 | 副作用验证 | 干预后验证 VarPool/节点状态确实被修改 |
| R6 | 真实路径 | 通过 UI 操作而非直接调 API |
| R7 | 数据隔离 | 测试 workflow 用 `harness_test_` 前缀 |
| R8 | 可重复 | 无手动前置步骤 |
