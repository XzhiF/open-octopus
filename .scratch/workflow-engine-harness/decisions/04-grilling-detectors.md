# 04 — 检测器（Detector）设计：怎么发现问题？

Type: grilling
Status: open
Blocked by: 01, 02

## Question

Harness 需要检测哪些异常模式？每个模式怎么检测？

候选检测器：
- StupidRetryDetector: 同一节点重试 N 次且错误相同 → 傻重试
- InfiniteLoopDetector: Loop 节点迭代数超过阈值或输出无变化
- ProcessConflictDetector: 子进程试图操作宿主端口/PID
- ModelCapabilityMismatch: agent 请求不支持的能力（如文本模型读图片）
- TimeoutCascadeDetector: 连续多个节点超时
- CostRunawayDetector: token 消耗超过预算
