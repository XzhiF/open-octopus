---
name: author-verified-tickets
description: Enhancement of to-tickets. Adds verification method binding — every ticket gets executable verification steps. Used as a guide by the main session during author-verified-requirement.
reference-only: true
---

# Verified Tickets — Enhancement of `to-tickets`

> **This skill enhances `to-tickets`.** Follow `to-tickets` for the base process (tracer bullet splitting, blocking edges, publishing), then add the verification enhancements below.
> It is a methodology reference — the main session reads it when writing issues/ during `author-verified-requirement`. NOT auto-invoked by any agent.

## Base Skill

Follow `to-tickets` for:
- **Process**: Gather context → Explore codebase → Draft vertical slices → Quiz user → Publish
- **Tracer bullet principles**: narrow end-to-end path, demoable independently, one session size, prefactoring first
- **Blocking edges**: each ticket declares what blocks it (this creates the DAG)
- **Split ordering**: DB → Entity → Service → Controller → Frontend API → Pages → E2E
- **Publishing**: one file per ticket under `<artifacts.dir>/<feature-slug>/issues/<NN>-<slug>.md`

## Enhancements (补充 Verification Methods)

The core enhancement: each ticket gets a **Verification Method** section in addition to Acceptance Criteria.

### Add to `to-tickets` template — insert after Acceptance Criteria:

```markdown
## Verification Method

**Verification type**: [unit test / integration test / contract test / manual checklist]（功能票限此四类；**browser E2E 只出现在末张 `NN-e2e-*` 验收票**——见 Rule 5）

**Prerequisites**:
- [ ] [e.g., backend compiles]
- [ ] [e.g., test data is ready]

**Verification steps**:

### Unit Tests (if applicable)

cd <project-root>
pnpm test  # Vitest

Pass criteria: All test methods PASS

### Integration Tests (if applicable)

Step 1: Get token
Step 2: Record pre-test state (DB query)
Step 3: Call API
Step 4: Verify API response (assert business fields)
Step 5: DB verification
Step 6: Cache verification
Step 7: Cross-validation: API <-> DB <-> Cache
Step 8: Cleanup

### Browser E2E（仅末张 `NN-e2e-*` 验收票，功能票禁写）

1. Playwright script: login -> navigate -> operate -> assert -> screenshot

末张票的走查步**必须**用「验收台剧本形状」写（Rule 6 硬契约）——节结构与词表示意（步 = 动作 + `→` 断言，可执行断言的命令用行反引号且以 curl/sqlite3/mvn/node 等命令词起头）：

    **类型**: E2E（浏览器走查）          ← 或 E2E（API 级走查，不开浏览器）

    ## 走查步骤

    1. 打开 系统管理→Token 计费 → 价格表渲染，列齐全
    2. 真值断言：`curl -sf 'http://localhost:8080/api/x?no=123'` → data == true
    3. 收尾：`kill java` → 端口拒连

    **Pass criteria**: 全部步骤断言成立，证据（截图/响应体）贴票尾

### Contract Verification (if applicable)

- [ ] Backend VO fields <-> Frontend interface fields match
- [ ] API paths match between backend and frontend
- [ ] Field types match (watch String vs Number)

### Manual Checklist (if applicable)

- [ ] V1: [specific check]
- [ ] V2: [specific check]

**Pass criteria**: All verification steps PASS, evidence chain complete
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason
```

## Additional Rules (beyond `to-tickets`)

1. **Every ticket MUST have a Verification Method** — no verification = incomplete ticket
2. **Executable verification** — specific commands, specific SQL, specific assertions (not "test the API")
3. **DAG structure** — tickets without mutual blockers can run concurrently in the same stage
4. **One session size** — each ticket's implementation + verification fits in one agent session
5. **Verification-type ladder（browser 去重）** — 功能票的验证类型限 unit / integration(API↔DB 交叉) / contract / manual：不起 dev server 走浏览器、不做故事走查。UI 功能票的渲染与交互断言（列齐全/徽标/换算即时生效等）**收编为末张 `NN-e2e-*` 票的走查步骤**，功能票本体只验到 API 响应 + DB 直查。全 phase 真起浏览器 + 留截图证据的地方**恒唯一 = 末张验收票**（否则同一 UI 检查双跑，白烧 vision/playwright 成本）。末张票模式**随验收面自动选**：有 UI/页面交互 → browser 走查；纯后端/无 UI phase → API 级走查（curl+sqlite+手算，天然形态无需声明——不给不存在的页面烧成本）。有 UI 时若 spec 验证纪律显式拍板「全流程不做浏览器 E2E」，末张同为 API 级——但功能票禁令无条件，不随该拍板豁免。
6. **验收台剧本形状（末张票硬契约，2026-09-21）** — 验货台的「验收剧本」由编译器从末张 `NN-e2e-*` 票机械解析出人工走查步；形状不对 = 用户面对空剧本柜（历史上 09-06 批中文票整批编不出步）。票面必须满足二选一：
   - **实票方言（推荐，中文票）**：类型行 `**类型**: E2E（浏览器走查）` / `（API 级走查，不开浏览器）`（裸 `Type:` 行、`走查模式：` 行同样认）+ `## 走查步骤` 标题下编号步（≤8 步；每步 `动作 → 断言`，可执行断言把命令放行反引号且以命令词起头——curl/sqlite3/mvn/pnpm/node 等，散文步会编成人工核对步）+ 收尾句 `**Pass criteria**:`（裸 `**Pass**:` 也认）。
   - **正典方言**：`## Acceptance Criteria` 子弹 + `**Verification type**:` 行 + ```bash 围栏命令（取最后一段、≤3 probe）。
   写完末张票自查一遍：`## 走查步骤`（或 `## Acceptance Criteria`）**必须是 h2 节标题**——票标题行（h1）里出现「故事走查」等字样不算数。
7. **phase 票预算（2026-09-21 整轮 94min 实测复盘，提速硬纪律）** —
   - **DAG 深度 ≤2 是硬纪律，票数上限只是其推论**。实测：5 票 4 层串行 58min，并行只救回 17min——**时长由关键路径决定，不由工作量决定**。拆 Blocked-by 时自问：这条依赖边是不是把图拉成三层链？若两票被依赖链逼成串行、各自体量又小（≤1h），**必须合并**成一张。"地基票 + 若干并行 + 汇聚票"的四层链是最坏形状——把地基并进第一批并行票之一、或让汇聚票的活摊回各票。
   - **e2e 验收票只给任务的最后一个 phase 产**。中间 phase 的批次不产 `NN-e2e-*` 票，并在 spec 的 Verification 段写 `Verification Tier: unit-only`（spec-resolve 据此 has_e2e=false → 整轮跳过最贵的 e2e-verify 走查节点，单节点实测 25min+）。中间 phase 的正确性由票的 unit/integration 验证 + code-review 兜底；端到端实况验收集中到末 phase 一次做完。
   - **票内验证写子集**：Verification Method 只列本票自己改动/新增的测试文件与用例（`vitest run <files>`、`-t <name>` 形态），**不写"跑全量测试套件"**——票内全量被执行侧契约禁止（matt-spec-dev 票模板），全量恰一次归 code-review 终检。
