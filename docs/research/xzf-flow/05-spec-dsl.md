# Spec DSL 格式規範

> **版本**: v1.0.0-draft
> **日期**: 2026-07-16
> **狀態**: 設計中
> **所屬階段**: Stage 4 — Spec 設計

## 1. 設計理念

Spec DSL 是為 AI Agent 設計的領域特定語言（Domain Specific Language），用於描述用戶故事線的標準化格式。它不是傳統的需求文檔，而是一份 **可直接指導實現的技術藍圖**。

### 核心特點

- **LLM 友好**: 結構化但不僵硬，AI 容易解析和生成。使用固定區塊名稱 + 自由描述內容的混合模式，兼顧機器可讀性和人類可理解性
- **驗證優先**: 先定義如何驗證，再定義如何實現。Verification Path 區塊必須在 Operation Flow 之前設計，確保 TDD 精神
- **故事驅動**: 每個 spec 是一條完整用戶故事線，不是功能點的集合。從用戶視角出發，描述從開始到結束的完整旅程
- **實現導向**: 以偽代碼流描述後端邏輯（Controller → Service → DAO），以 ASCII wireframe 描述 UI，讓 AI Agent 能直接轉譯為代碼
- **完整閉環**: 正常路徑 + 異常路徑 + 邊界條件，三者缺一不可。每個分支都要有明確的處理方式和預期結果

### 設計原則

| 原則 | 說明 | 反模式 |
|------|------|--------|
| 具體勝於抽象 | `INSERT INTO tb_user (name, email)` 而非「保存用戶信息」 | 模糊的「處理數據」 |
| 偽代碼勝於自然語言 | `IF password_hash != stored: return 401` 而非「驗證密碼是否正確」 | 長段落描述 |
| 顯式勝於隱式 | 標註每個 Step 的 ACTOR 是 browser/server/database | 省略執行者 |
| 異常勝於正常 | 每個正常路徑至少配一個異常路徑 | 只寫 happy path |

### 與其他階段的關係

```
Stage 3 (故事總匯)
  ↓ 輸入：summary.md + technical-guide.md
Stage 4 (Spec 設計)  ← 本文件定義的 DSL 格式
  ↓ 輸出：04-specs/spec-NNN-{name}.md
Stage 5 (任務計劃)
  ↓ 輸入：spec DSL 中的 Verification Path + Tech Requirements
```

---

## 2. 完整格式定義

一個完整的 Spec DSL 文件包含以下 7 個區塊，按順序排列：

```
# Spec-{NNN}: {標題}

## Meta          ← 元信息（ID、優先級、依賴、涉及項目）
## Story Line    ← 故事概述（角色、目標、結果、服務鏈）
## Verification Path  ← 驗證路徑（最重要，先於實現設計）
## Operation Flow     ← 操作流程（browser/server/database 三層 + PROJECT 標記）
## Tech Requirements  ← 技術需求（DB/API/UI 變更，按項目分組）
## Edge Cases         ← 邊界情況
## Notes              ← 補充說明（可選）
```

---

### 2.1 Meta 區塊

元信息區塊定義 spec 的身份標識和依賴關係，用於任務排序和並行開發判斷。

```markdown
# Spec-{NNN}: {標題}

## Meta
- ID: spec-{NNN}
- Name: {english-kebab-name}
- Projects involved: {project-a}, {project-b}, {shared-lib}
- Priority: P0/P1/P2
- Depends: none | spec-{NNN}[, spec-{NNN}]
- Roles involved: {角色1}, {角色2}
- Estimated complexity: S/M/L/XL
```

#### 字段說明

| 字段 | 格式 | 說明 |
|------|------|------|
| `ID` | `spec-{NNN}` | 三位數字編號，如 `spec-001` |
| `Name` | kebab-case | 簡短英文名稱，如 `user-login`，用於文件命名 |
| `Projects involved` | 項目名列表 | 多倉庫 workspace 中此 spec 涉及的項目，單項目可省略 |
| `Priority` | `P0` / `P1` / `P2` | P0 = 核心路徑必須先做，P1 = 重要但可延後，P2 = 錦上添花 |
| `Depends` | `none` 或 ID 列表 | 依賴的前置 spec，決定執行順序 |
| `Roles involved` | 角色列表 | 本 spec 涉及的用戶角色 |
| `Estimated complexity` | `S`/`M`/`L`/`XL` | S = 半天，M = 1 天，L = 2-3 天，XL = 需要進一步拆分 |

#### 示例

```markdown
# Spec-001: 用戶登錄

## Meta
- ID: spec-001
- Name: user-login
- Projects involved: project-web, project-auth
- Priority: P0
- Depends: none
- Roles involved: 普通用戶
- Estimated complexity: M
```

---

### 2.2 Story Line 區塊

故事線區塊用簡潔的語言描述「誰、要什麼、達成後怎樣」，是整個 spec 的靈魂。

```markdown
## Story Line
ACTOR: {角色名}（如：普通用戶張三）
GOAL: {用戶要達成什麼}
OUTCOME: {成功後的系統狀態}
CONTEXT: {背景信息，如已登錄/首次使用/等}
SERVICE_CHAIN: {project-web (HTTP)} → {project-gateway (路由)} → {project-auth (認證)}
```

#### 字段說明

| 字段 | 說明 | 示例 |
|------|------|------|
| `ACTOR` | 主要角色，帶具體人名增加代入感 | `普通用戶張三` |
| `GOAL` | 用戶視角的目標，不是技術目標 | `使用郵箱和密碼登錄系統` |
| `OUTCOME` | 成功後的可觀察狀態 | `跳轉到首頁，顯示用戶名和頭像` |
| `CONTEXT` | 前置條件和背景 | `用戶已註冊但尚未登錄，處於登錄頁面` |
| `SERVICE_CHAIN` | 跨項目服務鏈，描述涉及哪些 workspace 項目及其通信方式 | `project-web (HTTP) → project-gateway (路由) → project-auth (認證)` |

> **SERVICE_CHAIN 說明**：描述跨項目的服務鏈。在多倉庫 workspace 中，一個用戶故事通常跨越多個項目（如前端 HTTP 層 → 後端 RPC 服務 → 共享庫類型）。SERVICE_CHAIN 讓 AI Agent 一眼看出这条故事線涉及哪些項目、數據流方向，以及項目間的通信協議（HTTP / RPC / 事件 / 共享類型引用）。單項目場景可省略此字段。

#### 寫作要點

- ACTOR 用具體人名（張三、李四），不用抽象的「用戶 A」
- GOAL 是業務目標，不是「調用 API」
- OUTCOME 必須是可觀察的，能通過 UI 或 API 驗證
- CONTEXT 為 Verification Path 提供前置條件依據

---

### 2.3 Verification Path 區塊

**這是整個 spec 最重要的區塊。** 必須在 Operation Flow 之前設計。設計思路是：「如何證明這個故事走通了？」

```markdown
## Verification Path

### VP-{N}: {驗證場景名}
- PRECONDITION: {前置條件，如 DB 中有什麼數據}
- STEPS:
  1. {操作 1: 如 GET /login}
  2. {操作 2: 如 填寫表單並提交}
  3. {操作 3: 如 檢查頁面跳轉}
- ASSERT:
  - {斷言 1: 如 HTTP status 200}
  - {斷言 2: 如 頁面包含 "Welcome"}
  - {斷言 3: 如 DB 中新增記錄}
- NEGATIVE ASSERT:
  - {反向斷言: 如 不應出現錯誤信息}
```

#### 字段說明

| 字段 | 說明 |
|------|------|
| `VP-{N}` | 驗證路徑編號，一個 spec 通常有 2-5 個 VP |
| `PRECONDITION` | 執行 STEPS 之前系統必須處於什麼狀態（DB 數據、用戶會話等） |
| `STEPS` | 有序操作列表，每一步都必須是可執行的、可驗證的 |
| `ASSERT` | 正向斷言 — 預期系統應該呈現的狀態 |
| `NEGATIVE ASSERT` | 反向斷言 — 預期系統不應該呈現的狀態 |

#### 設計規則

1. **每個正常路徑至少配一個異常路徑**：VP-1 正常登錄，VP-2 錯誤密碼，VP-3 空字段
2. **STEPS 必須可執行**：不是「用戶登錄」，而是「POST /api/auth/login，body: { email, password }」
3. **ASSERT 必須可驗證**：不是「登錄成功」，而是「HTTP 302 重定向到 /dashboard」
4. **PRECONDITION 必須明確**：不是「有用戶」，而是「tb_user 中存在 email=test@example.com, password_hash=bcrypt('123456')」
5. **NEGATIVE ASSERT 不可省略**：明確指出不應該發生的事情

#### 示例

```markdown
## Verification Path

### VP-1: 正常登錄
- PRECONDITION: tb_user 中存在 { email: "zhangsan@test.com", password_hash: bcrypt("123456"), status: "active" }
- STEPS:
  1. GET http://localhost:3000/login
  2. 填寫 input[name="email"] 為 "zhangsan@test.com"
  3. 填寫 input[name="password"] 為 "123456"
  4. 點擊 button[type="submit"]
  5. 等待頁面跳轉
- ASSERT:
  - HTTP response status = 200（API 層面）
  - 瀏覽器 URL 變為 http://localhost:3000/dashboard
  - 頁面包含文字 "歡迎，張三"
  - 響應 Set-Cookie 包含 session token
  - tb_session 新增一條記錄 { user_id: UUID, token: "...", expires_at: > now() }
- NEGATIVE ASSERT:
  - 頁面不包含 "錯誤" 或 "error" 文字
  - tb_session 中無過期 token 記錄

### VP-2: 錯誤密碼
- PRECONDITION: 同 VP-1
- STEPS:
  1. GET http://localhost:3000/login
  2. 填寫 input[name="email"] 為 "zhangsan@test.com"
  3. 填寫 input[name="password"] 為 "wrong_password"
  4. 點擊 button[type="submit"]
- ASSERT:
  - HTTP response status = 401
  - 頁面停留在 /login
  - input[name="password"] 下方顯示 "郵箱或密碼錯誤"
  - tb_session 無新增記錄
- NEGATIVE ASSERT:
  - 不顯示具體是郵箱錯還是密碼錯（安全要求）
  - 不洩露該郵箱是否已註冊

### VP-3: 空字段提交
- PRECONDITION: 無
- STEPS:
  1. GET http://localhost:3000/login
  2. 不填寫任何輸入框
  3. 點擊 button[type="submit"]
- ASSERT:
  - 表單不提交（前端攔截）
  - input[name="email"] 下方顯示 "請輸入郵箱"
  - input[name="password"] 下方顯示 "請輸入密碼"
  - 不發送任何 HTTP 請求
- NEGATIVE ASSERT:
  - 不觸發服務端 API 調用
```

---

### 2.4 Operation Flow 區塊

Operation Flow 以分層偽代碼描述每個步驟的具體執行邏輯。每個 Step 必須標註 ACTOR（執行者），分為三類：

| ACTOR | 含義 | 描述重點 |
|-------|------|---------|
| `browser` | 瀏覽器端 | 用戶操作 + UI 狀態變化 + 請求發起 |
| `server` | 服務端 | Controller → Service → DAO 調用鏈 + 分支邏輯 |
| `database` | 數據庫 | SQL 查詢 / ORM 調用 + 預期結果 |

> **PROJECT 標籤說明**：在多倉庫 workspace 中，每個 Step 必須標註所屬項目（`PROJECT: {project-name}`）。這使得：
> - **任務按項目拆解**：Stage 5 可自動按 PROJECT 分組生成任務
> - **跨項目並行開發**：不同項目的 Step 可分配給不同 Agent 並行實現
> - **清晰的 ownership**：每個 Step 歸屬於具體項目，避免職責模糊
>
> 單項目場景可省略 PROJECT 標籤。

```markdown
## Operation Flow

### Step {N}: {步驟標題}
ACTOR: browser | server | database
PROJECT: {project-name}  # 多倉庫 workspace 必須標註
ACTION: {具體操作描述}

#### 如果 ACTOR 是 browser:
ACTION: navigate to {url} | fill {selector} "{value}" | click {selector}
EXPECT: {頁面預期狀態}
UI: {ASCII wireframe，僅首次出現該頁面時}

#### 如果 ACTOR 是 server:
ENTRY: {Controller.method(req, res)}
FLOW:
  1. {Validator.validate(params)}
     IF {condition}: return {status} {body}
  2. {Service.method(params)}
     → {sub-call 1}
     → IF {condition}: throw {Error}
     → {sub-call 2}
  3. return {status} {body}

#### 如果 ACTOR 是 database:
QUERY: {SQL 或 ORM 調用}
RESULT: {預期結果}
```

#### browser ACTOR 格式

```markdown
### Step 1: 打開登錄頁面
ACTOR: browser
PROJECT: project-web
ACTION: navigate to http://localhost:3000/login
EXPECT: 頁面加載完成，顯示登錄表單
UI: （見 2.5 UI Wireframe 格式）

### Step 2: 填寫並提交表單
ACTOR: browser
PROJECT: project-web
ACTION:
  1. fill input[name="email"] "zhangsan@test.com"
  2. fill input[name="password"] "123456"
  3. click button[type="submit"]
EXPECT: 按鈕顯示 loading 狀態，發送 POST /api/auth/login
```

#### server ACTOR 格式

server 是最核心的部分，使用偽代碼流描述完整處理邏輯：

```markdown
### Step 3: 處理登錄請求
ACTOR: server
PROJECT: project-auth
ENTRY: AuthController.login(req, res)
FLOW:
  1. LoginValidator.validate(req.body)
     → 校驗 email: 非空 + 郵箱格式
     → 校驗 password: 非空 + 長度 ≥ 6
     IF 校驗失敗:
       return 400 { error: "VALIDATION_ERROR", fields: [{ email: "格式錯誤" }] }

  2. AuthService.login(email, password)
     → UserDao.findByEmail(email)
       IF 用戶不存在:
         return 401 { error: "AUTH_FAILED", message: "郵箱或密碼錯誤" }
     → PasswordUtil.compare(password, user.password_hash)
       IF 密碼不匹配:
         → LoginAttemptService.recordFailure(user.id)
         → IF 失敗次數 ≥ 5:
             → UserDao.updateStatus(user.id, "locked")
             return 423 { error: "ACCOUNT_LOCKED", message: "賬戶已鎖定，請 30 分鐘後重試" }
         return 401 { error: "AUTH_FAILED", message: "郵箱或密碼錯誤" }
     → SessionService.createSession(user.id)
       → 生成 JWT token (payload: { userId, email, role })
       → 過期時間: 24h
     → SessionDao.insert({ user_id: user.id, token, expires_at: now() + 24h })

  3. return 200 {
       data: {
         token: "eyJhbG...",
         user: { id, name, email, avatar_url }
       }
     }
     Set-Cookie: session={token}; HttpOnly; Secure; SameSite=Strict; Path=/
```

#### database ACTOR 格式

```markdown
### Step 4: 查詢用戶信息
ACTOR: database
PROJECT: project-auth
QUERY: SELECT id, name, email, password_hash, status, avatar_url
       FROM tb_user
       WHERE email = 'zhangsan@test.com'
       LIMIT 1
RESULT: { id: "uuid-xxx", name: "張三", email: "zhangsan@test.com",
          password_hash: "$2b$10$...", status: "active", avatar_url: "/avatars/xxx.png" }

### Step 5: 創建會話記錄
ACTOR: database
PROJECT: project-auth
QUERY: INSERT INTO tb_session (id, user_id, token, expires_at, created_at)
       VALUES (gen_random_uuid(), 'uuid-xxx', 'eyJhbG...', '2026-07-17T10:00:00Z', now())
       RETURNING id
RESULT: { id: "session-uuid-xxx" }
```

#### 分支處理規範

每個 IF 分支必須包含：
1. **條件**：明確的布爾表達式
2. **動作**：執行什麼操作（return / throw / 調用其他服務）
3. **響應**：返回給調用方的具體格式

```
IF {condition}:
  → {action 1}
  → {action 2}
  return {status} { response_body }
ELSE:
  → {continue}
```

---

### 2.5 UI Wireframe 格式

使用 ASCII art 繪製界面原型，僅在頁面**首次出現**時繪製。重點表達佈局結構和交互元素，不追求視覺精確。

```markdown
### UI: {頁面名}
```
┌─────────────────────────────────┐
│           {頁面標題}             │
│                                 │
│  {Label}:                       │
│  ┌───────────────────────────┐  │
│  │ type="{type}"             │  │
│  │ placeholder="{text}"      │  │
│  └───────────────────────────┘  │
│                                 │
│  ┌───────────────────────────┐  │
│  │        {按鈕文字}          │  │
│  └───────────────────────────┘  │
│                                 │
│  {鏈接文字}                      │
└─────────────────────────────────┘
```
交互說明:
- 點擊 {按鈕}: POST /api/xxx → 成功後跳轉 /yyy
- {輸入框} 為空時: 按鈕 disabled
- 錯誤時: 輸入框下方顯示紅色錯誤文字
```

#### 繪製規則

| 元素 | ASCII 表示 | 說明 |
|------|-----------|------|
| 輸入框 | `┌───┐` 框 + `type=` + `placeholder=` | 標註 input 類型和提示文字 |
| 按鈕 | `┌───┐` 框 + 按鈕文字 | 主要按鈕用雙線框 `╔═══╗` |
| 錯誤提示 | `⚠ {文字}` | 放在對應輸入框下方 |
| 鏈接 | 純文字 + 下劃線說明 | 如 `註冊新賬號 → /register` |
| 導航欄 | 頂部橫線 + 菜單項 | 可省略，除非與本故事相關 |
| 列表項 | 重複的方框 | 畫 2-3 個示意，標註 `...` 表示更多 |
| 狀態指示 | `[✓]` / `[✗]` / `[⟳]` | 成功/失敗/加載中 |

#### 完整示例

```markdown
### UI: 登錄頁面
```
┌────────────────────────────────────────┐
│              Octopus                   │
│                                        │
│         登錄你的賬戶                    │
│                                        │
│  郵箱:                                 │
│  ┌──────────────────────────────────┐  │
│  │ type="email"                     │  │
│  │ placeholder="your@email.com"     │  │
│  └──────────────────────────────────┘  │
│  ⚠ (錯誤時顯示: "請輸入有效的郵箱地址") │
│                                        │
│  密碼:                                 │
│  ┌──────────────────────────────────┐  │
│  │ type="password"                  │  │
│  │ placeholder="輸入密碼"            │  │
│  └──────────────────────────────────┘  │
│  ⚠ (錯誤時顯示: "密碼不能少於 6 位")    │
│                                        │
│  ╔══════════════════════════════════╗  │
│  ║          登  錄                   ║  │
│  ╚══════════════════════════════════╝  │
│                                        │
│  還沒有賬戶？ 註冊新賬戶 → /register    │
│  忘記密碼？ → /forgot-password          │
└────────────────────────────────────────┘
```

交互說明:
- 頁面加載: 自動 focus 郵箱輸入框
- 郵箱格式校驗: 失去焦點時驗證，不合法則顯示 ⚠ 提示
- 密碼長度校驗: 失去焦點時驗證，< 6 位顯示 ⚠ 提示
- 兩個輸入框都為空時: 登錄按鈕 disabled (灰色)
- 點擊登錄: POST /api/auth/login → 成功: 跳轉 /dashboard
- 點擊登錄: POST /api/auth/login → 失敗: 密碼框下方顯示 "郵箱或密碼錯誤"，清空密碼框
- 點擊註冊鏈接: 跳轉 /register
- 點擊忘記密碼: 跳轉 /forgot-password
```

---

### 2.6 Tech Requirements 區塊

技術需求區塊列出具體的 DB/API/UI 變更，是 Stage 5 任務拆解的直接輸入。

```markdown
## Tech Requirements

### 項目間依賴（多倉庫 workspace 新增）
| 源項目 | 目標項目 | 通信方式 | 接口 |
|--------|---------|---------|------|
| {project-web} | {project-auth} | HTTP REST | POST /api/auth/login |
| {project-gateway} | {project-auth} | gRPC | AuthService.VerifyToken |
| {project-web} | {shared-types} | 類型引用 | import { User } from '@org/shared-types' |

### DB 變更（per project）
| Project | 操作 | 表名 | 字段 | 類型 | 約束 |
|---------|------|------|------|------|------|
| {project-auth} | 新增 | tb_xxx | id | UUID | PK, DEFAULT gen_random_uuid() |
| {project-auth} | 新增 | tb_xxx | name | VARCHAR(100) | NOT NULL |
| {project-web} | 修改 | tb_yyy | status | ENUM | ADD VALUE 'pending' |

### API 變更（per project）
| Project | Method | Path | Body | Response | Auth |
|---------|--------|------|------|----------|------|
| {project-auth} | POST | /api/xxx | { field1, field2 } | 201 { data } | Bearer |
| {project-web} | GET | /api/xxx/:id | - | 200 { data } | Bearer |

### UI 變更
| 路徑 | 類型 | 描述 |
|------|------|------|
| /xxx | 新頁面 | {描述} |
| /yyy | 修改 | {描述} |
```

> **多倉庫說明**：在多倉庫 workspace 中，DB 變更和 API 變更按項目分組（`per project`），並新增「項目間依賴」表格描述跨項目通信方式和接口。單項目場景可省略 Project 列和項目間依賴表格。

#### DB 變更規範

- **操作**：`新增`（創建新表或新字段）、`修改`（ALTER）、`刪除`（DROP）、`索引`（CREATE INDEX）
- **類型**：使用具體的 SQL 類型（`UUID`、`VARCHAR(100)`、`TEXT`、`TIMESTAMPTZ`、`BOOLEAN`、`JSONB`）
- **約束**：`PK`、`NOT NULL`、`UNIQUE`、`DEFAULT`、`REFERENCES`、`CHECK`

#### API 變更規範

- **Body**：寫出具體的字段列表和類型，如 `{ email: string, password: string }`
- **Response**：寫出 HTTP 狀態碼 + 響應體結構，如 `200 { data: { token, user } }`
- **Auth**：`none`（公開）、`Bearer`（需 JWT）、`Cookie`（需會話）
- 每個 API 都要標註錯誤響應：`400 { error: "VALIDATION_ERROR" }`、`401 { error: "UNAUTHORIZED" }`

#### UI 變更規範

- **類型**：`新頁面`、`修改`（在已有頁面上改動）、`組件`（新增可複用組件）
- **描述**：簡要說明功能，詳細 UI 在 Wireframe 區塊

---

### 2.7 Edge Cases 區塊

邊界情況區塊記錄那些不在主流程中但必須處理的特殊場景。

```markdown
## Edge Cases

### EC-1: {邊界情況}
- 觸發條件: {如: 並發提交}
- 預期行為: {如: 冪等處理，第二次返回已有結果}
- 實現提示: {如: 使用數據庫唯一約束}

### EC-2: {邊界情況}
- 觸發條件: {如: Token 過期}
- 預期行為: {如: 返回 401 + 引導重新登錄}
- 實現提示: {如: 中間件統一攔截}
```

#### 設計規則

1. 每個 Edge Case 必須有 **觸發條件**、**預期行為**、**實現提示** 三要素
2. 觸發條件要具體：不是「異常情況」，而是「兩個請求在 100ms 內同時提交相同數據」
3. 預期行為要可驗證：不是「正常處理」，而是「第一個請求返回 201，第二個返回 200 + 已有記錄」
4. 實現提示要可操作：不是「加鎖」，而是「使用 `INSERT ... ON CONFLICT DO NOTHING` + 唯一約束」

---

## 3. 完整示例

以下是一個完整的 Spec DSL 示例，展示「用戶登錄」功能的完整故事線：

```markdown
# Spec-001: 用戶登錄

## Meta
- ID: spec-001
- Name: user-login
- Projects involved: project-web, project-auth
- Priority: P0
- Depends: none
- Roles involved: 普通用戶
- Estimated complexity: M

## Story Line
ACTOR: 普通用戶張三
GOAL: 使用郵箱和密碼登錄系統，進入工作台開始使用
OUTCOME: 成功登錄後跳轉到 Dashboard 頁面，右上角顯示用戶頭像和姓名，24 小時內無需重新登錄
CONTEXT: 張三已經完成註冊（spec-000），當前處於未登錄狀態，瀏覽器無有效 session
SERVICE_CHAIN: project-web (HTTP) → project-server (REST API) → project-auth (認證服務)

## Verification Path

### VP-1: 正常登錄 — 郵箱密碼正確
- PRECONDITION:
  - tb_user 中存在: { email: "zhangsan@test.com", password_hash: bcrypt("Abc123!"), status: "active", name: "張三" }
  - 瀏覽器無有效 session cookie
- STEPS:
  1. GET http://localhost:3000/login
  2. fill input[name="email"] "zhangsan@test.com"
  3. fill input[name="password"] "Abc123!"
  4. click button[type="submit"]
  5. 等待頁面跳轉完成
- ASSERT:
  - API 響應: HTTP 200, body 包含 { data: { token: "eyJ...", user: { name: "張三" } } }
  - Set-Cookie 包含 session token，HttpOnly 標記
  - 瀏覽器 URL 變為 http://localhost:3000/dashboard
  - Dashboard 頁面包含 "歡迎，張三"
  - tb_session 新增記錄: { user_id: 匹配, token: 非空, expires_at > now() + 23h }
- NEGATIVE ASSERT:
  - 頁面不包含 "錯誤"、"error"、"失敗" 等文字
  - 密碼框不保留已輸入的密碼

### VP-2: 登錄失敗 — 密碼錯誤
- PRECONDITION: 同 VP-1
- STEPS:
  1. GET http://localhost:3000/login
  2. fill input[name="email"] "zhangsan@test.com"
  3. fill input[name="password"] "wrong_password"
  4. click button[type="submit"]
- ASSERT:
  - API 響應: HTTP 401, body: { error: "AUTH_FAILED", message: "郵箱或密碼錯誤" }
  - 瀏覽器 URL 保持 http://localhost:3000/login
  - 密碼框下方顯示紅色文字 "郵箱或密碼錯誤"
  - 密碼框被清空，郵箱框保留已輸入值
  - tb_login_attempt 新增記錄: { email: "zhangsan@test.com", success: false }
- NEGATIVE ASSERT:
  - 不顯示 "密碼錯誤"（應顯示 "郵箱或密碼錯誤"，不洩露哪項有誤）
  - 不顯示該郵箱是否已註冊
  - 不跳轉到其他頁面

### VP-3: 登錄失敗 — 空字段提交
- PRECONDITION: 無
- STEPS:
  1. GET http://localhost:3000/login
  2. 不填寫任何字段
  3. click button[type="submit"]（如果按鈕未被 disabled）
- ASSERT:
  - 前端攔截提交，不發送 HTTP 請求
  - 郵箱輸入框下方顯示 "請輸入郵箱地址"
  - 密碼輸入框下方顯示 "請輸入密碼"
  - 頁面不跳轉
- NEGATIVE ASSERT:
  - 不發送 POST /api/auth/login 請求
  - 不顯示服務端錯誤信息

## Operation Flow

### Step 1: 打開登錄頁面
ACTOR: browser
PROJECT: project-web
ACTION: navigate to http://localhost:3000/login
EXPECT: 頁面加載完成，顯示登錄表單，自動 focus 郵箱輸入框
UI: （見下方 Wireframe）

### Step 2: 填寫表單並提交
ACTOR: browser
PROJECT: project-web
ACTION:
  1. fill input[name="email"] "zhangsan@test.com"
  2. fill input[name="password"] "Abc123!"
  3. click button[type="submit"]
EXPECT:
  - 按鈕切換為 loading 狀態，顯示 "登錄中..."
  - 發送 POST http://localhost:3001/api/auth/login
  - Request body: { "email": "zhangsan@test.com", "password": "Abc123!" }

### Step 3: 服務端處理登錄請求
ACTOR: server
PROJECT: project-auth
ENTRY: AuthController.login(req, res)
FLOW:
  1. LoginValidator.validate(req.body)
     → 校驗 email: 非空 + 符合郵箱正則 /^[^\s@]+@[^\s@]+\.[^\s@]+$/
     → 校驗 password: 非空 + 長度 ≥ 6
     IF email 為空:
       return 400 { error: "VALIDATION_ERROR", fields: { email: "請輸入郵箱地址" } }
     IF email 格式錯誤:
       return 400 { error: "VALIDATION_ERROR", fields: { email: "請輸入有效的郵箱地址" } }
     IF password 為空:
       return 400 { error: "VALIDATION_ERROR", fields: { password: "請輸入密碼" } }
     IF password 長度 < 6:
       return 400 { error: "VALIDATION_ERROR", fields: { password: "密碼不能少於 6 位" } }

  2. AuthService.login(email, password)
     → UserDao.findByEmail(email)
       IF 查詢結果為 null:
         → LoginAttemptService.recordFailure(email)
         return 401 { error: "AUTH_FAILED", message: "郵箱或密碼錯誤" }

     → PasswordUtil.compare(password, user.password_hash)
       IF 比對失敗:
         → LoginAttemptService.recordFailure(email)
         → failCount = LoginAttemptService.getRecentFailCount(email, window: 30min)
         → IF failCount ≥ 5:
             → UserDao.updateStatus(user.id, "locked")
             → UserDao.updateLockedUntil(user.id, now() + 30min)
             return 423 { error: "ACCOUNT_LOCKED", message: "賬戶已鎖定，請 30 分鐘後重試" }
         return 401 { error: "AUTH_FAILED", message: "郵箱或密碼錯誤" }

     → IF user.status == "locked":
         → IF user.locked_until > now():
             remaining = user.locked_until - now()
             return 423 { error: "ACCOUNT_LOCKED", message: "賬戶已鎖定，請 {remaining} 分鐘後重試" }
         → ELSE:
             → UserDao.updateStatus(user.id, "active")  // 自動解鎖

     → SessionService.createSession(user)
       → payload = { userId: user.id, email: user.email, role: user.role }
       → token = JWT.sign(payload, SECRET_KEY, { expiresIn: "24h" })
     → SessionDao.insert({ user_id: user.id, token: token, expires_at: now() + 24h })
     → LoginAttemptService.clearFailures(email)

  3. return 200 {
       data: {
         token: token,
         user: {
           id: user.id,
           name: user.name,
           email: user.email,
           avatar_url: user.avatar_url,
           role: user.role
         }
       }
     }
     Headers:
       Set-Cookie: session={token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400

### Step 4: 前端處理響應
ACTOR: browser
PROJECT: project-web
ACTION: 接收 API 響應
FLOW:
  IF response.status == 200:
    → 將 token 存入内存 (不存 localStorage)
    → 設置全局 Authorization header
    → window.location.href = "/dashboard"
  IF response.status == 401:
    → 密碼框下方顯示 response.body.error.message
    → 清空密碼框
    → 恢復按鈕為可點擊狀態
  IF response.status == 423:
    → 顯示全局提示: response.body.error.message
    → 恢復按鈕為可點擊狀態
  IF response.status == 400:
    → 遍歷 response.body.error.fields
    → 在對應輸入框下方顯示錯誤文字
    → 恢復按鈕為可點擊狀態
  IF 網絡錯誤:
    → 顯示全局提示: "網絡連接失敗，請檢查網絡後重試"
    → 恢復按鈕為可點擊狀態
EXPECT:
  - 成功: 跳轉到 /dashboard
  - 失敗: 停留在 /login，顯示對應錯誤信息

## Tech Requirements

### 項目間依賴
| 源項目 | 目標項目 | 通信方式 | 接口 |
|--------|---------|---------|------|
| project-web | project-auth | HTTP REST | POST /api/auth/login |
| project-web | project-auth | HTTP REST | POST /api/auth/logout |
| project-web | project-auth | HTTP REST | GET /api/auth/me |

### DB 變更（per project: project-auth）
| 操作 | 表名 | 字段 | 類型 | 約束 |
|------|------|------|------|------|
| 已有 | tb_user | id | UUID | PK |
| 已有 | tb_user | email | VARCHAR(255) | NOT NULL, UNIQUE |
| 已有 | tb_user | password_hash | VARCHAR(255) | NOT NULL |
| 已有 | tb_user | name | VARCHAR(100) | NOT NULL |
| 已有 | tb_user | avatar_url | VARCHAR(500) | NULLABLE |
| 已有 | tb_user | role | VARCHAR(20) | NOT NULL, DEFAULT 'user' |
| 已有 | tb_user | status | VARCHAR(20) | NOT NULL, DEFAULT 'active' |
| 新增 | tb_user | locked_until | TIMESTAMPTZ | NULLABLE |
| 新增 | tb_session | id | UUID | PK, DEFAULT gen_random_uuid() |
| 新增 | tb_session | user_id | UUID | NOT NULL, REFERENCES tb_user(id) |
| 新增 | tb_session | token | TEXT | NOT NULL |
| 新增 | tb_session | expires_at | TIMESTAMPTZ | NOT NULL |
| 新增 | tb_session | created_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() |
| 新增 | tb_login_attempt | id | UUID | PK, DEFAULT gen_random_uuid() |
| 新增 | tb_login_attempt | email | VARCHAR(255) | NOT NULL |
| 新增 | tb_login_attempt | ip_address | INET | NULLABLE |
| 新增 | tb_login_attempt | success | BOOLEAN | NOT NULL |
| 新增 | tb_login_attempt | created_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() |
| 索引 | tb_login_attempt | email + created_at | - | 用於查詢 30 分鐘內失敗次數 |
| 索引 | tb_session | user_id | - | 用於查詢用戶的所有會話 |

### API 變更（per project: project-auth）
| Method | Path | Body | Response | Auth |
|--------|------|------|----------|------|
| POST | /api/auth/login | { email: string, password: string } | 200 { data: { token, user } } | none |
| POST | /api/auth/logout | - | 204 No Content | Cookie |
| GET | /api/auth/me | - | 200 { data: { user } } | Cookie |

錯誤響應:
| 狀態碼 | 場景 | Body |
|--------|------|------|
| 400 | 參數校驗失敗 | { error: "VALIDATION_ERROR", fields: { [field]: "message" } } |
| 401 | 郵箱或密碼錯誤 | { error: "AUTH_FAILED", message: "郵箱或密碼錯誤" } |
| 423 | 賬戶已鎖定 | { error: "ACCOUNT_LOCKED", message: "賬戶已鎖定，請 N 分鐘後重試" } |

### UI 變更
| 路徑 | 類型 | 描述 |
|------|------|------|
| /login | 新頁面 | 登錄頁面，包含郵箱/密碼表單 |
| /dashboard | 修改 | 登錄後跳轉目標，顯示歡迎信息（本 spec 僅跳轉，不實現 Dashboard 內容） |

### UI: 登錄頁面
```
┌────────────────────────────────────────┐
│              Octopus                   │
│                                        │
│         登錄你的賬戶                    │
│                                        │
│  郵箱:                                 │
│  ┌──────────────────────────────────┐  │
│  │ type="email"                     │  │
│  │ placeholder="your@email.com"     │  │
│  └──────────────────────────────────┘  │
│  ⚠ 錯誤提示區域                        │
│                                        │
│  密碼:                                 │
│  ┌──────────────────────────────────┐  │
│  │ type="password"                  │  │
│  │ placeholder="輸入密碼"            │  │
│  └──────────────────────────────────┘  │
│  ⚠ 錯誤提示區域                        │
│                                        │
│  ╔══════════════════════════════════╗  │
│  ║           登  錄                  ║  │
│  ╚══════════════════════════════════╝  │
│                                        │
│  還沒有賬戶？ 註冊新賬戶 → /register    │
│  忘記密碼？ → /forgot-password          │
└────────────────────────────────────────┘
```

交互說明:
- 頁面加載: 自動 focus 郵箱輸入框
- 實時校驗: 輸入框失去焦點時觸發校驗
- 按鈕狀態: 兩個輸入框都有值時 enabled，否則 disabled
- 提交中: 按鈕文字變為 "登錄中..."，disabled，顯示 spinner
- 成功: 跳轉 /dashboard
- 失敗: 顯示錯誤信息，清空密碼框，恢復按鈕狀態

## Edge Cases

### EC-1: 並發登錄
- 觸發條件: 同一用戶在兩個瀏覽器同時提交登錄請求（間隔 < 100ms）
- 預期行為: 兩個請求都成功，各自獲得獨立的 session token。tb_session 中有兩條記錄
- 實現提示: SessionDao.insert 無唯一約束限制，允許同一用戶多個活躍 session

### EC-2: 賬戶鎖定後嘗試登錄
- 觸發條件: 用戶連續 5 次輸入錯誤密碼後，第 6 次輸入正確密碼
- 預期行為: 返回 423，提示 "賬戶已鎖定，請 N 分鐘後重試"。即使密碼正確也不允許登錄
- 實現提示: 在 AuthService.login 中，先檢查 user.status 和 locked_until，再校驗密碼

### EC-3: Token 過期
- 觸發條件: 用戶登錄 24 小時後，session token 過期
- 預期行為: 任何帶 Cookie 的請求返回 401 { error: "SESSION_EXPIRED" }，前端清除本地狀態並跳轉 /login
- 實現提示: 中間件 AuthMiddleware 統一校驗 token 有效期，過期時設置明確的 error code

### EC-4: 郵箱大小寫
- 觸發條件: 用戶註冊時用 "ZhangSan@test.com"，登錄時輸入 "zhangsan@test.com"
- 預期行為: 登錄成功，郵箱不區分大小寫
- 實現提示: UserDao.findByEmail 使用 LOWER(email) = LOWER(?) 查詢；或存儲時統一 toLowerCase()

## Notes
- JWT SECRET_KEY 從環境變量 JWT_SECRET 讀取，不硬編碼
- bcrypt 的 salt rounds 設為 12（安全與性能平衡）
- 登錄失敗次數的滑動窗口為 30 分鐘，鎖定時間為 30 分鐘
- Session 過期時間 24 小時，後續 spec 可擴展「記住我」功能
- 密碼輸入框支持「顯示/隱藏」切換按鈕（UI 細節，不影響流程）
```

> **多倉庫 Workspace 補充說明**
>
> 上述示例以「project-web + project-auth」兩個項目展示跨項目流程。在更複雜的多倉庫場景中，一個用戶故事可能涉及更多項目：
>
> ```
> SERVICE_CHAIN: project-web (HTTP) → project-gateway (路由轉發) → project-auth (認證) → shared-types (類型引用)
> ```
>
> 此時 Operation Flow 的 Step 會跨越多個 PROJECT：
> - `PROJECT: project-web` — 前端頁面和交互
> - `PROJECT: project-gateway` — API 網關路由和轉發
> - `PROJECT: project-auth` — 認證邏輯和 DB 操作
> - `PROJECT: shared-types` — 共享類型定義（如 User、Session 接口）
>
> Tech Requirements 中的「項目間依賴」表格會更長，DB/API 變更按項目分組。Stage 5 任務拆解時可根據 PROJECT 標籤自動分組，實現跨項目並行開發。

---

## 4. 編寫指南

### 4.1 Verification Path 必須可執行

每個 STEP 對應一個可驗證的操作。AI Agent 讀到 STEP 時，應該能直接轉換為 Playwright/Browse 命令或 curl 請求。

```
❌ 壞: "用戶登錄系統"
✅ 好: "POST http://localhost:3001/api/auth/login, body: { email: 'a@b.com', password: '123456' }"
```

### 4.2 Operation Flow 以代碼思維寫

不是文檔，是偽代碼。用 `→` 表示函數調用，用 `IF/ELSE` 表示分支，用 `return` 表示返回值。

```
❌ 壞: "系統驗證用戶身份後返回結果"
✅ 好:
AuthService.login(email, password)
  → UserDao.findByEmail(email)
  → IF null: return 401
  → PasswordUtil.compare(password, hash)
  → IF false: return 401
  → SessionService.createSession(user)
  → return 200 { token, user }
```

### 4.3 UI wireframe 只畫關鍵頁面

不是每個狀態都畫。只畫：
- 頁面首次出現時的初始狀態
- 與本故事線直接相關的核心交互元素
- 錯誤狀態可以文字描述，不需要單獨畫圖

### 4.4 異常路徑和正常路徑同等重要

每個正常路徑的 Operation Flow，都要思考：
- 輸入校驗失敗怎麼辦？
- 數據不存在怎麼辦？
- 權限不足怎麼辦？
- 網絡超時怎麼辦？
- 並發衝突怎麼辦？

### 4.5 每個 Step 的 ACTOR 和 PROJECT 必須明確標註

不要讓 AI 猜測這段邏輯在哪裡執行。`browser`、`server`、`database` 三選一，一個 Step 只有一個 ACTOR。如果一個操作涉及多層（如前端發請求 → 後端處理 → 數據庫查詢），拆成多個 Step。

在多倉庫 workspace 中，每個 Step 還必須標註 `PROJECT`，讓 AI 知道這段邏輯屬於哪個項目。這直接影響 Stage 5 的任務分組和 Agent 分配。

### 4.6 Tech Requirements 要具體到字段類型和約束

這是 Stage 5 任務拆解的直接輸入。模糊的描述會導致任務不清晰。

```
❌ 壞: "新增用戶表"
✅ 好: "新增 tb_user: id UUID PK, email VARCHAR(255) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL"
```

### 4.7 編號和命名約定

| 項目 | 格式 | 示例 |
|------|------|------|
| Spec ID | `spec-{NNN}` | `spec-001` |
| VP 編號 | `VP-{N}` | `VP-1` |
| Step 編號 | `Step {N}` | `Step 3` |
| EC 編號 | `EC-{N}` | `EC-2` |
| UI 名稱 | 中文頁面名 | `UI: 登錄頁面` |
| 文件名 | `spec-{NNN}-{name}.md` | `spec-001-user-login.md` |

### 4.8 常見錯誤清單

| 錯誤 | 說明 | 修正 |
|------|------|------|
| VP 沒有 PRECONDITION | 不知道測試前要準備什麼數據 | 寫清楚 DB 中要有什麼記錄 |
| Step 沒有 ACTOR | 不知道邏輯在哪層執行 | 每個 Step 標 browser/server/database |
| Step 缺少 PROJECT | 多倉庫時不知道邏輯屬於哪個項目 | 每個 Step 標 PROJECT: {project-name} |
| server FLOW 缺少分支 | 只寫了 happy path | 每個 IF 都要有 return 或 throw |
| ASSERT 太模糊 | "登錄成功" 無法驗證 | 寫具體的 HTTP code + 頁面文字 + DB 記錄 |
| Tech Requirements 缺類型 | "新增字段 status" | 寫 `status VARCHAR(20) NOT NULL DEFAULT 'active'` |
| Tech Requirements 未分項目 | 多倉庫時 DB/API 混在一起 | 按 project 分組，加項目間依賴表 |
| Wireframe 畫了太多細節 | 每個狀態都畫一遍 | 只畫初始狀態，其他用文字描述 |
| Edge Cases 遺漏 | 只考慮正常使用 | 思考並發、過期、鎖定、大小寫、網絡異常 |
| Story Line 缺 SERVICE_CHAIN | 不知道故事線跨哪些項目 | 寫出項目鏈和通信方式 |
