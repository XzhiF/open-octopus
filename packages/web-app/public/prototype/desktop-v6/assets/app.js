/* ==========================================================================
   Octopus NEXUS v5 — Matrix command deck kernel
   Window manager + rail shortcuts + live console + boot + digital rain.
   Fake data only. No build, no deps.
   ========================================================================== */
(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    <symbol id="i-logo" viewBox="0 0 24 24"><path d="M12 3l9 9-9 9-9-9 9-9Z"/><circle cx="12" cy="12" r="2.4"/></symbol>
    <symbol id="i-gauge" viewBox="0 0 24 24"><path d="M4.5 17.5a8.5 8.5 0 1 1 15 0"/><path d="M12 14.5 15.5 9.5"/><circle cx="12" cy="15.5" r="1.2"/></symbol>
    <symbol id="i-kanban" viewBox="0 0 24 24"><rect x="3.5" y="4" width="5" height="16" rx="1.2"/><rect x="10.5" y="4" width="5" height="10" rx="1.2"/><rect x="17.5" y="4" width="3" height="13" rx="1.2"/></symbol>
    <symbol id="i-activity" viewBox="0 0 24 24"><path d="M3 12.5h4l2.5-7 4 13.5L16 12.5h5"/></symbol>
    <symbol id="i-bot" viewBox="0 0 24 24"><rect x="5" y="8.5" width="14" height="10" rx="2.5"/><path d="M12 4.5v4M8.5 19.5v1.8M15.5 19.5v1.8M10 13h.01M14 13h.01"/><path d="M10 16h4"/></symbol>
    <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l2.8 2.2"/></symbol>
    <symbol id="i-book" viewBox="0 0 24 24"><path d="M12 6.3C10.3 4.8 8 4.2 4.5 4.2v14c3.5 0 5.8.6 7.5 2.1 1.7-1.5 4-2.1 7.5-2.1v-14c-3.5 0-5.8.6-7.5 2.1Z"/><path d="M12 6.3v14"/></symbol>
    <symbol id="i-layers" viewBox="0 0 24 24"><path d="m12 3 8 4.5-8 4.5L4 7.5 12 3Z"/><path d="m4 12 8 4.5L20 12"/><path d="m4 16.5 8 4.5 8-4.5"/></symbol>
    <symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 8h9M18.5 8H20M4 16h2M11 16h9"/><circle cx="15.5" cy="8" r="2.2"/><circle cx="8" cy="16" r="2.2"/></symbol>
    <symbol id="i-tray" viewBox="0 0 24 24"><path d="M4 13.5h4.5l1.2 2h4.6l1.2-2H20"/><path d="M5.5 13.5 7.5 5h9l2 8.5V19h-13v-5.5Z"/></symbol>
    <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m19.5 19.5-4.2-4.2"/></symbol>
    <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></symbol>
    <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 13.7A8.2 8.2 0 1 1 10.3 4a6.6 6.6 0 0 0 9.7 9.7Z"/></symbol>
    <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3.5 5.5 6v5c0 4.4 2.7 7.8 6.5 9.5 3.8-1.7 6.5-5.1 6.5-9.5V6L12 3.5Z"/><path d="M12 9v4M12 16h.01"/></symbol>
    <symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 4 2.8 20h18.4L12 4Z"/><path d="M12 10.5V15M12 17.5h.01"/></symbol>
    <symbol id="i-msg" viewBox="0 0 24 24"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L3 21l1.8-5.4A8.5 8.5 0 1 1 21 11.5Z"/></symbol>
    <symbol id="i-retry" viewBox="0 0 24 24"><path d="M20 11.5A8 8 0 1 0 12 20"/><path d="M20 4.5v7h-7"/></symbol>
    <symbol id="i-package" viewBox="0 0 24 24"><path d="m12 3 8 4.3v9.4L12 21l-8-4.3V7.3L12 3Z"/><path d="m4 7.5 8 4.3 8-4.3M12 11.8V21"/></symbol>
    <symbol id="i-git" viewBox="0 0 24 24"><circle cx="6.5" cy="6" r="2.2"/><circle cx="6.5" cy="18" r="2.2"/><circle cx="17.5" cy="8.5" r="2.2"/><path d="M6.5 8.2v7.6M8.7 6.5h4.4a3.4 3.4 0 0 1 3.4 3.4v.6"/></symbol>
    <symbol id="i-diamond" viewBox="0 0 24 24"><path d="M12 4.5 19.5 12 12 19.5 4.5 12 12 4.5Z"/></symbol>
    <symbol id="i-minus" viewBox="0 0 24 24"><path d="M6.5 12h11"/></symbol>
    <symbol id="i-square" viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="1.6"/></symbol>
    <symbol id="i-x" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></symbol>
    <symbol id="i-chev-down" viewBox="0 0 24 24"><path d="m6.5 9.5 5.5 5.5 5.5-5.5"/></symbol>
    <symbol id="i-play" viewBox="0 0 24 24"><path d="M7.5 4.8 19 12 7.5 19.2V4.8Z"/></symbol>
    <symbol id="i-check" viewBox="0 0 24 24"><path d="m4.5 12.5 5 5 10-11"/></symbol>
  </defs></svg>`;
  document.body.insertAdjacentHTML("afterbegin", SPRITE);
  const ico = (n) => '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-' + n + '"/></svg>';

  const LS_STATE = "octopus.desktop.v6.settings";
  const LS_WINS = "octopus.desktop.v6.windows";
  const GLOBAL = "GLOBAL";

  /* ---------------- data ---------------- */
  const SPACES = [
    { id: "open-octopus", name: "open-octopus" },
    { id: "marketing-site", name: "marketing-site" },
    { id: "research-scout", name: "research-scout" },
  ];

  const mkTask = (id, title, desc, column, progress, meta, labels) =>
    ({ id, title, desc, column, progress, meta, labels });

  const DATA = {
    "open-octopus": {
      tasks: [
        {
          id: "T-01", title: "Desktop v5 · NEXUS 重构", desc: "命令甲板 + 数字雨 + 控制台。窗口模型继承 v4，快捷方式回归 v1。",
          column: "executing", progress: 42, meta: "feat/desktop-v5 · round 1", labels: ["frontend", "shell"],
          phases: [
            { t: "Shell + window mgr", m: "drag · snap · z-order · persist", s: "done" },
            { t: "Rail 快捷回归", m: "⌥1-8 · badges · live dots", s: "done" },
            { t: "Console 指令层", m: "new · run · ask · goto", s: "run" },
            { t: "验收走查", m: "4 probes · 键盘覆盖", s: "next" },
          ],
          checks: [
            { l: "所有 rail 应用一键直达", ok: true }, { l: "控制台指令闭环", ok: true },
            { l: "窗口几何跨 space 保留", ok: true }, { l: "明暗主题持久化", ok: false },
          ],
          acc: "3 / 4 probes pass. 剩余: 主题持久化在刷新后丢失.",
        },
        {
          id: "T-02", title: "Task acceptance · round 2", desc: "看板、Run 详情、持久会话的全键盘走查。",
          column: "verify", progress: 80, meta: "验收台 · 4/5 walkthrough", labels: ["acceptance"],
          phases: [
            { t: "Board walkthrough", m: "lanes + inspector", s: "done" },
            { t: "Run walkthrough", m: "graph · logs · cost", s: "done" },
            { t: "Keyboard pass", m: "focus order", s: "run" },
          ],
          checks: [
            { l: "卡片 → Inspector 开窗", ok: true }, { l: "Run 详情切换不丢状态", ok: true },
            { l: "草稿跨窗口保留", ok: true }, { l: "Split 焦点顺序", ok: false },
          ],
          acc: "等待人工: focus-order 缺陷未复验.",
        },
        {
          id: "T-03", title: "nightly-knowledge-compile", desc: "02:00 定时编译 wiki 索引，预算 $2。",
          column: "queued", progress: 0, meta: "scheduler · cron 0 2 * * *", labels: ["ops"],
          phases: [{ t: "Compile", m: "214 pages", s: "next" }],
          checks: [{ l: "预算内完成", ok: false }], acc: "未开始.",
        },
        {
          id: "T-04", title: "harness 接入 P0", desc: "A/B 候选证伪后，strip 已撤回；等待新靶子。",
          column: "done", progress: 100, meta: "closed · 6 probes green", labels: ["harness"],
          phases: [{ t: "Forensics", m: "toolDenialKind=cancelled", s: "done" }],
          checks: [{ l: "结论入册", ok: true }], acc: "PASS.",
        },
      ],
      runs: [
        {
          id: "R-91", name: "feat-desktop-shell", task: "T-01", state: "run", progress: 68, cost: "$0.84", tok: "128k", el: "18m",
          nodes: [
            { n: "plan", k: "agent", s: "d" }, { n: "scaffold", k: "bash", s: "d" },
            { n: "build", k: "agent", s: "r" }, { n: "test", k: "bash", s: "" }, { n: "review", k: "swarm", s: "" }, { n: "deploy", k: "approval", s: "" },
          ],
          logs: [
            { l: "sys", t: "19:02:11", m: "EXECUTOR agent::build → worktree feat/desktop-v5" },
            { l: "run", t: "19:04:52", m: "read packages/web-app/public/prototype/desktop-v4/assets/app.js" },
            { l: "run", t: "19:08:14", m: "write assets/app.css — 412 tokens/s" },
            { l: "warn", t: "19:11:40", m: "snap-preview z-index collision — retry with layer 400" },
            { l: "run", t: "19:15:03", m: "node build 3/6 · window manager passing smoke" },
          ],
        },
        {
          id: "R-92", name: "task-acceptance · r2", task: "T-02", state: "wait", progress: 80, cost: "$1.12", tok: "96k", el: "42m",
          nodes: [
            { n: "walkthrough", k: "agent", s: "d" }, { n: "keyboard", k: "agent", s: "w" }, { n: "verdict", k: "approval", s: "" },
          ],
          logs: [
            { l: "run", t: "18:31:02", m: "probe 1-4 PASS · board · inspector · runs · persistence" },
            { l: "warn", t: "18:58:47", m: "probe 5 focus-order: ⌥T after mission-close lands on rail — 42m waiting human" },
          ],
        },
        {
          id: "R-90", name: "clone · research-scout", task: "T-04", state: "done", progress: 100, cost: "$0.21", tok: "34k", el: "6m",
          nodes: [{ n: "fork", k: "bash", s: "d" }, { n: "scan", k: "agent", s: "d" }, { n: "report", k: "agent", s: "d" }],
          logs: [{ l: "ok", t: "17:40:00", m: "done · findings saved to wiki/sources" }],
        },
        {
          id: "R-93", name: "nightly-knowledge-compile", task: "T-03", state: "queue", progress: 0, cost: "—", tok: "—", el: "in 7h",
          nodes: [{ n: "index", k: "bash", s: "" }, { n: "compile", k: "agent", s: "" }, { n: "prune", k: "python", s: "" }],
          logs: [{ l: "sys", t: "--:--:--", m: "queued · cron 0 2 * * * · budget $2.00" }],
        },
      ],
    },
    "marketing-site": {
      tasks: [
        mkTask("M-01", "落地页 v3 文案", "hero + 三个能力卡片重写", "executing", 55, "landing · draft 2", ["copy"]),
        mkTask("M-02", "SEO 技术审计", "Core Web Vitals + meta 审查", "queued", 0, "seo-specialist skill", ["seo"]),
      ],
      runs: [
        { id: "R-21", name: "copy-rewrite", task: "M-01", state: "run", progress: 55, cost: "$0.12", tok: "22k", el: "9m", nodes: [{ n: "draft", k: "agent", s: "d" }, { n: "tone-check", k: "condition", s: "r" }], logs: [{ l: "run", t: "19:20:00", m: "hero rewritten · 2 variants" }] },
      ],
    },
    "research-scout": {
      tasks: [
        mkTask("S-01", "上下文注入竞态调研", "上游 SDK 消息序证据链", "verify", 72, "issue #104 复验", ["research"]),
        mkTask("S-02", "Loop 工程模式图谱", "harness 接入候选 ×9", "executing", 33, "kb · xzf-dev 分析", ["kb"]),
      ],
      runs: [
        { id: "R-31", name: "debate · consensus", task: "S-01", state: "run", progress: 72, cost: "$0.44", tok: "61k", el: "22m", nodes: [{ n: "round1", k: "swarm", s: "d" }, { n: "round2", k: "swarm", s: "d" }, { n: "consensus", k: "agent", s: "r" }], logs: [{ l: "run", t: "19:05:10", m: "round 2 · 3/5 agents converge" }] },
      ],
    },
  };

  const ALERTS = [
    { id: "A1", kind: "shield", t: "Approve deploy → prod", s: "harness guard · feat-desktop-shell · 剩 40m", a: "APPROVE" },
    { id: "A2", kind: "msg", t: "窗口模型拍板", s: "main agent · 等你选择哲学", a: "ANSWER" },
    { id: "A3", kind: "retry", t: "Retry archive · task 118", s: "archive failed · 2 attempts", a: "RETRY" },
  ];

  const AGENT_MSGS = [
    { role: "u", t: "重新设计整个界面。要像原生桌面应用，黑客帝国那种感觉。先把 v1 的快捷方式找回来。", time: "19:01" },
    { role: "a", time: "19:01 · read + planned", tools: [{ k: "READ", d: "prototype/desktop-v1 → v4 · 24 files", ms: "1.8s" }],
      text: "已锁定几何：<b>命令甲板</b>。左侧 rail 回归——<code>⌥1..8</code> 一键直达；底栏常驻控制台，能打的都能敲；配色换成克制的中性灰，正文无衬线、等宽只留给数据。明暗两版，右上角 ☀/☾ 切。" },
    { role: "a", time: "19:03", tools: [{ k: "WRITE", d: "desktop-v5/assets/app.css · 900 lines", ms: "3.2s" }],
      text: "没有「页面」，只有进程和窗口。试试 <code>`</code> 进控制台，敲 <code>ask 今天的验收状态</code>；或 <code>theme dark</code> 看暗色版。" },
  ];

  const JOBS = [
    { name: "nightly-knowledge-compile", cron: "0 2 * * *", next: "in 7h", last: "ok · 6h ago", on: true },
    { name: "repos-rebuild-index", cron: "*/30 * * * *", next: "in 12m", last: "ok · 18m ago", on: true },
    { name: "session-summary-sweep", cron: "0 */4 * * *", next: "in 1h", last: "fail · 4h ago", on: true },
    { name: "stale-probe · worktrees", cron: "0 9 * * 1", next: "Mon 09:00", last: "ok · 5d ago", on: false },
  ];

  const WIKI = {
    pages: [
      { dir: "ENTITIES", items: [{ id: "wm", t: "workflow-engine" }, { id: "ws", t: "workspace-isolation" }, { id: "ag", t: "agent-runtime" }] },
      { dir: "TOPICS", items: [{ id: "loop", t: "loop-engineering" }, { id: "har", t: "harness-integration" }] },
      { dir: "CONCEPTS", items: [{ id: "win", t: "window-model" }, { id: "tok", t: "token-ledger" }] },
    ],
    docs: {
      win: {
        title: "window-model", meta: "compiled · 214 sources · edited 09:12 · 6 refs",
        body: "<p>窗口是<b>持久状态的视图</b>，不是状态本身。关闭一个窗口只释放视图：run 继续流，任务继续跑，重新打开时从原几何与原滚动位置恢复。</p>"
          + "<h2>三态生命周期</h2>"
          + "<div class=\"wcode\">open ──min──▸ shelf ──close──▸ closed ──⌘K/`open tasks`──▸ open\n geometry + tab + scroll 存活于 localStorage</div>"
          + "<p><span class=\"wref\"><b>[ref:src-018]</b> desktop-v1/README · <b>[ref:src-042]</b> desktop-v4/README · <b>[ref:src-077]</b> ADR-0033</span></p>"
          + "<h2>NEXUS 修正</h2>"
          + "<p>v4 把 rail 换成 Launcher 后被证伪：十步以上模块的直达率从 1 降到 3（⌘K 两次击键 + 一次选择）。v5 恢复 ⌥N 单键跳，Launcher 让位给控制台。</p>",
      },
      wm: { title: "workflow-engine", meta: "compiled · 108 sources · 7 executors",
        body: "<p>YAML → 7 执行器：Bash / Python / Agent / Condition / Approval / Loop / Swarm。编排模式 chain / DAG / swarm / dynamic。</p><h2>变量</h2><div class=\"wcode\">$vars.* · $node.output.* · $last_output · $iteration</div>" },
      loop: { title: "loop-engineering", meta: "compiled · 33 sources · xzf-dev 分析",
        body: "<p>验证驱动收敛：每轮读 verification-report，生成 gap brief，再执行，直到 confidence ≥ 85 或硬停。</p>" },
      har: { title: "harness-integration", meta: "stale ⚠ · edited 09-26",
        body: "<p>工具拒绝风暴 = SDK toolDenialKind=cancelled（abort 非 deny）。5 个 A/B 候选全部证伪，env 泄漏必要非充分。</p><h2>杠杆</h2><p>harness 接入是当前最大杠杆位（P4 主图）。</p>" },
    },
  };

  const RES = {
    skills: [
      { n: "octo-workflow-dev", v: "2.1.0", d: "工作流 YAML 创建/编辑/调试 · 11 节点类型" },
      { n: "octo-resource-manager", v: "1.4.2", d: "资源库搜索与安装" },
      { n: "matt-dev-pipeline", v: "3.0.1", d: "DAG 并发开发流水线" },
      { n: "octo-wiki", v: "1.1.0", d: "编译型知识库只读查阅协议" },
      { n: "decision-brief", v: "1.0.0", d: "拍板简报制式（替代 AskUserQuestion）" },
      { n: "octo-engine-debug", v: "1.2.3", d: "执行器卡死 / VarPool / SSE 排障" },
    ],
    sources: [
      { n: "xzf/dev-skills", d: "git · 12 skills · synced 2h ago" },
      { n: "anthropics/skills", d: "git · 18 skills · synced 1d ago" },
    ],
  };

  const FEED_POOL = [
    ["run", "R-91", "node build · chunk 3/9 written"],
    ["ok", "R-90", "clone scan finished · 4 findings"],
    ["warn", "A1", "approval expires in 38m"],
    ["run", "R-31", "round 2 · consensus at 0.81"],
    ["ask", "main", "awaiting window-model answer"],
    ["ok", "sched", "repos-rebuild-index · next in 12m"],
    ["run", "R-91", "assets/app.js — window mgr online"],
  ];
  const LOG_POOL = [
    ["run", "theme tokens applied · light/dark ok"],
    ["run", "wm.open(tasks) · geom restored from localStorage"],
    ["sys", "log stream attached · sse backoff ok"],
    ["run", "console.parse(\"new v6 dock badges\") → queued"],
    ["warn", "z-order conflict with snap-preview · resolved layer 400"],
    ["run", "agent typing effect · 14ms/char · caret ▊"],
    ["ok", "tile(3) → [0,0][1,0][2,0] snapped"],
  ];
  const REPLIES = [
    "收到。已把这条指令分发到当前 space 的进程表——窗口没有丢失，上下文还在。",
    "在。今天的账：3 个 run 活着，2 件事等你。先点 HUD 上的 <code>! NEEDS-YOU</code>。",
    "试过了：窗口模型 + rail 快捷 + 控制台三层，直达率回到 1 击。详见 wiki::window-model。",
  ];

  /* ---------------- settings / state ---------------- */
  let settings = { space: SPACES[0].id, theme: "light", hist: [] };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(LS_STATE) || "{}")); } catch {}
  delete settings.phos; delete settings.rain; delete settings.scan;

  const root = document.documentElement;
  function applySettings() {
    root.dataset.theme = settings.theme;
    saveSettings();
  }
  function saveSettings() { try { localStorage.setItem(LS_STATE, JSON.stringify(settings)); } catch {} }

  function spaceState(id) {
    let store = DATA[id];
    if (!store) store = DATA[id] = {};
    if (!store.state) {
      store.state = {
        selTask: null,
        selRun: (store.runs || [])[0]?.id || null,
        runTab: "logs", wikiPage: "win",
        chat: id === GLOBAL ? AGENT_MSGS.map((m) => ({ ...m })) : [],
        typing: false,
      };
    }
    return store.state;
  }

  /* ---------------- APPS registry ---------------- */
  const APPS = {
    today: { label: "TODAY", ico: "gauge", key: 1, title: "vitals", sub: "system status", geo: [16, 14, 610, 560] },
    tasks: { label: "TASKS", ico: "kanban", key: 2, title: "tasks", sub: "board · detail", geo: [640, 14, 706, 590] },
    runs: { label: "RUNS", ico: "activity", key: 3, title: "runs", sub: "exec monitor", geo: [16, 300, 610, 400] },
    agent: { label: "AGENT", ico: "bot", key: 4, title: "main agent", sub: "global session", geo: [884, 70, 456, 540], global: true },
    inbox: { label: null, ico: "tray", key: 9, title: "inbox", sub: "needs you", geo: [240, 120, 540, 400] },
    insp: { label: null, ico: "diamond", key: 0, title: "inspector", sub: "task detail", geo: [300, 60, 560, 520] },
    sched: { label: "SCHED", ico: "clock", key: 5, title: "scheduler", sub: "cron jobs", geo: [60, 60, 680, 460] },
    wiki: { label: "WIKI", ico: "book", key: 6, title: "wiki", sub: "compiled knowledge", geo: [120, 40, 780, 560] },
    lib: { label: "LIBRARY", ico: "layers", key: 7, title: "library", sub: "skills · agents · packs", geo: [150, 80, 640, 520] },
    sys: { label: "SYSTEM", ico: "sliders", key: 8, title: "system", sub: "preferences", geo: [180, 90, 600, 500] },
  };
  const RAIL_ORDER = ["today", "tasks", "runs", "agent", "sched", "wiki", "lib", "sys"];

  /* ---------------- window manager ---------------- */
  let wins = loadWins();
  function loadWins() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_WINS) || "null");
      if (raw && raw._v === 5) return raw;
    } catch {}
    return defaultWins();
  }
  function defaultWins() {
    const w = {};
    w[SPACES[0].id] = { today: newWin("today", SPACES[0].id), tasks: newWin("tasks", SPACES[0].id), runs: Object.assign(newWin("runs", SPACES[0].id), { min: true }) };
    w["marketing-site"] = { tasks: newWin("tasks", "marketing-site", [30, 30, 640, 460]) };
    w["research-scout"] = { wiki: newWin("wiki", "research-scout", [30, 30, 760, 540]), runs: newWin("runs", "research-scout", [810, 30, 560, 420]) };
    w[GLOBAL] = { agent: newWin("agent", GLOBAL) };
    w._v = 5;
    return w;
  }
  function newWin(app, space, geo, id) {
    const [x, y, w, h] = geo || APPS[app].geo;
    return { id: id || app, app, space, x, y, w, h, min: false, max: false, closed: false, z: 0 };
  }
  function saveWins() { try { localStorage.setItem(LS_WINS, JSON.stringify(wins)); } catch {} }

  let zc = 10; let pts = 1; let focusedW = null;

  function layerFor(w) {
    if (w.space === GLOBAL) return $("#global-layer");
    return $('.space-layer[data-space="' + w.space + '"]');
  }

  function ensureWin(app, space, opts = {}) {
    space = space || settings.space;
    const bucket = wins[space] || (wins[space] = {});
    const id = opts.id || app;
    if (!bucket[id]) bucket[id] = newWin(app, space, opts.geo, id);
    const w = bucket[id];
    w.closed = false;
    if (opts.selectTask) spaceState(w.space).selTask = opts.selectTask;
    if (opts.selRun) spaceState(w.space).selRun = opts.selRun;
    return w;
  }

  function mountWin(w) {
    let el = winEl(w);
    if (!el) {
      el = document.createElement("section");
      el.className = "win";
      el.dataset.id = w.id;
      el.dataset.app = w.app;
      el.dataset.space = w.space;
      el.dataset.tty = "pts/" + (pts++ % 10);
      el.innerHTML =
        '<header class="win-head">' +
        '<span class="win-flag">' + ico(appDef(w).ico || "diamond") + '</span>' +
        '<span class="win-title"></span><span class="win-sub"></span>' +
        '<span class="win-tty"></span>' +
        '<div class="win-btns">' +
        '<button class="win-btn" data-action="w-min" data-space="' + w.space + '" data-id="' + w.id + '" title="minimize → shelf"><svg class="ico" viewBox="0 0 24 24"><use href="#i-minus"/></svg></button>' +
        '<button class="win-btn" data-action="w-max" data-space="' + w.space + '" data-id="' + w.id + '" title="maximize"><svg class="ico" viewBox="0 0 24 24"><use href="#i-square"/></svg></button>' +
        '<button class="win-btn wb-close" data-action="w-close" data-space="' + w.space + '" data-id="' + w.id + '" title="close (view only — data survives)"><svg class="ico" viewBox="0 0 24 24"><use href="#i-x"/></svg></button>' +
        '</div></header><div class="win-body"></div><div class="win-resize" data-action="w-resize"></div>';
      layerFor(w).appendChild(el);
      wireWinChrome(el, w);
    }
    el.dataset.id = w.id; el.dataset.app = w.app; el.dataset.space = w.space;
    refreshWin(w, el);
    placeWin(w, el);
    el.classList.toggle("is-min", !!w.min);
    el.classList.toggle("is-closed", !!w.closed);
    return el;
  }

  function winAppId(w) { return w.app; }
  function winEl(w) { return w ? layerFor(w).querySelector('.win[data-id="' + w.id + '"]') : null; }
  function findWin(id, space) {
    if (space) return wins[space]?.[id] || null;
    for (const k of Object.keys(wins)) if (wins[k]?.[id]) return wins[k][id];
    return null;
  }

  function refreshWin(w, el) {
    el = el || winEl(w);
    if (!el) return;
    const def = appDef(w);
    let title = def.title, sub = def.sub;
    if (w.app === "insp") { const t = findTask(w.space, w.id.split(":")[1]); if (t) { title = "insp::" + t.id; sub = t.title; } }
    el.querySelector(".win-title").textContent = title;
    el.querySelector(".win-sub").textContent = " @ " + (w.space === GLOBAL ? "nexus" : w.space) + " — " + sub;
    el.querySelector(".win-tty").textContent = (w.space === GLOBAL ? "pts/0 · GLOBAL" : "pts/" + (parseInt(el.dataset.tty.split("/")[1]) || 1));
    el.querySelector(".win-body").innerHTML = RENDER[w.app] ? RENDER[w.app](w) : "";
    el.classList.toggle("is-max", !!w.max);
    if (w.app === "agent") wireAgent(el, w);
  }

  function appDef(w) {
    const a = winAppId(w);
    return APPS[a] || { title: a, sub: "" };
  }

  function placeWin(w, el) {
    el = el || winEl(w);
    const d = $("#desktop").getBoundingClientRect();
    w.x = clamp(w.x, 0, Math.max(0, d.width - 200));
    w.y = clamp(w.y, 0, Math.max(0, d.height - 80));
    w.w = clamp(w.w, 260, d.width - w.x);
    w.h = clamp(w.h, 140, d.height - w.y);
    if (w.max) { el.style.left = el.style.top = "0"; el.style.width = "100%"; el.style.height = "100%"; }
    else { el.style.left = w.x + "px"; el.style.top = w.y + "px"; el.style.width = w.w + "px"; el.style.height = w.h + "px"; }
  }

  function focusWin(w, silent) {
    const el = winEl(w);
    if (!el) return;
    w.min = false; el.classList.remove("is-min");
    el.style.zIndex = ++zc;
    $$(".win.is-focus").forEach((o) => o.classList.remove("is-focus"));
    el.classList.add("is-focus");
    focusedW = w;
    if (!silent) { el.classList.remove("just-glitched"); void el.offsetWidth; el.classList.add("just-glitched"); }
    updateRail(); updateShelf(); saveWins();
  }

  function openApp(app, opts = {}) {
    const space = app === "agent" ? GLOBAL : (opts.space || settings.space);
    const w = ensureWin(app, space, opts);
    const el = mountWin(w);
    focusWin(w);
    if (opts.glitch === false) el.classList.remove("just-glitched");
    if (app === "tasks") spaceState(space).boardDirty = true;
    updateRail(); updateShelf(); updateHud(); saveWins();
    return w;
  }

  function allWins(spaceOnly) {
    const out = [];
    const keys = spaceOnly ? [settings.space] : Object.keys(wins).filter((k) => k !== "_v");
    keys.forEach((k) => Object.values(wins[k]).forEach((w) => { if (w.id !== "_v") out.push(w); }));
    return out;
  }

  function minWin(w) { w.min = true; const el = winEl(w); if (el) el.classList.add("is-min"); if (focusedW === w) focusedW = null; updateShelf(); updateRail(); saveWins(); }
  function restoreWin(w) { mountWin(w); focusWin(w); }
  function closeWin(w) {
    w.closed = true; w.min = false;
    const el = winEl(w); if (el) { el.classList.add("is-closed"); el.classList.remove("is-min"); }
    if (focusedW === w) focusedW = null; updateShelf(); updateRail(); updateHud(); saveWins();
  }
  function toggleMax(w) {
    w.max = !w.max;
    const el = winEl(w);
    if (el) el.classList.toggle("is-max", w.max);
    placeWin(w, el); saveWins();
  }

  /* drag / resize / snap */
  const SNAP = { left: [0, 0, .5, 1], right: [.5, 0, .5, 1], top: [0, 0, 1, 1], tl: [0, 0, .5, .5], tr: [.5, 0, .5, .5] };
  function wireWinChrome(el, w) {
    const head = el.querySelector(".win-head");
    let st = null;
    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".win-btn")) return;
      focusWin(w);
      if (w.max) return;
      st = { ox: e.clientX - w.x, oy: e.clientY - w.y, moved: false };
      const d = $("#desktop").getBoundingClientRect();
      const sp = $("#snap-preview");
      const onMove = (ev) => {
        st.moved = true;
        w.x = clamp(ev.clientX - st.ox, -d.width * .25, d.width - 80);
        w.y = clamp(ev.clientY - st.oy, 0, d.height - 40);
        placeWin(w, el);
        const dx = ev.clientX - d.left, dy = ev.clientY - d.top;
        let kind = null;
        if (dy < 20) kind = dx < d.width * .3 ? "tl" : dx > d.width * .7 ? "tr" : "top";
        else if (dx < 28) kind = "left";
        else if (d.right - ev.clientX < 28) kind = "right";
        sp.dataset.kind = kind || "";
        if (kind) {
          const [rx, ry, rw, rh] = SNAP[kind];
          sp.hidden = false;
          sp.style.left = rx * d.width + "px"; sp.style.top = ry * d.height + "px";
          sp.style.width = rw * d.width + "px"; sp.style.height = rh * d.height + "px";
        } else sp.hidden = true;
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        sp.hidden = true;
        const kind = sp.dataset.kind;
        sp.dataset.kind = "";
        if (!st.moved || !kind) return;
        const [rx, ry, rw, rh] = SNAP[kind];
        w.x = rx * d.width; w.y = ry * d.height; w.w = Math.round(rw * d.width); w.h = Math.round(rh * d.height);
        if (kind === "top") w.max = true;
        placeWin(w, el); saveWins();
        toast("snapped ▸ " + kind.toUpperCase());
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    head.addEventListener("dblclick", (e) => { if (!e.target.closest(".win-btn")) toggleMax(w); });

    const rz = el.querySelector(".win-resize");
    rz.addEventListener("pointerdown", (e) => {
      e.preventDefault(); focusWin(w);
      const d = $("#desktop").getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY, sw = w.w, sh = w.h;
      const onMove = (ev) => {
        if (w.max) return;
        w.w = clamp(sw + ev.clientX - sx, 260, d.width - w.x);
        w.h = clamp(sh + ev.clientY - sy, 140, d.height - w.y);
        placeWin(w, el);
      };
      const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); saveWins(); };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    el.addEventListener("pointerdown", () => { if (focusedW !== w) focusWin(w); });
  }

  function tile() {
    const ws = allWins(true).filter((w) => !w.closed && !w.min);
    const d = $("#desktop").getBoundingClientRect();
    const n = ws.length; if (!n) return;
    const cols = n <= 2 ? n : n <= 4 ? 2 : 3;
    const rows = Math.ceil(n / cols);
    ws.forEach((w, i) => {
      w.max = false;
      const c = i % cols, r = Math.floor(i / cols);
      w.x = Math.round(c * d.width / cols) + 6; w.y = Math.round(r * d.height / rows) + 6;
      w.w = Math.round(d.width / cols) - 12; w.h = Math.round(d.height / rows) - 12;
      placeWin(w);
    });
    saveWins(); toast("tile(" + n + ") — grid " + cols + "×" + rows);
  }
  function cascade() {
    const ws = allWins(true).filter((w) => !w.closed && !w.min);
    ws.forEach((w, i) => {
      w.max = false;
      w.x = 24 + i * 46; w.y = 18 + i * 42;
      w.w = Math.max(420, Math.round($("#desktop").clientWidth * .62));
      w.h = Math.max(300, Math.round($("#desktop").clientHeight * .78));
      placeWin(w);
    });
    saveWins(); toast("cascade(" + ws.length + ")");
  }

  /* ---------------- renderers ---------------- */
  function findTask(space, id) { return (DATA[space]?.tasks || DATA[settings.space].tasks).find((t) => t.id === id); }
  function runsOf(space) { return DATA[space]?.runs || []; }
  function needsYouCount() { return wins && (ALERTS.length); }

  function spark(vals, w = 64, h = 22) {
    const max = Math.max(...vals), min = Math.min(...vals);
    const pts = vals.map((v, i) => ((i / (vals.length - 1)) * w).toFixed(1) + "," + (h - ((v - min) / (max - min || 1)) * (h - 3) - 1.5).toFixed(1)).join(" ");
    return '<svg class="spark" width="' + w + '" height="' + h + '"><polyline points="' + pts + '"/></svg>';
  }
  function bar(p, kind) {
    return '<div class="bar ' + (kind ? "b-" + kind : "") + '"><i style="width:' + p + '%"></i></div>';
  }
  const STATE_GLYPH = { run: ['live', "RUN"], wait: ['warn', "WAIT"], done: ['', "DONE"], queue: ['info', "QUEUE"] };

  function inspHtml(t, space) {
    const glyph = { done: "✓", run: "●", next: "○" };
    const colPill = { queued: "p-dim", executing: "p-info", verify: "p-warn", done: "" }[t.column] || "";
    return '' +
      '<div class="insp-head"><div class="i-top"><span class="t-id">#' + t.id + '</span><span class="pill ' + colPill + '">' + t.column.toUpperCase() + '</span>' +
        '<button class="i-close" data-action="task-sel" data-space="' + space + '" data-id="' + t.id + '" title="close detail">' + ico("x") + '</button></div>' +
      '<div class="i-name">' + esc(t.title) + '</div>' +
      '<div class="i-desc">' + esc(t.desc) + '</div>' +
      '<div class="insp-acts">' +
      (t.column !== "done" ? '<button class="cmd cmd-hot" data-action="insp-run" data-space="' + space + '" data-id="' + t.id + '">' + ico("play") + " Run</button>" : "") +
      (t.column === "verify" ? '<button class="cmd cmd-warn" data-action="insp-approve" data-space="' + space + '" data-id="' + t.id + '">Approve</button>' +
        '<button class="cmd cmd-danger" data-action="insp-reject" data-space="' + space + '" data-id="' + t.id + '">Reject</button>' : "") +
      '<button class="cmd cmd-ghost" data-action="open-app" data-app="wiki">Spec</button>' +
      '</div></div>' +
      '<div class="insp-sect"><div class="sect-h"><h3>Phases</h3><span class="grow"></span></div>' +
      (t.phases || []).map((p) => '<div class="phase ' + (p.s === "done" ? "d" : p.s === "run" ? "r" : "") + '"><span class="p-glyph">' + (glyph[p.s] || "○") + '</span><span>' + esc(p.t) + '</span><span class="p-meta">' + esc(p.m) + '</span></div>').join("") + '</div>' +
      '<div class="insp-sect"><div class="sect-h"><h3>Acceptance</h3><span class="grow"></span><span class="cap">' + (t.checks || []).filter((c) => c.ok).length + "/" + (t.checks || []).length + '</span></div>' +
      (t.checks || []).map((c) => '<div class="check ' + (c.ok ? "yes" : "no") + '"><span class="c-box">' + (c.ok ? "✓" : "○") + '</span><span>' + esc(c.l) + '</span></div>').join("") +
      '<div class="acc-note">' + esc(t.acc) + '</div></div>';
  }

  const RENDER = {
    today(w) {
      const st = DATA[w.space]; const s = spaceState(w.space);
      const running = st.runs.filter((r) => r.state === "run").length;
      const now = st.runs.filter((r) => r.state === "run" || r.state === "wait");
      return '' +
        '<div class="today-head">' +
        '<div class="today-status"><span class="dot live"></span><span class="big">SYSTEM NOMINAL</span>' +
        '<span class="q">uptime 3d 04:11 · space ' + esc(w.space) + ' · ' + st.tasks.length + ' tasks</span></div></div>' +
        '<div class="stat4">' +
        '<div class="stat"><div class="s-lab">RUNNING</div><div class="s-val">' + running + '</div><div class="s-note">live processes</div>' + spark([2, 3, 2, 4, 3, 5, running], 56, 20) + '</div>' +
        '<div class="stat"><div class="s-lab">NEEDS-YOU</div><div class="s-val">' + ALERTS.length + '</div><div class="s-note">awaiting human</div>' + spark([1, 2, 3, 2, 2, 1, ALERTS.length], 56, 20) + '</div>' +
        '<div class="stat"><div class="s-lab">PASS · 7D</div><div class="s-val">96.4<small>%</small></div><div class="s-note"><span class="up">↑1.8</span> vs last</div>' + spark([88, 90, 93, 91, 95, 96, 96.4], 56, 20) + '</div>' +
        '<div class="stat"><div class="s-lab">SPEND · TODAY</div><div class="s-val">$42<small>.18</small></div><div class="s-note"><span class="down">↓12%</span> budget 77%</div>' + spark([30, 55, 48, 62, 51, 46, 42], 56, 20) + '</div>' +
        '</div>' +
        '<div class="sect"><div class="sect-h"><h3>NOW</h3><span class="grow"></span><span class="cap">' + now.length + ' procs</span></div>' +
        now.map((r) =>
          '<div class="now-item" data-action="run-focus" data-space="' + w.space + '" data-rid="' + r.id + '">' +
          '<span class="n-id">' + r.id + '</span>' +
          '<span class="dot ' + (STATE_GLYPH[r.state][0]) + '"></span>' +
          '<div style="flex:1;min-width:0"><span class="n-name">' + esc(r.name) + '</span>' +
          '<div class="n-meta">' + r.state.toUpperCase() + ' · node ' + r.nodes.filter((n) => n.s === "d").length + '/' + r.nodes.length + ' · ' + esc(r.task) + '</div></div>' +
          bar(r.progress, r.state === "wait" ? "warn" : "") +
          '<span class="n-num mono-num">' + esc(r.el) + '</span></div>').join("") +
        '</div>' +
        '<div class="sect"><div class="sect-h"><h3>NEEDS YOU</h3><span class="grow"></span></div>' +
        ALERTS.slice(0, 3).map((a) =>
          '<div class="att-item"><span class="a-ico">' + (a.kind === "shield" ? ico("shield") : a.kind === "msg" ? ico("msg") : ico("retry")) + '</span>' +
          '<div class="a-main"><b>' + esc(a.t) + '</b><span>' + esc(a.s) + '</span></div>' +
          '<button class="cmd cmd-warn" data-action="alert-jump">' + esc(a.a) + '</button></div>').join("") +
        '</div>' +
        '<div class="sect"><div class="sect-h"><h3>EVENT FEED</h3><span class="grow"></span><span class="cap">live tail</span></div></div>' +
        '<div class="feed" id="feed"></div>';
    },

    tasks(w) {
      const st = DATA[w.space]; const s = spaceState(w.space);
      const lanes = [["queued", "Queued"], ["executing", "Executing"], ["verify", "Verify"], ["done", "Done"]];
      const board = lanes.map(([col, lab]) => {
        const ts = st.tasks.filter((t) => t.column === col);
        return '<div class="lane"><div class="lane-head"><span class="dot ' + (col === "executing" ? "live" : col === "verify" ? "warn" : "") + '"></span>' + lab + '<span class="lc mono-num">' + ts.length + '</span></div>' +
          '<div class="lane-body">' + (ts.length ? ts.map((t) =>
            '<div class="task ' + (s.selTask === t.id ? "is-sel" : "") + (t.column === "verify" ? " st-warn" : t.column === "done" ? " st-danger" : "") + '" data-action="task-sel" data-space="' + w.space + '" data-id="' + t.id + '">' +
            '<div class="t-id">#' + t.id + '</div><div class="t-name">' + esc(t.title) + '</div>' +
            '<div class="t-meta">' + esc(t.meta) + '</div>' +
            '<div class="t-tags">' + t.labels.map((l) => '<span class="tag">' + esc(l) + '</span>').join("") + '</div>' +
            '<div class="t-foot">' + bar(t.progress) + '<span class="t-pct">' + t.progress + '%</span></div>' +
            '</div>').join("") : '<div class="lane-empty">empty</div>') +
          '</div></div>';
      }).join("");
      const t = s.selTask ? findTask(w.space, s.selTask) : null;
      return '<div class="tasks-split"><div class="board">' + board + '</div>' +
        '<aside class="tasks-detail' + (t ? " is-on" : "") + '">' + (t ? inspHtml(t, w.space) : "") + '</aside></div>';
    },

    insp(w) {
      const t = findTask(w.space, w.id.split(":")[1]);
      return t ? inspHtml(t, w.space) : '<div class="feed"><div class="f-line">task gone</div></div>';
    },

    runs(w) {
      const st = DATA[w.space]; const s = spaceState(w.space);
      if (!st.runs.find((r) => r.id === s.selRun)) s.selRun = st.runs[0]?.id;
      const r = st.runs.find((x) => x.id === s.selRun);
      const list = '<div class="runs-list">' + st.runs.map((x) =>
        '<div class="trow ' + (x.id === s.selRun ? "is-sel" : "") + '" data-action="run-sel" data-space="' + w.space + '" data-rid="' + x.id + '">' +
        '<span class="dot ' + STATE_GLYPH[x.state][0] + '"></span>' +
        '<div style="flex:1;min-width:0"><b style="font-size:11px">' + esc(x.name) + '</b>' +
        '<div style="font-size:9.5px;color:var(--ph-dim)">' + x.id + ' · ' + STATE_GLYPH[x.state][1] + ' · ' + esc(x.cost) + ' · ' + esc(x.el) + '</div></div></div>').join("") + '</div>';
      if (!r) return '<div class="runs-wrap">' + list + '<div class="run-main"></div></div>';
      const tabs = [["graph", "GRAPH"], ["logs", "LOGS"], ["cost", "COST"]];
      const glyph = { d: "◉", r: "◐", w: "◑", f: "◍", "": "○" };
      const graph = '<div class="rp ' + (s.runTab === "graph" ? "is-on" : "") + '" data-rp="graph"><div class="gflow">' +
        r.nodes.map((n, i) => (i ? '<span class="garrow">─▸</span>' : "") + '<div class="gnode ' + n.s + '"><span class="gn-kind">' + n.k + '</span><span class="gn-name">' + glyph[n.s] + " " + esc(n.n) + '</span></div>').join("") +
        '</div>' + '<div class="logbox"><div class="ll l-sys"><span class="lt">' + r.el + '</span>progress</div></div><div style="padding:0 14px 14px">' + bar(r.progress) + '</div></div>';
      const logs = '<div class="rp ' + (s.runTab === "logs" ? "is-on" : "") + '" data-rp="logs"><div class="logbox" data-logbox>' +
        r.logs.map((l) => '<div class="ll l-' + l.l + '"><span class="lt">' + l.t + '</span>' + esc(l.m) + '</div>').join("") +
        (r.state === "run" ? '<div class="ll"><span class="cur">▊</span></div>' : "") +
        '</div></div>';
      const cost = '<div class="rp ' + (s.runTab === "cost" ? "is-on" : "") + '" data-rp="cost"><table class="tb"><tr><th>LEDGER</th><th class="num">IN</th><th class="num">OUT</th><th class="num">CACHE</th><th class="num">COST</th></tr>' +
        '<tr><td>' + esc(r.name) + '</td><td class="num">82k</td><td class="num">' + esc(r.tok) + '</td><td class="num">1.4M</td><td class="num">' + esc(r.cost) + '</td></tr>' +
        '<tr><td>hit-rate <span class="wref">[ADR-0027]</span></td><td class="num">92.0%</td><td class="num">—</td><td class="num">—</td><td class="num">—</td></tr></table></div>';
      const main = '<div class="run-main"><div class="run-tabs">' +
        tabs.map(([k, lab]) => '<button class="run-tab ' + (s.runTab === k ? "is-on" : "") + '" data-action="run-tab" data-tab="' + k + '" data-space="' + w.space + '">' + lab + '</button>').join("") +
        '<span style="margin-left:auto;padding:7px 12px;font-size:9.5px;color:var(--ph-faint)">' + esc(r.name) + '</span></div>' +
        graph + logs + cost + '</div>';
      return '<div class="runs-wrap">' + list + main + '</div>';
    },

    agent(w) {
      const s = spaceState(GLOBAL);
      const msgs = s.chat.map((m) => m.role === "u"
        ? '<div class="msg-u"><span class="u-p">you@nexus:~$</span> <span class="u-t">' + esc(m.t) + '</span></div>'
        : '<div class="msg-a ' + (m.typing ? "typing" : "") + '"><div class="a-time">main ▸ ' + esc(m.time || "") + '</div>' +
        (m.tools || []).map((t) => '<div class="tool"><span class="tl-k">[' + t.k + ']</span><span class="tl-dots">' + esc(t.d) + ' ' + ".".repeat(3) + '</span><span class="tl-ms">' + esc(t.ms) + ' ✓</span></div>').join("") +
        '<p class="a-body">' + (m.typing ? esc(m.text.slice(0, m.shown ?? m.text.length)) : m.text) + '</p></div>').join("");
      return '<div class="chat"><div class="chat-head"><span class="av">AI</span>' +
        '<div style="flex:1"><b>main</b> <span class="pill p-info">opus</span><div class="c-sub">global session · persists across spaces</div></div>' +
        '<span class="win-glob">⌘J</span></div>' +
        '<div class="chat-log" data-chatlog>' + msgs + '</div>' +
        '<div class="composer"><div class="cp-row"><span class="cp-prompt">❯</span>' +
        '<input class="chat-input" placeholder="message main… (⏎ send · /run · @workspace)" />' +
        '<button class="cmd cmd-hot" data-action="agent-send">SEND</button></div>' +
        '<div class="cp-meta"><span>ctx <b>42%</b></span><span>cost <b>$0.31</b></span><span>tok <b>12.4k/s</b></span><span>⏎=send</span></div></div></div>';
    },

    sched(w) {
      return '<div class="sect"><div class="sect-h"><h3>CRON JOBS</h3><span class="grow"></span><span class="cap">' + JOBS.filter((j) => j.on).length + ' armed</span></div></div>' +
        '<table class="tb"><tr><th>JOB</th><th>CRON</th><th>NEXT</th><th>LAST</th><th></th></tr>' +
        JOBS.map((j, i) => '<tr><td class="strong" style="font-weight:600">' + esc(j.name) + '</td>' +
          '<td class="cron">' + j.cron + '</td><td class="mono-num">' + esc(j.next) + '</td>' +
          '<td style="color:' + (j.last.startsWith("fail") ? "var(--danger)" : "var(--ph-dim)") + '">' + esc(j.last) + '</td>' +
          '<td><span class="jstate ' + (j.on ? "on" : "off") + '">' + (j.on ? "● ARMED" : "○ PAUSED") + '</span> <button class="cmd cmd-ghost" data-action="job-toggle" data-i="' + i + '">' + (j.on ? "pause" : "arm") + '</button></td></tr>').join("") +
        '</table>' +
        '<div class="sect"><div class="sect-h"><h3>NEXT-TRIGGER QUEUE</h3><span class="grow"></span></div>' +
        '<div class="feed">' + JOBS.filter((j) => j.on).map((j) => '<div class="f-line"><span class="ft">▸</span>' + esc(j.name) + ' — <span class="tnum">' + esc(j.next) + '</span></div>').join("") +
        '<div class="f-line"><span class="ft">▸</span>⌘ 手动：<code>octopus workflow run nightly.yaml</code> 或控制台 <code>run nightly</code></div></div></div>';
    },

    wiki(w) {
      const s = spaceState(w.space);
      const tree = WIKI.pages.map((d) => '<div class="wt-dir">' + d.dir + '</div>' +
        d.items.map((p) => '<div class="wt-page ' + (p.id === s.wikiPage ? "is-on" : "") + '" data-action="wiki-page" data-page="' + p.id + '">▸ ' + p.t + '</div>').join("")).join("");
      const doc = WIKI.docs[s.wikiPage] || WIKI.docs.win;
      return '<div class="wiki-wrap"><div class="wiki-tree">' + tree + '</div>' +
        '<div class="wiki-doc"><h1>' + esc(doc.title) + '</h1><div class="wd-meta">' + esc(doc.meta) + '</div>' + doc.body +
        '<div class="wd-meta" style="margin-top:18px">↩ octo-wiki 协议：INDEX → 整读页 → search 兜底 · stale 请上报</div></div></div>';
    },

    lib() {
      return '<div class="lib-wrap">' +
        '<div class="sect"><div class="sect-h"><h3>SKILLS</h3><span class="grow"></span><span class="cap">' + RES.skills.length + ' installed · prefix octo-</span></div></div>' +
        RES.skills.map((r) => '<div class="res-row" data-action="res-ins" data-name="' + esc(r.n) + '"><span class="rs-ico">' + ico("package") + '</span>' +
          '<div class="rs-main"><b>' + esc(r.n) + '</b><span>' + esc(r.d) + '</span></div>' +
          '<span class="rs-v">v' + r.v + '</span><span class="pill p-dim">INSTALLED</span></div>').join("") +
        '<div class="sect"><div class="sect-h"><h3>GIT SOURCES</h3><span class="grow"></span></div></div>' +
        RES.sources.map((r) => '<div class="res-row"><span class="rs-ico">' + ico("git") + '</span><div class="rs-main"><b>' + esc(r.n) + '</b><span>' + esc(r.d) + '</span></div>' +
          '<button class="cmd" data-action="res-sync" data-name="' + esc(r.n) + '">sync</button></div>').join("") + '</div>';
    },

    sys() {
      const row = (lab, desc, ctl) => '<div class="sys-row"><div><div class="sr-lab">' + lab + '</div><div class="sr-desc">' + desc + '</div></div>' + ctl + '</div>';
      return '' +
        '<div class="sys-sect"><h4>Appearance</h4>' + row("主题 Theme", "克制中性 · 明暗双版 — 或控制台 <code>theme dark</code>", '<div class="swatch">' + ["light", "dark"].map((p) => '<button class="sw ' + (settings.theme === p ? "is-on" : "") + '" data-set="' + p + '" data-action="theme-set">' + (p === "light" ? "☀ Light" : "☾ Dark") + '</button>').join("") + '</div>') + '</div>' +
        '<div class="sys-sect"><h4>Layout</h4>' +
        row("平铺当前桌面", "⌥T · 所有可见窗口归入网格", '<button class="cmd" data-action="tile">Tile</button>') +
        row("层叠窗口", "Cascade · 依次错位展开", '<button class="cmd" data-action="cascade">Cascade</button>') +
        row("重置窗口几何", "清空 localStorage 布局", '<button class="cmd cmd-danger" data-action="reset-layout">Reset</button>') + '</div>' +
        '<div class="sys-sect"><h4>Keyboard</h4>' +
        row("快捷键总表", "按 ? 随时打开", '<button class="cmd" data-action="help">Show keys</button>') + '</div>' +
        '<div class="sys-sect"><h4>About</h4>' +
        '<div class="about-mono">octopus desktop · prototype v6 — v5 的骨架，安静的皮<br>v1–v5 保留对照 · fake data only<br>db: ~/.octopus/db/octopus.db · server :3001</div></div>';
    },

    inbox() {
      return '<div class="sect"><div class="sect-h"><h3>PARKED DECISIONS</h3><span class="grow"></span><span class="pill p-warn">' + ALERTS.length + ' waiting</span></div></div>' +
        '<div style="padding:0 14px 14px">' + (ALERTS.length ? ALERTS.map((a) =>
          '<div class="att-item"><span class="a-ico">' + (a.kind === "shield" ? ico("shield") : a.kind === "msg" ? ico("msg") : ico("retry")) + '</span>' +
          '<div class="a-main"><b>' + esc(a.t) + '</b><span>' + esc(a.s) + '</span></div>' +
          '<button class="cmd cmd-warn" data-action="alert-act" data-id="' + a.id + '">' + esc(a.a) + '</button>' +
          '<button class="cmd cmd-ghost" data-action="alert-dismiss" data-id="' + a.id + '">skip</button></div>').join("")
          : '<div class="feed"><div class="f-line fk-ok"><span class="ft">✓</span>all clear — nothing awaits a human.</div></div>') + '</div>';
    },
  };
  RENDER["insp"] = RENDER.insp;

  /* ---------------- live intervals ---------------- */
  function clock() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    $("#clock").textContent = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function updateHud() {
    const st = DATA[settings.space];
    const run = st.runs.filter((r) => r.state === "run").length;
    $("#v-runs").innerHTML = ico("activity") + " <b>" + run + "</b> RUN";
    $("#v-alert").innerHTML = ico("alert") + " <b>" + ALERTS.length + "</b> NEEDS-YOU";
    $("#v-alert").classList.toggle("zero", ALERTS.length === 0);
    const cur = SPACES.find((s) => s.id === settings.space) || SPACES[0];
    $("#space-name").textContent = cur.name;
    $("#space-menu").innerHTML = '<div class="menu-cap">WORKSPACES · ⌥←/→</div>' + SPACES.map((s) => {
      const open = Object.values(wins[s.id] || {}).filter((w) => !w.closed).length;
      return '<button class="menu-item ' + (s.id === settings.space ? "is-active" : "") + '" data-action="space" data-id="' + s.id + '"><span class="mi-k">' + (s.id === settings.space ? "✓" : "") + '</span><span class="mi-t">' + esc(s.name) + '</span><span class="mi-meta">' + open + ' procs</span></button>';
    }).join("");
  }

  let tok = 12.4;
  function vitals() {
    tok = clamp(tok + (Math.random() * 4 - 2), 3, 40);
    $("#v-tokens").innerHTML = ico("gauge") + " <b>" + tok.toFixed(1) + "k</b> t/s";
  }

  let feedIdx = 0; let feedSeq = [];
  function pushFeed(force) {
    const feed = $("#feed");
    if (!feed || !force && !feed.isConnected) return;
    const [k, id, msg] = FEED_POOL[feedIdx++ % FEED_POOL.length];
    const d = new Date(); const p = (n) => String(n).padStart(2, "0");
    const line = document.createElement("div");
    line.className = "f-line fk-" + k + " f-new";
    line.innerHTML = '<span class="ft">' + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) + '</span><span class="fk">' + (k === "warn" ? "⚠" : k === "ok" ? "✓" : k === "ask" ? "?" : "▸") + '</span><b>' + id + '</b> ' + esc(msg);
    feed.prepend(line);
    while (feed.children.length > 7) feed.lastChild.remove();
    updateHud();
  }

  function streamLogs() {
    $$('[data-logbox]').forEach((box) => {
      const win = box.closest(".win"); if (!win || win.classList.contains("is-min") || win.classList.contains("is-closed")) return;
      const layer = win.closest('.space-layer:not([hidden]), .global-layer'); if (!layer) return;
      const s = spaceState(settings.space);
      const r = runsOf(settings.space).find((x) => x.id === s.selRun);
      if (!r || r.state !== "run") return;
      const [l, m] = LOG_POOL[Math.floor(Math.random() * LOG_POOL.length)];
      const d = new Date(); const p = (n) => String(n).padStart(2, "0");
      const time = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
      r.logs.push({ l, t: time, m });
      const cur = box.querySelector(".ll:last-child .cur")?.closest(".ll");
      const line = document.createElement("div");
      line.className = "ll l-" + l;
      line.innerHTML = '<span class="lt">' + time + '</span>' + esc(m);
      if (cur) box.insertBefore(line, cur); else box.appendChild(line);
      box.scrollTop = box.scrollHeight;
      r.progress = clamp(r.progress + Math.round(Math.random() * 3), 0, 99);
      const g = win.querySelector('[data-rp="graph"] .bar i'); if (g) g.style.width = r.progress + "%";
    });
  }

  /* ---------------- agent typing ---------------- */
  function agentSend(text, w) {
    w = w || wins[GLOBAL]?.agent;
    const s = spaceState(GLOBAL);
    s.chat.push({ role: "u", t: text, time: "now" });
    s.chat.push({ role: "a", text: "", shown: 0, typing: true, time: "processing ▊" });
    refreshWin(w);
    const full = REPLIES[Math.floor(Math.random() * REPLIES.length)];
    const msg = s.chat[s.chat.length - 1];
    setTimeout(() => {
      msg.text = full; msg.typing = false; msg.time = "main ▸ ok";
      const el = winEl(w);
      if (!el) { refreshWin(w); return; }
      const body = msg; let i = 0;
      const tick = () => {
        i += 3; msg.shown = i;
        refreshWin(w);
        const log = el.querySelector("[data-chatlog]"); if (log) log.scrollTop = log.scrollHeight;
        if (i < full.length) setTimeout(tick, 18); else { msg.shown = undefined; refreshWin(w); }
      };
      tick();
    }, 650);
  }

  function wireAgent(el, w) {
    const input = el.querySelector(".chat-input");
    if (!input || input.dataset.wired) return;
    input.dataset.wired = "1";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) { agentSend(input.value.trim()); e.preventDefault(); }
    });
    const log = el.querySelector("[data-chatlog]"); if (log) log.scrollTop = log.scrollHeight;
  }

  /* ---------------- rail / shelf / spaces ---------------- */
  function updateRail() {
    const runLive = DATA[settings.space].runs.some((r) => r.state === "run");
    $("#rail").innerHTML = '<div class="rail-cap">QUICKJUMP</div>' +
      RAIL_ORDER.map((a) => {
        const app = APPS[a];
        const open = Object.values(wins[a === "agent" ? GLOBAL : settings.space] || {}).some((w) => w.app === a && !w.closed);
        const foc = focusedW && focusedW.app === a && focusedW.space === (a === "agent" ? GLOBAL : settings.space);
        return '<button class="rail-btn ' + (foc ? "is-on" : "") + '" data-action="open-app" data-app="' + a + '" title="' + app.label + ' · ⌥' + app.key + '">' +
          '<span class="r-key">' + app.key + '</span><span class="r-ico">' + ico(app.ico) + '</span><span class="r-lab">' + app.label + '</span>' +
          (a === "inbox" && ALERTS.length ? '<span class="r-badge">' + ALERTS.length + '</span>' : "") +
          (a === "runs" && runLive ? '<span class="r-live"></span>' : "") +
          (open && a !== "runs" && !foc ? '<span class="r-live" style="animation:none;background:var(--ph-faint)"></span>' : "") +
          '</button>';
      }).join("");
  }

  function updateShelf() {
    const mins = allWins().filter((w) => !w.closed && w.min);
    $("#shelf").innerHTML = mins.map((w) =>
      '<button class="shelf-chip" data-action="shelf-restore" data-space="' + w.space + '" data-id="' + w.id + '" title="restore"><span>◢</span><span class="sc-t">' + (APPS[winAppId(w)]?.label || w.app) + ' · ' + esc(w.id) + '</span></button>').join("") +
      (mins.length ? '<span class="rail-sep" style="margin:0 6px"></span>' : "");
  }

  function switchSpace(id) {
    if (!DATA[id]) return;
    settings.space = id; saveSettings();
    $$(".space-layer").forEach((l) => { l.hidden = l.dataset.space !== id; });
    updateRail(); updateHud(); updateShelf();
    toast("space → " + id + " ▮ " + Object.values(wins[id] || {}).filter((w) => !w.closed).length + " procs live");
    focusedW = null;
  }

  /* ---------------- console ---------------- */
  const $con = () => $("#console");
  let histIdx = -1;

  function outEcho(cmd, res, err) {
    const box = $("#console-out");
    const c = document.createElement("div"); c.className = "co-cmd"; c.textContent = cmd;
    const r = document.createElement("div"); r.className = err ? "co-err" : "co-res"; r.textContent = res;
    box.appendChild(c); box.appendChild(r);
    while (box.children.length > 80) { box.firstChild.remove(); box.firstChild.remove(); }
    // scrollback 只在「内容是负载」时展开：多行 / 错误 / 用户已手动打开；否则 toast 一行即可
    if (err || res.includes("\n") || !box.hidden) {
      box.hidden = false;
      $("#con-toggle").classList.add("is-on");
      box.scrollTop = box.scrollHeight;
    } else {
      toast(res.length > 64 ? res.slice(0, 62) + "…" : res);
    }
  }

  function runCmd(raw) {
    const cmd = raw.trim();
    if (!cmd) return;
    settings.hist.unshift(cmd); settings.hist = settings.hist.slice(0, 40); saveSettings();
    histIdx = -1;
    const [op, ...rest] = cmd.split(" ");
    const arg = rest.join(" ");
    const low = op.toLowerCase();
    const st = () => DATA[settings.space];

    if (low === "help") outEcho(cmd, "new <标题>      建任务(queued)\nrun <query>       把匹配任务推入 EXECUTING 并打开 RUNS\nask <文本>        问 main agent\nopen <app>        tasks|runs|agent|wiki|sched|lib|sys|inbox|today\ngoto <space>      切换项目桌面\ntile | cascade | mission | close <app> | reset\ntheme light|dark · clear\n⌥1-8 rail · ⌘K palette · ⌘J agent · ⌘⇧M mission");
    else if (low === "clear") { $("#console-out").hidden = true; $("#con-toggle").classList.remove("is-on"); $("#console-out").innerHTML = ""; }
    else if (low === "new") {
      const t = { id: "T-" + String(st().tasks.length + 1).padStart(2, "0"), title: arg || "untitled", desc: "console-created", column: "queued", progress: 0, meta: "from console · " + settings.space, labels: ["console"], phases: [{ t: "queue", m: "not started", s: "next" }], checks: [{ l: "acceptance", ok: false }], acc: "未开始." };
      st().tasks.unshift(t);
      openApp("tasks"); refreshWin(wins[settings.space].tasks);
      outEcho(cmd, "task " + t.id + " queued → " + (arg || "untitled"));
      toast("task " + t.id + " queued");
    }
    else if (low === "run") {
      const q = arg.toLowerCase();
      const t = st().tasks.find((x) => x.title.toLowerCase().includes(q) || x.id.toLowerCase() === q) || st().tasks.find((x) => x.column === "queued");
      if (!t) return outEcho(cmd, "no matching task", true);
      t.column = "executing"; t.progress = Math.max(t.progress, 5);
      const r = st().runs.find((x) => x.task === t.id);
      if (r) { r.state = "run"; r.progress = 5; }
      openApp("runs", { selRun: r?.id }); openApp("tasks"); refreshWin(wins[settings.space].tasks); refreshWin(wins[settings.space].runs);
      outEcho(cmd, "▸ spawned run for " + t.id + " — " + t.title);
      toast("run armed · " + t.id);
    }
    else if (low === "ask") { openApp("agent"); agentSend(arg); outEcho(cmd, "→ main is answering (⌘J)"); }
    else if (low === "open") { if (APPS[arg]) { openApp(arg); outEcho(cmd, arg + " online"); } else outEcho(cmd, "unknown app: " + arg, true); }
    else if (low === "close") { const w = wins[arg === "agent" ? GLOBAL : settings.space]?.[arg]; if (w) { closeWin(w); outEcho(cmd, arg + " closed (view released, data alive)"); } else outEcho(cmd, "not open: " + arg, true); }
    else if (low === "goto") { const s = SPACES.find((x) => x.id.includes(arg.toLowerCase())); if (s) { switchSpace(s.id); outEcho(cmd, "space → " + s.name); } else outEcho(cmd, "no space: " + arg, true); }
    else if (low === "tile") { tile(); }
    else if (low === "cascade") { cascade(); }
    else if (low === "mission") { openMission(); }
    else if (low === "theme") { if (["light", "dark"].includes(arg)) { settings.theme = arg; applySettings(); updateHud(); rerenderApp("sys"); outEcho(cmd, "theme → " + arg); } else outEcho(cmd, "theme: light|dark", true); }
    else if (low === "reset") { localStorage.removeItem(LS_WINS); wins = loadWins(); mountAll(); outEcho(cmd, "layout reset to defaults"); toast("layout reset"); }
    else outEcho(cmd, "unknown: '" + op + "' — type 'help'. 提示: 任何自然语言可用 'ask ' 前缀。", true);
  }

  function mountAll() {
    $$(".win").forEach((el) => el.remove());
    Object.keys(wins).filter((k) => k !== "_v").forEach((k) => Object.values(wins[k]).forEach((w) => mountWin(w)));
    updateRail(); updateHud(); updateShelf();
  }

  /* ---------------- palette ---------------- */
  function paletteItems(q) {
    const items = [];
    const ql = q.toLowerCase();
    const match = (s) => !q || String(s).toLowerCase().includes(ql);
    RAIL_ORDER.forEach((a) => { if (match(a) || match(APPS[a].label)) items.push({ g: "APPS", k: "⌥" + APPS[a].key, t: "open " + APPS[a].label.toLowerCase(), meta: APPS[a].title, run: () => openApp(a) }); });
    allWins().filter((w) => !w.closed).forEach((w) => { if (match(w.id)) items.push({ g: "WINDOWS", k: "▣", t: w.id, meta: w.space, run: () => { if (w.space !== settings.space) switchSpace(w.space); restoreWin(w); focusWin(w); } }); });
    (DATA[settings.space].tasks || []).forEach((t) => { if (match(t.title) || match(t.id)) items.push({ g: "TASKS", k: "◈", t: t.id + " · " + t.title, meta: t.column, run: () => { spaceState(settings.space).selTask = t.id; openApp("tasks"); refreshWin(wins[settings.space].tasks); } }); });
    DATA[settings.space].runs.forEach((r) => { if (match(r.name)) items.push({ g: "RUNS", k: "▸", t: r.name, meta: r.state, run: () => openApp("runs", { selRun: r.id }) }); });
    SPACES.forEach((s) => { if (match(s.name)) items.push({ g: "SPACES", k: "◧", t: "goto " + s.name, meta: "space", run: () => switchSpace(s.id) }); });
    [["tile", "⌥T"], ["cascade", ""], ["mission", "⌘⇧M"], ["theme amber", ""], ["rain off", ""], ["help", "?"]].forEach(([c, k]) => { if (match(c)) items.push({ g: "COMMANDS", k: "$", t: c, meta: k, run: () => runCmd(c) }); });
    if (q && !q.startsWith("/")) items.push({ g: "ASK MAIN", k: "✳", t: 'ask: "' + q + '"', meta: "→ agent", run: () => { openApp("agent"); agentSend(q); } });
    return items.slice(0, 40);
  }

  let palSel = 0; let palCur = [];
  function renderPalette() {
    const q = $("#palette-input").value.trim();
    palCur = paletteItems(q);
    palSel = clamp(palSel, 0, Math.max(0, palCur.length - 1));
    let html = ""; let g = "";
    palCur.forEach((it, i) => {
      if (it.g !== g) { g = it.g; html += '<div class="pal-group">' + g + "</div>"; }
      html += '<div class="pal-item ' + (i === palSel ? "is-sel" : "") + '" data-pi="' + i + '"><span class="pi-k">' + it.k + '</span><span class="pi-t">' + esc(it.t) + '</span><span class="pi-meta">' + esc(it.meta) + "</span></div>";
    });
    $("#palette-list").innerHTML = html || '<div class="pal-group">NO MATCH</div>';
  }
  function openPalette() { showOverlay("palette"); const i = $("#palette-input"); i.value = ""; palSel = 0; renderPalette(); setTimeout(() => i.focus(), 10); }
  function paletteEnter() { const it = palCur[palSel]; if (!it) return; closeOverlay("palette"); it.run(); }

  /* ---------------- mission / overlays / help ---------------- */
  function openMission() {
    const ws = allWins().filter((w) => !w.closed);
    $("#mission-grid").innerHTML = ws.map((w) => {
      const app = winAppId(w);
      let state = "";
      if (w.app === "insp") { const t = findTask(w.space, w.id.split(":")[1]); state = t ? t.column : "gone"; }
      return '<div class="proc ' + (w.app === "agent" ? "ps-live" : state === "verify" ? "ps-warn" : "") + '" data-tty="' + (w.space === GLOBAL ? "pts/0" : "pts/x") + '" data-action="proc-focus" data-space="' + w.space + '" data-id="' + w.id + '">' +
        '<div class="p-state"></div>' +
        '<div class="p-name">' + esc((APPS[app]?.label || "INSP")) + ' ▸ ' + esc(w.id) + '</div>' +
        '<div class="p-sub">' + (w.space === GLOBAL ? "global" : w.space) + ' · ' + Math.round(w.w) + "×" + Math.round(w.h) + (w.max ? " ·MAX" : "") + (w.min ? " ·MIN" : "") + "</div>" +
        '<div class="p-lines">' + mockLines(w) + "</div></div>";
    }).join("");
    showOverlay("mission");
  }
  function mockLines(w) {
    const s = DATA[w.space] || DATA[settings.space];
    if (w.app === "tasks") return s.tasks.slice(0, 3).map((t) => '<span class="pl">▸ ' + esc(t.title) + " — " + t.progress + "%</span>").join("");
    if (w.app === "runs") return s.runs.slice(0, 3).map((r) => '<span class="pl">▸ ' + esc(r.name) + " · " + r.state.toUpperCase() + "</span>").join("");
    if (w.app === "today") return '<span class="pl">▸ SYSTEM NOMINAL · ' + ALERTS.length + ' needs-you</span><span class="pl">▸ uptime 3d 04:11</span>';
    if (w.app === "agent") return '<span class="pl">▸ ❯ 重新设计整个界面…</span><span class="pl">▸ main: 没有页面，只有窗口</span>';
    if (w.app === "wiki") return '<span class="pl">▸ window-model · 214 sources</span>';
    if (w.app === "insp") return '<span class="pl">▸ ' + esc(w.id) + "</span>";
    return '<span class="pl">▸ ' + esc(w.id) + " — alive</span>";
  }

  function showOverlay(id) {
    $$(".overlay").forEach((o) => { if (o.id !== id) o.hidden = true; });
    $("#" + id).hidden = false;
  }
  function closeOverlay(id) { $("#" + id).hidden = true; if ($("#" + id).contains(document.activeElement)) document.activeElement.blur(); }
  const overlayOpen = () => $$(".overlay").find((o) => !o.hidden)?.id;

  const HELP_ROWS = [
    ["⌥1 … ⌥8", "rail 直达：TODAY/TASKS/RUNS/AGENT/SCHED/WIKI/LIB/SYSTEM"],
    ["`", "聚焦底部控制台（命令行）"],
    ["⌘K / Ctrl+K", "命令面板 · 输入即问 main"],
    ["⌘J / Ctrl+J", "打开全局主 Agent"],
    ["⌘⇧M / Ctrl+Shift+M", "Mission Control（全部窗口）"],
    ["⌥T", "平铺当前 space 窗口"],
    ["⌥← / ⌥→", "切换 Space（项目桌面）"],
    ["⌘W / Ctrl+W", "关闭聚焦窗口（≠ 取消任务）"],
    ["⌘M / Ctrl+M", "最小化聚焦窗口到 shelf"],
    ["拖到左/右/上缘", "吸附半屏 / 半屏×半 / 最大化"],
    ["双击标题栏", "最大化 ⇄ 还原"],
    ["?", "本表"],
    ["esc", "关闭浮层 / 控制台回显"],
    ["theme light|dark", "控制台切换主题 · 右上角 ☀/☾ 等价"],
  ];
  function openHelp() {
    $("#help-grid").innerHTML = HELP_ROWS.map(([k, d]) => '<div class="help-row"><span class="hk"><kbd>' + esc(k) + '</kbd></span><span class="hd">' + esc(d) + "</span></div>").join("");
    showOverlay("help");
  }

  /* ---------------- toast ---------------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("is-on"), 2200);
  }

  /* ---------------- click delegation ---------------- */
  document.addEventListener("click", (e) => {
    const sm = $("#space-menu");
    if (sm && !sm.hidden && !e.target.closest("#space-menu") && !e.target.closest(".space-switch")) sm.hidden = true;
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const a = el.dataset.action;
    const d = el.dataset;
    const wOf = () => findWin(d.id);
    const spaceW = () => wins[d.space]?.[d.id];

    switch (a) {
      case "open-app": openApp(d.app); break;
      case "palette": openPalette(); break;
      case "mission": openMission(); break;
      case "close-mission": closeOverlay("mission"); break;
      case "help": openHelp(); break;
      case "close-help": closeOverlay("help"); break;
      case "space": switchSpace(d.id); $("#space-menu").hidden = true; break;
      case "space-menu": { const mm = $("#space-menu"); mm.hidden = !mm.hidden; break; }
      case "theme-toggle": settings.theme = settings.theme === "light" ? "dark" : "light"; applySettings(); rerenderApp("sys"); toast("theme → " + settings.theme); break;
      case "theme-set": settings.theme = d.set; applySettings(); rerenderApp("sys"); toast("theme → " + d.set); break;
      case "reset-layout": localStorage.removeItem(LS_WINS); wins = defaultWins(); mountAll(); toast("layout reset"); break;
      case "w-min": { const w = spaceW(); minWin(w); break; }
      case "w-max": { const w = findWin(d.id, d.space); if (w) toggleMax(w); break; }
      case "w-close": { const w = findWin(d.id, d.space); if (w) { closeWin(w); toast(d.id + " closed — 数据活着，⌘K 可重开"); } break; }
      case "shelf-restore": { const w = wins[d.space][d.id]; if (d.space !== GLOBAL && d.space !== settings.space) switchSpace(d.space); restoreWin(w); break; }
      case "proc-focus": { const w = wins[d.space][d.id]; closeOverlay("mission"); if (d.space !== GLOBAL && d.space !== settings.space) switchSpace(d.space); restoreWin(w); focusWin(w); break; }
      case "run-focus": { openApp("runs", { space: settings.space, selRun: d.rid }); const rw = wins[d.space]?.runs; if (rw) { spaceState(d.space).selRun = d.rid; refreshWin(rw); } break; }
      case "run-sel": { spaceState(d.space).selRun = d.rid; refreshWin(wins[d.space]?.runs); break; }
      case "run-tab": { spaceState(d.space).runTab = d.tab; refreshWin(wins[d.space]?.runs); break; }
      case "task-sel": {
        const s = spaceState(d.space);
        s.selTask = s.selTask === d.id ? null : d.id;
        refreshWin(wins[d.space]?.tasks);
        break;
      }
      case "insp-run": { const t = findTask(d.space, d.id); if (t) { t.column = "executing"; } runCmd("run " + d.id); refreshWin(wins[d.space]?.tasks); break; }
      case "insp-approve": { const t = findTask(d.space, d.id); if (t) { t.column = "done"; t.progress = 100; }
        const s = spaceState(d.space); if (s.selTask === d.id) s.selTask = null;
        const iw = findWin("insp:" + d.id, d.space); if (iw) closeWin(iw);
        refreshWin(wins[d.space]?.tasks); rerenderApp("today"); updateHud(); toast("✓ " + d.id + " accepted"); break; }
      case "insp-reject": { const t = findTask(d.space, d.id); if (t && t.column === "verify") t.column = "executing";
        refreshWin(wins[d.space]?.tasks); rerenderApp("today"); toast("↩ " + d.id + " rejected — back to Executing"); break; }
      case "alert-jump": openApp("inbox"); break;
      case "alert-act": { const i = ALERTS.findIndex((x) => x.id === d.id); const al = ALERTS[i]; ALERTS.splice(i, 1); updateHud(); rerenderApp("today"); rerenderApp("inbox"); updateRail();
        if (al?.kind === "msg") { openApp("agent"); } toast("✓ " + (al?.t || "alert") + " — resolved"); break; }
      case "alert-dismiss": { const i = ALERTS.findIndex((x) => x.id === d.id); ALERTS.splice(i, 1); updateHud(); rerenderApp("today"); rerenderApp("inbox"); updateRail(); break; }
      case "job-toggle": { JOBS[+d.i].on = !JOBS[+d.i].on; rerenderApp("sched"); toast("job " + JOBS[+d.i].name + " → " + (JOBS[+d.i].on ? "ARMED" : "PAUSED")); break; }
      case "wiki-page": { spaceState(settings.space).wikiPage = d.page; rerenderApp("wiki"); break; }
      case "res-ins": toast("skill " + d.name + " — 已安装 · 可在 agent composer 用 /" + d.name.replace(/^octo-?/, "octo-")); break;
      case "res-sync": toast("syncing " + d.name + " ▸ octopus resource list"); break;
      case "agent-send": { const input = el.closest(".composer").querySelector(".chat-input"); if (input?.value.trim()) agentSend(input.value.trim()); break; }
      case "console-log": { const box = $("#console-out"); box.hidden = !box.hidden; $("#con-toggle").classList.toggle("is-on", !box.hidden); break; }
      case "tile": tile(); break;
      case "cascade": cascade(); break;
    }
  });

  function rerenderApp(app) {
    const space = app === "agent" ? GLOBAL : settings.space;
    const w = wins[space]?.[app];
    if (w && !w.closed) refreshWin(w);
  }

  /* ---------------- keys ---------------- */
  const isTyping = () => { const a = document.activeElement; return !!(a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && a.offsetParent !== null); };

  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const pal = !$("#palette").hidden;

    if (pal) {
      if (e.key === "ArrowDown") { e.preventDefault(); palSel = clamp(palSel + 1, 0, palCur.length - 1); renderPalette(); scrollPal(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); palSel = clamp(palSel - 1, 0, palCur.length - 1); renderPalette(); scrollPal(); }
      else if (e.key === "Enter") { e.preventDefault(); paletteEnter(); }
      else if (e.key === "Escape") { closeOverlay("palette"); }
      return;
    }

    if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
    if (mod && e.key.toLowerCase() === "j") { e.preventDefault(); openApp("agent"); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === "m") { e.preventDefault(); openMission(); return; }
    if (e.altKey && !isTyping() && e.code === "KeyT") { e.preventDefault(); tile(); return; }
    if (e.altKey && !isTyping() && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const i = SPACES.findIndex((s) => s.id === settings.space);
      const n = (i + (e.key === "ArrowRight" ? 1 : SPACES.length - 1)) % SPACES.length;
      switchSpace(SPACES[n].id);
      return;
    }
    if (e.altKey && !isTyping() && /^Digit[1-8]$/.test(e.code)) { e.preventDefault(); openApp(RAIL_ORDER[+e.code.slice(5) - 1]); return; }
    if (mod && e.key.toLowerCase() === "w") { const w = focusedW; if (w) { e.preventDefault(); closeWin(w); } return; }
    if (mod && e.key.toLowerCase() === "m") { const w = focusedW; if (w) { e.preventDefault(); minWin(w); } return; }

    if (!isTyping()) {
      if (e.key === "`") { e.preventDefault(); $con().focus(); return; }
      if (e.key === "/") { e.preventDefault(); $con().focus(); return; }
      if (e.key === "?") { e.preventDefault(); openHelp(); return; }
    }
    if (e.key === "Escape") {
      const sm2 = $("#space-menu");
      if (sm2 && !sm2.hidden) { sm2.hidden = true; return; }
      const ov = overlayOpen();
      if (ov) { closeOverlay(ov); return; }
      if (!$("#console-out").hidden) { $("#console-out").hidden = true; $("#con-toggle").classList.remove("is-on"); return; }
      if (isTyping()) document.activeElement.blur();
    }
  });
  function scrollPal() { const el = $("#palette-list .is-sel"); if (el) el.scrollIntoView({ block: "nearest" }); }

  $("#palette-list").addEventListener("click", (e) => {
    const it = e.target.closest("[data-pi]");
    if (it) { palSel = +it.dataset.pi; paletteEnter(); }
  });
  $("#palette-input").addEventListener("input", () => { palSel = 0; renderPalette(); });

  /* console */
  $("#console").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.stopPropagation(); runCmd($("#console").value); $("#console").value = ""; }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); histIdx = clamp(histIdx + 1, 0, settings.hist.length - 1); $("#console").value = settings.hist[histIdx] || ""; }
    else if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); histIdx = clamp(histIdx - 1, -1, settings.hist.length - 1); $("#console").value = histIdx < 0 ? "" : settings.hist[histIdx]; }
    else if (e.key === "Escape") { e.stopPropagation(); $("#console").value = ""; $("#console").blur(); }
  });

  /* ---------------- init ---------------- */
  applySettings();
  mountAll();
  switchSpace(settings.space);
  $$(".win").forEach((el) => el.addEventListener("focusin", () => { const w = wins[el.dataset.space]?.[el.dataset.id]; if (w && w !== focusedW) focusWin(w, true); }));
  clock(); setInterval(clock, 1000);
  vitals(); setInterval(vitals, 2200);
  pushFeed(true); setInterval(() => pushFeed(false), 6000);
  setInterval(streamLogs, 2600);

  window.addEventListener("resize", () => { Object.keys(wins).filter((k) => k !== "_v").forEach((k) => Object.values(wins[k]).forEach((w) => { if (!w.closed && !w.min) placeWin(w); })); });

  // expose for console play
  window.NEXUS = { openApp, runCmd, toast, switchSpace, DATA, wins, settings };
})();
