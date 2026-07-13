# AutoResearch 泛化框架可行性讨论

> **日期**: 2026-07-13
> **来源**: Karpathy autoresearch 项目分析 → Octopus 泛化框架讨论
> **结论**: 不建议做成核心 Executor，建议做成 skill 试水

---

## 背景

Karpathy 的 [autoresearch](https://github.com/karpathy/autoresearch) 项目实现了一个 AI 自主 ML 研究循环：

- **5 分钟固定循环**: agent 改代码 → 训练 → 评估 → 保留/丢弃
- **单文件约束**: agent 只能改 `train.py`
- **固定评估指标**: `val_bpb`（bits per byte），与 vocab size 无关
- **Git 作为选择机制**: 改进 commit，退化 reset
- **program.md**: 人类写研究策略，agent 执行

核心哲学：**把科研方法论编码为程序**。人定义"什么算好"，agent 搜索"怎么变好"。

---

## 泛化设计讨论

### 抽象出的五个组件

| 组件 | autoresearch 实例 | 泛化接口 |
|------|------------------|---------|
| Constitution | `program.md` | YAML 约束声明（目标、禁区、资源限制） |
| Search Space | `train.py` 一个文件 | 可配置文件集 + 结构化参数空间 |
| Evaluator | `evaluate_bpb()` 写死 | 可插拔：命令执行 + 正则提取 + 约束检查 |
| Selector | git commit/reset | 策略可选：strict / annealing / pareto / population |
| Loop | `while True` | 模式可选：infinite / budgeted / convergent / phased |

### 两条实现路线

**路线 A: 纯 workflow 组合（不改 Octopus 代码）**
- evaluator = bash 节点 + agent 提取节点
- selector = agent 决策节点
- 换领域要重写整个 workflow，评分逻辑藏在 prompt 里
- 能跑，但每换领域 = 复制粘贴改 YAML

**路线 B: 新增 Executor（改 Octopus 代码）**
- 新增 `research_evaluator` Executor：command + extractors + constraints
- 新增 `research_selector` Executor：strategy + compare logic
- 换领域只改 `vars` 配置，节点定义不变
- 真正的泛化，但有维护成本

---

## 场景评估

| 场景 | 现有工具 | Octopus 增值 | 用户量 |
|------|---------|-------------|--------|
| ML 超参搜索 | Optuna, Ray Tune, W&B Sweeps | agent 能改架构不只调参 | 小 |
| API 性能优化 | wrk + CI pipeline | 有限 | 中 |
| 前端包大小优化 | bundle analyzer + CI | 有限 | 中 |
| 算法竞赛 | 手写脚本 | 太窄 | 极小 |
| 数据库调优 | pg_tune, Citus advisor | 领域壁垒高 | 小 |
| 代码重构优化 | SonarQube, CodeClimate | 指标太主观 | 小 |

### 唯一差异化场景

**AI 改代码架构（不只调参）的自主研究循环。**

Optuna 能调数值参数，但不能把 12 层改 8 层、把 attention 换 Mamba、把 ReLU 换 GELU。autoresearch 核心价值是 agent 做**结构性决策**。

但：这个场景用户量极小。大部分人不做 ML 研究，做 ML 研究的人大部分不信任 agent 自主改架构。

---

## 结论

### 不值得做成核心 Executor

1. **用户太少** — 自主 ML 研究循环是学术/研究型场景
2. **现有工具够用** — 数值优化有 Optuna，CI 有 GitHub Actions
3. **维护成本** — 新 Executor = 文档 + 测试 + 向后兼容
4. **Octopus 定位不匹配** — Octopus 是工作流编排平台，不是研究工具

### 建议替代方案：做成 Skill

做成 `octo-auto-research` skill，不碰 engine 代码：

- 用路线 A（纯 YAML workflow 组合）
- 一个 SKILL.md 定义方法论
- 一个 template YAML 定义循环结构
- 用户按自己领域填 vars 配置
- 有人用、反馈好，再考虑升级成 Executor

**成本低，试错快，不污染核心。**

---

## 附录：autoresearch 评分机制

`val_bpb`（validation bits per byte）：

```
        Σᵢ -ln P(yᵢ | context)
BPB = ─────────────────────────────
         ln(2) × Σᵢ bytes(yᵢ)
```

- 分子：所有 token 的负对数似然之和（nats）
- 分母：所有 target token 的 UTF-8 字节总数 × ln(2)
- 与 vocab size 无关，换词汇表也能比
- 验证集固定（shard_06542），评估 token 数固定（~2100 万）
- special tokens（字节数=0）被排除

设计精髓：**控制一切变量，只让 train.py 变**。每次实验的信号是干净的、可比较的。
