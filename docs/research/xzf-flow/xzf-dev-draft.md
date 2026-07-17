> ⚠️ **SUPERSEDED** — 此文件为原始头脑风暴草稿，已被 00-overview.md ~ 06-output-structure.md 的正式设计取代。保留仅作参考。

---

❯
首先我需要创建一个工作流 yaml + skills套件的组合(octo-xzf-前缀），来实现一个正向的开发需求到提交RP/MR的octopus系统专有工作流
我说一下，我现在希望相要的流程， 我要稍微改一下这个方法论。
必要资源：专家团： （资深架构师, 产品经理, 测试架构师, 前端专家, 后端专家, 安全专家）

1. 首先输入，是我的一个idea, 开始执行工作流。

2.澄清循环：
循环开始
2.1. 专家团结合codebase对idea进行头脑风暴
- 无论什么idea，都要思考对一个功能完整性，所有环节的闭环
- 出一份需要澄清问题清单markdown文件，核心分解 + 澄清项目，核心分解，澄清项都在用户次回复追加或修改
- 每个需要澄清的问题，可以有2-3种方式，并且第1个为推荐方案
- 很重要的一点，必须要澄清清楚执行E2E测试，所有必须的环境信息，依赖的数据，还有例如项目启动，如何测试的问题必须清晰，不然验证一步无法走通
- 编辑需求澄清文档，明确需求要做什么, 怎么为之是完整的功能，理清所有故事线
- 是否已经足够清晰，可以结束澄清

2.2. approval节点。问题是需要澄清问题清单， 由用户输入审批内容对问题清单进行澄清。 

此处由用户来绝对是否退出循环，例如专家团列表文档内容，并且表示已经足够清楚了，是否需要我补充，或直接通过下一步
结束循环

3.需求故事总汇文档制定循环：
3.1 专家团，根据2出具的文档，讨论之出完整的所有故事线的文档,说明功能组合，完成全部完整故事， 并且根据2.1的测试澄清内容，再出具一份技术性的指导文档。
3.2 确认或修改意见
此处同样由用户来绝对是否退出循环，例如专家团结论的文档内容，并且表示已经足够清楚了，是否需要我补充，或直接通过下一步
循环结束

4.故事设计阶段
专家团对我澄清的问题再进行分析
我这里需要的方法论是：
这一个idea所实现/修改的功能，从使用者的角度（可能N种角色）的每一种完整业务逻辑（故事线）来开始拆分
然后通过走完所有的故事线来形成一个完整的产品形态。
设计的spec是按 用户故事线 来拆分，根据idea拆成N份

通常这些spec会有一定的先后循序，根据实际需求来，一般来讲，第一份spec里会包办打基础底座的相关,然后sepc都是由简单开始到难来做。
一般来说允许他们开始、中间有重复，但是他们最终结果是走了不同的路径，结束，完成了这个故事。
最重要的设计是：系统是一个一个spec开始进行迭代，不从宏观的角度出发，因为这样太容易出错或者遗漏。每进行完一个spec都是在当前的codebase，开始进行设计（数据库，接口，UI，UX）等开始实现。
是一个通过故事驱动，一层一层迭代的开发方法。
这里很考验拆分以及设计能力，每一个spec完成都是一个可交付的版本。

对于一个spec 
4.1：首先当齐冲是这个故事线的 从头到尾，一个整理的流程，达到什么目的。
4.2：然后设计，最先设计的是验证路线，如何验证，如何证明故事走通过了，如何证明结果正确。

4.3：接着设计，故事的所有操作步骤，涉及点，如果有UI,API,数据库操作等等，全部要涉及：
例子： 
张三打开浏览器， 访问 localhost:3000/login，到达登录界面
张三在UI的输入框，输入账号密码，点击登录按钮，请求 localhost:3001/doLogin接口
服务器接受到输入请求，通过LoginControlelr获取到参数，通过ParamValidate进行参数验证
if 参数验证失败 （username 为空 或 password 为空 或.. ） ： 
   return {""}
else 参数正确继续往下：
通过调用LoginService ，委托 UserDao , 通过username 查询 tb_user表， 获取到用户信息
if 用户没数据 ： 
   throw 用户不存在或异常
else 用户存在继续往下
... 
类推，这里最好能设计一个DSL，或者对LLM友好的格式最好, 我需要这条故事线有完整清晰的细节流程，这个是以实现编码的方式去呈现。
如果涉及UI，能画出UI交互图。以AI看得懂的方式。


5.任务计划阶段：
专家团开始生成N个spec:
对于一个spec， 根据其故事的大小，会对其实现开始分配任务给团队成员进行开发。这里任务拆解依据是可以考虑功能的独立性与可并行性。以及旧时代按实际团队中的专业角色去做。
首先专家团会开始讨论这个spec, 接着开始设计，制定方案, 先生成一份总纲领的共识文档：例如DB改动，新增/删除/修改/重命名 文件等等，除了共用的必须对齐的事项，其他不需要细节，只清晰目标的总纲领。
先生成 verify-x-y 的验证方法文档，此文档是先设计验证方法，例如设计函数add方法，输入1, 1，预期2. 当然实际根据任务进行拆解，包含N条验证方式。
再生成 task-x-y-role，的任务文档，顾名思义就是按任务+角色进行分配。 x为任务号，y为子任务号，x相同的表示可以并行开发，y是用来区分第几个子任务。
最后生成这份 spec-test 的完整故事线验证方式的总线路，这个是对spec里故事线的验证试的完整方式。
例如需要用到browse的E2E测试，以及需要连接到DB，来获取数据验证的整个流程。是一个按步骤，一步一步执行，预期到最后走完整个故事线的详细的程序执行逻辑。

6.任务执行阶段
开始一个一个sepc执行，对于一个spec：
按 task-x-y-role , verify-x-y 的组合， 分配role，开始执行完实现， 然后分配测试角色，开始按 verify-x-y 执行。
loop: verify-x-y -> pass or >max_times ? break; role:fix
当所有的task-x-y-role, verify-x-y全部执行通
loop: 开始执行 spec-test -> pass or > max_times ? break; role:fix
如果失败了，保留现场，汇报原因，节点进入错误状态，然后等输入进行干预，手动执行继续尝试执行。
这里要求，必须要保真，不允许跳过，是否通过，需要真实性证明， 如果阻塞了说明理由，让用户进行协助干预

7.ship交付
这里ship交付，主要是根据平台提交PR/MR。首先标题是这一次feature的核心功能内容。
然后内容是 
功能概括， 
实现内容（按模块内容简括）、 
所有实现的用户故事
DB Schema的改动（如果有）
核心实现、约定的介绍
E2E验证证明结果的引导


8.全局注意点：
在任务执行阶段，如果任务失败了，节点走错误，然后必须要发送通知。下一回合，我输入prompt，人工干预，可能是做出补充，或者是我自己准备好环境，让流程继续。
这里的设计， 我是需要一套SKILL(octo-xzf 前缀），系统里安装的agents ,然后基于octopus的workflow来编排实现。 
项目中生成的相关文件荐项目级 .octopus/xzf/{分支名} 下做，包括截图相关等目录。这个目录需要被git仓库记录



--------- ai clearfy





Spec DSL Format (refined)
# Spec-1: User Login

## Meta
- ID: spec-1
- Name: user-login
- Priority: P0
- Depends: none (foundation)
- Roles involved: 普通用户

## Story Line
ACTOR: 普通用户张三
GOAL: 通过账号密码登录系统
OUTCOME: 成功进入个人仪表盘

## Verification Path
> 先于实现设计，定义"通过"标准

### VP-1: 正常登录
- PRECONDITION: DB 存在 user (test@example.com / hashed_password)
- STEPS:
  1. GET /login → 200, 渲染登录表单
  2. POST /api/auth/login { username, password } → 200, { token }
  3. GET /dashboard (with cookie) → 200, 显示用户名
- ASSERT:
  - response.token 非空
  - dashboard 页面包含 "Welcome"
  - cookie 包含 session_id

### VP-2: 错误凭据
- PRECONDITION: 同上
- STEPS:
  1. POST /api/auth/login { username: "test@example.com", password: "wrong" }
- ASSERT:
  - status 401
  - body.error contains "密码错误"
  - 无 session 创建

## Operation Flow

### Step 1: 导航到登录页
ACTOR: browser
ACTION: navigate → http://localhost:3000/login
RENDER: Login component
UI Layout:
┌───────────────────────────┐
│        系统登录            │
│                           │
│  用户名/邮箱              │
│  ┌─────────────────────┐  │
│  │ type="email"        │  │
│  └─────────────────────┘  │
│  密码                     │
│  ┌─────────────────────┐  │
│  │ type="password"     │  │
│  └─────────────────────┘  │
│                           │
│  ┌─────────────────────┐  │
│  │     登  录          │  │
│  └─────────────────────┘  │
│                           │
│  忘记密码？ 注册账号      │
└───────────────────────────┘

### Step 2: 提交登录
ACTOR: browser
ACTION: fill form → submit
REQUEST:
  method: POST
  url: http://localhost:3001/api/auth/login
  body: { username: string, password: string }

### Step 3: 服务端处理
ACTOR: server
ENTRY: AuthController.login(req, res)
FLOW:
1. LoginValidator.validate(req.body)
IF fail → return 400 { error: "参数验证失败", fields: [...] }
2. UserService.findByUsername(username)
IF null → throw UserNotFoundError → 401
3. PasswordService.verify(input_password, user.password_hash)
IF mismatch → throw InvalidCredentialsError → 401
4. SessionService.create(user.id)
→ generate JWT / session token
→ store in redis/memory
5. return 200 {
  token: string,
  user: { id, name, email, role }
}

### Step 4: 前端响应
ACTOR: browser
ON 200:
- cookie.set("session", token)
- router.push("/dashboard")
- UserStore.setUser(response.user)
ON 4xx:
- FormError.show(response.error)
- highlight invalid fields

## Tech Requirements
- DB: tb_user table (id, username, email, password_hash, role, created_at)
- API: POST /api/auth/login
- UI: /login page component
- Auth: JWT or session-based
