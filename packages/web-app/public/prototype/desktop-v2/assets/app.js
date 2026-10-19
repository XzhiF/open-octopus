(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));

  const KEY = "octopus.desktop.v2";

  const SPRITE = `
  <svg width="0" height="0" style="position:absolute;overflow:hidden" aria-hidden="true">
    <defs>
      <symbol id="i-logo" viewBox="0 0 24 24"><path d="M12 2.8 20 7.2v9.6L12 21.2 4 16.8V7.2L12 2.8Z"/><circle cx="12" cy="10" r="2.2"/><path d="M8.4 14.7c.7 1.8 2 2.8 3.6 2.8s2.9-1 3.6-2.8"/></symbol>
      <symbol id="i-home" viewBox="0 0 24 24"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10Z"/></symbol>
      <symbol id="i-message" viewBox="0 0 24 24"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L3 21l1.8-5.4A8.5 8.5 0 1 1 21 11.5Z"/></symbol>
      <symbol id="i-check" viewBox="0 0 24 24"><path d="m4 12.5 5 5L20 6.5"/></symbol>
      <symbol id="i-kanban" viewBox="0 0 24 24"><rect x="3" y="3" width="5" height="18" rx="1.5"/><rect x="10" y="3" width="5" height="12" rx="1.5"/><rect x="17" y="3" width="4" height="8" rx="1.5"/></symbol>
      <symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></symbol>
      <symbol id="i-play" viewBox="0 0 24 24"><path d="m7 4 13 8-13 8V4Z"/></symbol>
      <symbol id="i-pause" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></symbol>
      <symbol id="i-stop" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/></symbol>
      <symbol id="i-terminal" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 9 3 3-3 3M13 15h4"/></symbol>
      <symbol id="i-branch" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M8.5 6H13a3 3 0 0 1 3 3v11"/></symbol>
      <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3 4.5 6v5.5c0 4.5 3 8 7.5 9.5 4.5-1.5 7.5-5 7.5-9.5V6L12 3Z"/><path d="m8.5 12 2.3 2.3 4.7-4.6"/></symbol>
      <symbol id="i-wallet" viewBox="0 0 24 24"><path d="M20 8V7a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7"/><path d="M16 13h.01"/></symbol>
      <symbol id="i-cpu" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></symbol>
      <symbol id="i-book" viewBox="0 0 24 24"><path d="M12 6.5C10.5 5 8.5 4.3 6 4.3H3v14.4h3c2.5 0 4.5.7 6 2.2 1.5-1.5 3.5-2.2 6-2.2h3V4.3h-3c-2.5 0-4.5.7-6 2.2Z"/><path d="M12 6.5V21"/></symbol>
      <symbol id="i-activity" viewBox="0 0 24 24"><path d="M3 12h4l2.5-7 4 14L16 12h5"/></symbol>
      <symbol id="i-settings" viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></symbol>
      <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></symbol>
      <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></symbol>
      <symbol id="i-columns" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></symbol>
      <symbol id="i-x" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></symbol>
      <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
      <symbol id="i-send" viewBox="0 0 24 24"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z"/></symbol>
      <symbol id="i-arrow-right" viewBox="0 0 24 24"><path d="M4 12h16M14 6l6 6-6 6"/></symbol>
      <symbol id="i-chevron-right" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></symbol>
      <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
      <symbol id="i-sparkle" viewBox="0 0 24 24"><path d="m12 3 1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8L12 3Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/></symbol>
    </defs>
  </svg>`;

  document.body.insertAdjacentHTML("afterbegin", SPRITE);

  const icon = (name, cls = "") =>
    `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  const DEFAULT_MESSAGES = [
    { role: "user", text: "I need to check the wiki, then come back to this.", time: "09:41" },
    { role: "agent", text: "Go ahead. I’ll keep the conversation and the running task here. Nothing reloads when you switch.", time: "09:41" },
    { role: "agent", text: "The draft, the scroll position, and the run below all stay alive.", time: "09:42", note: "desktop-v2 · background task · 68%" },
  ];

  const TASK_COLUMNS = [
    { id: "queued", label: "Queued" },
    { id: "executing", label: "Executing" },
    { id: "verify", label: "Verify" },
    { id: "done", label: "Done" },
  ];

  const DEFAULT_TASKS = [
    {
      id: "t1",
      title: "Desktop multi-window redesign",
      desc: "A quieter shell that keeps task, run, and chat context alive.",
      column: "executing",
      progress: 68,
      meta: "open-octopus · feat/desktop-v2",
      labels: ["frontend", "round 2"],
      phases: [
        { title: "Window shell", meta: "pane model · persistent views", state: "done" },
        { title: "Task board", meta: "board + task inspector", state: "running" },
        { title: "Acceptance", meta: "5 probes · keyboard + density", state: "next" },
      ],
      checks: [
        { label: "Views stay mounted across switches", done: true },
        { label: "Board and runs are first-class surfaces", done: true },
        { label: "Split keeps both panes active", done: true },
        { label: "Keyboard focus order in split view", done: false },
      ],
      acceptance: "4 / 5 walkthrough probes pass. Remaining: focus order in split view.",
    },
    {
      id: "t2",
      title: "Task acceptance · round 2",
      desc: "Walk through the board, run detail, and persistent chat.",
      column: "verify",
      progress: 80,
      meta: "验收台· round 2",
      labels: ["acceptance"],
      phases: [
        { title: "Board walkthrough", meta: "lanes + detail inspector", state: "done" },
        { title: "Run walkthrough", meta: "graph · timeline · logs", state: "done" },
        { title: "Keyboard pass", meta: "focus order", state: "running" },
      ],
      checks: [
        { label: "Task card opens its inspector", done: true },
        { label: "Run detail survives view switch", done: true },
        { label: "Chat draft survives switching", done: true },
        { label: "Focus ring order", done: false },
      ],
      acceptance: "4 / 5 probes pass. One focus-order defect remains.",
    },
    {
      id: "t3",
      title: "Run compare view",
      desc: "Compare two executions: graph, cost, tokens, and artifact diff.",
      column: "queued",
      progress: 0,
      meta: "open-octopus · backlog",
      labels: ["runs", "v4"],
      phases: [
        { title: "Select runs", meta: "same workflow · two ids", state: "next" },
        { title: "Diff graph", meta: "node-level changes", state: "next" },
      ],
      checks: [
        { label: "Pick two runs", done: false },
        { label: "Compare cost and tokens", done: false },
      ],
      acceptance: "Not started.",
    },
    {
      id: "t4",
      title: "Scheduler cost guard",
      desc: "Pause a nightly compile when the budget exceeds $2.",
      column: "queued",
      progress: 0,
      meta: "scheduler · workflow",
      labels: ["scheduler"],
      phases: [
        { title: "Budget detector", meta: "per-run threshold", state: "next" },
        { title: "Pause + notify", meta: "hermes channel", state: "next" },
      ],
      checks: [
        { label: "Budget check wired", done: false },
        { label: "Pause event recorded", done: false },
      ],
      acceptance: "Not started.",
    },
    {
      id: "t5",
      title: "Wiki compile · ADR-0034",
      desc: "Compile the window-model decisions into a cases page.",
      column: "executing",
      progress: 32,
      meta: "knowledge · agent",
      labels: ["wiki"],
      phases: [
        { title: "Collect decisions", meta: "ADR + glossary", state: "done" },
        { title: "Compile page", meta: "cases · links", state: "running" },
        { title: "Publish", meta: "wiki index", state: "next" },
      ],
      checks: [
        { label: "Source refs attached", done: true },
        { label: "Cases page drafted", done: false },
      ],
      acceptance: "Compile in progress.",
    },
    {
      id: "t6",
      title: "Command palette focus order",
      desc: "Keyboard path stops after “Tile windows”",
      column: "verify",
      progress: 60,
      meta: "acceptance · probe 4/5",
      labels: ["keyboard"],
      phases: [
        { title: "Reproduce", meta: "keyboard-only walkthrough", state: "done" },
        { title: "Fix focus ring", meta: "palette + dock", state: "running" },
      ],
      checks: [
        { label: "Tab reaches every action", done: false },
        { label: "Escape returns focus", done: true },
      ],
      acceptance: "Waiting on the focus ring fix.",
    },
    {
      id: "t7",
      title: "Window state persistence",
      desc: "Open views, split state, draft, and scroll survive reload.",
      column: "done",
      progress: 100,
      meta: "landed · 1h ago",
      labels: ["state"],
      phases: [
        { title: "Persist layout", meta: "open · main · side", state: "done" },
        { title: "Persist drafts", meta: "chat + tasks", state: "done" },
      ],
      checks: [
        { label: "Reload restores layout", done: true },
        { label: "Reload restores draft", done: true },
      ],
      acceptance: "Passed.",
    },
    {
      id: "t8",
      title: "Quiet visual system",
      desc: "One accent, 15px body, fewer surfaces.",
      column: "done",
      progress: 100,
      meta: "landed · 2h ago",
      labels: ["design"],
      phases: [
        { title: "Tokens", meta: "warm paper · graphite", state: "done" },
        { title: "Primitives", meta: "rows · panes · dock", state: "done" },
      ],
      checks: [
        { label: "Light theme", done: true },
        { label: "Dark theme", done: true },
      ],
      acceptance: "Passed.",
    },
  ];

  const RUN_STATUS = {
    running: { label: "Running", className: "is-running" },
    waiting: { label: "Waiting", className: "is-waiting" },
    queued: { label: "Queued", className: "is-queued" },
    done: { label: "Done", className: "is-done" },
  };

  const RUN_START = Date.now() - 18 * 60 * 1000;

  const DEFAULT_RUNS = [
    {
      id: "r1",
      code: "#e2f1",
      title: "Build desktop shell",
      repo: "open-octopus",
      branch: "feat/desktop-v2",
      status: "running",
      progress: 68,
      cost: "$0.84",
      tokens: "48.2k",
      nodes: "4/5",
      startedAt: RUN_START,
      steps: [
        { title: "Intake · bash", meta: "worktree ready · branch feat/desktop-v2", time: "00:01", state: "done" },
        { title: "Build · agent", meta: "7 turns · 6 files · lint clean", time: "18:24", state: "done" },
        { title: "Review · swarm", meta: "2 rounds · consensus 0.86", time: "19:02", state: "done" },
        { title: "Verify · acceptance", meta: "probe 4/5 · keyboard focus", time: "21:08", state: "running" },
        { title: "Deliver · approval", meta: "waiting for production approval", time: "next", state: "queued" },
      ],
      logs: [
        { time: "09:41:02", tag: "verify", text: "probe 4/5 started · keyboard focus order", tone: "waiting" },
        { time: "09:40:58", tag: "fix", text: "node completed · +42 lines, −8 lines", tone: "done" },
        { time: "09:40:21", tag: "review", text: "consensus 0.86 · 2 experts agreed", tone: "done" },
        { time: "09:39:44", tag: "bash", text: "pnpm lint --filter web-app · exit 0", tone: "tool" },
        { time: "09:38:12", tag: "write", text: "components/desktop/tasks.tsx · 12,418 bytes", tone: "tool" },
        { time: "09:37:50", tag: "build", text: "turn 7/8 · 2,184 tokens", tone: "running" },
        { time: "09:36:31", tag: "engine", text: "checkpoint saved · resumable", tone: "tool" },
        { time: "09:35:09", tag: "plan", text: "node completed · 12.4k tokens · $0.31", tone: "done" },
      ],
    },
    {
      id: "r2",
      code: "#e2e8",
      title: "Task acceptance · round 2",
      repo: "desktop-v2",
      branch: "acceptance/r2",
      status: "waiting",
      progress: 80,
      cost: "$1.12",
      tokens: "62.4k",
      nodes: "4/5",
      elapsed: "42m",
      steps: [
        { title: "Board walkthrough", meta: "lanes · inspector · quick add", time: "06:12", state: "done" },
        { title: "Run walkthrough", meta: "graph · timeline · logs", time: "19:44", state: "done" },
        { title: "Keyboard probe", meta: "focus order in split view", time: "42m", state: "waiting" },
      ],
      logs: [
        { time: "09:32:10", tag: "probe", text: "keyboard path stops at split action", tone: "waiting" },
        { time: "09:31:52", tag: "probe", text: "chat draft preserved across views", tone: "done" },
        { time: "09:28:41", tag: "probe", text: "run detail scroll preserved", tone: "done" },
        { time: "09:22:03", tag: "accept", text: "round 2 started · 5 probes", tone: "tool" },
      ],
    },
    {
      id: "r3",
      code: "#e300",
      title: "Nightly wiki compile",
      repo: "knowledge",
      branch: "scheduler/02:00",
      status: "queued",
      progress: 0,
      cost: "—",
      tokens: "—",
      nodes: "0/5",
      elapsed: "in 5h",
      steps: [
        { title: "Wait for scheduler", meta: "02:00 · budget $2", time: "in 5h", state: "queued" },
        { title: "Compile · agent", meta: "wiki index", time: "—", state: "queued" },
      ],
      logs: [
        { time: "—", tag: "scheduler", text: "queued · next trigger 02:00", tone: "tool" },
      ],
    },
    {
      id: "r4",
      code: "#e1c4",
      title: "Clone · research-scout",
      repo: "research-scout",
      branch: "worktree/research",
      status: "done",
      progress: 100,
      cost: "$0.21",
      tokens: "8.1k",
      nodes: "5/5",
      elapsed: "6m",
      steps: [
        { title: "Clone worktree", meta: "isolated workspace", time: "00:12", state: "done" },
        { title: "Research · agent", meta: "4 sources · summary", time: "4m", state: "done" },
        { title: "Merge result", meta: "clean · no conflicts", time: "6m", state: "done" },
      ],
      logs: [
        { time: "08:52:33", tag: "merge", text: "clean · no conflicts", tone: "done" },
        { time: "08:51:19", tag: "agent", text: "summary written · 4 sources", tone: "done" },
        { time: "08:47:04", tag: "clone", text: "worktree ready", tone: "tool" },
      ],
    },
  ];

  const WIKI_PAGES = {
    "window-model": {
      section: "Design",
      kicker: "Design / Architecture",
      title: "One desktop, many views.",
      lead: "Navigation changes what you see, not what exists.",
      body: `
        <p>A view is mounted once and kept alive. Switching hides it. It does not reload data, reset scroll, or discard a draft.</p>
        <p>The left rail opens a view. The dock shows which views are open. Neither one creates a new desktop.</p>
        <h3>Open, focus, split</h3>
        <ul>
          <li>Click a rail item or dock item to focus an existing view.</li>
          <li>Use Split when two contexts need to be visible at once.</li>
          <li>Click a pane before opening another view to choose where it lands.</li>
        </ul>
        <div class="callout">Close releases the view. The underlying run, task, or conversation keeps going.</div>
      `,
    },
    interface: {
      section: "Design",
      kicker: "Design / Interface",
      title: "Quiet by default.",
      lead: "One accent, generous spacing, and no decorative chrome.",
      body: `
        <p>Colour marks state. It does not decorate. Hairlines separate regions; cards are used only when an object needs its own boundary.</p>
        <p>Body text is 15px. Metadata is smaller, but never used for primary information. Dense tables belong inside a focused view, not on the workbench.</p>
        <h3>What to remove</h3>
        <ul>
          <li>Repeated status pills and nested cards.</li>
          <li>Grid backgrounds, glows, and multiple accent colours.</li>
          <li>Windows that overlap without a reason.</li>
        </ul>
      `,
    },
    persistence: {
      section: "Engineering",
      kicker: "Engineering / State",
      title: "Keep the view mounted.",
      lead: "Persistence is a rendering rule before it is a storage rule.",
      body: `
        <p>The shell owns the view cache. A rail switch changes which cached view is visible; it does not mount a new route.</p>
        <p>Chat drafts, task input, wiki scroll, and run output live outside the view transition. Layout preferences and drafts can also be restored from local storage.</p>
        <h3>Invariant</h3>
        <div class="callout">Switching away and back must not trigger a network reload or reset local interaction state.</div>
      `,
    },
    runs: {
      section: "Engineering",
      kicker: "Engineering / Runs",
      title: "Runs continue in the background.",
      lead: "The view is a monitor, not the process.",
      body: `
        <p>A run keeps streaming while its view is hidden. Reopening the view attaches to the current stream and fills in the latest events.</p>
        <p>The dock shows that the run is still open. Closing the view does not cancel the run; use the run controls when cancellation is intended.</p>
        <div class="callout">One run, many views: logs, cost, graph, and harness can all observe the same execution.</div>
      `,
    },
  };

  const defaults = () => ({
    open: ["home", "chat", "wiki"],
    recent: ["home", "chat", "wiki"],
    main: "home",
    side: "wiki",
    split: false,
    theme: "light",
    tasks: JSON.parse(JSON.stringify(DEFAULT_TASKS)),
    selectedTask: "t1",
    selectedRun: "r1",
    runTab: "graph",
    messages: DEFAULT_MESSAGES.map((message) => ({ ...message })),
    chatDraft: "",
    wikiPage: "window-model",
  });

  const load = () => {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  };

  const state = { ...defaults(), ...load() };
  if (!Array.isArray(state.open)) state.open = defaults().open;
  if (!Array.isArray(state.recent)) state.recent = defaults().recent;
  if (!Array.isArray(state.tasks)) state.tasks = defaults().tasks;
  if (!state.tasks.some((task) => task.id === state.selectedTask)) state.selectedTask = state.tasks[0]?.id || null;
  if (!DEFAULT_RUNS.some((run) => run.id === state.selectedRun)) state.selectedRun = "r1";
  if (!["graph", "timeline", "logs"].includes(state.runTab)) state.runTab = "graph";
  if (!Array.isArray(state.messages)) state.messages = defaults().messages;
  if (typeof state.chatDraft !== "string") state.chatDraft = "";
  if (!WIKI_PAGES[state.wikiPage]) state.wikiPage = "window-model";
  if (state.theme !== "dark") state.theme = "light";
  state.activePane = 0;

  document.documentElement.dataset.theme = state.theme;

  const views = new Map();
  const scrollPositions = {};
  const wikiScroll = {};
  let saveTimer;
  let toastTimer;

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        open: state.open,
        recent: state.recent,
        main: state.main,
        side: state.side,
        split: state.split,
        theme: state.theme,
        tasks: state.tasks,
        selectedTask: state.selectedTask,
        selectedRun: state.selectedRun,
        runTab: state.runTab,
        messages: state.messages,
        chatDraft: state.chatDraft,
        wikiPage: state.wikiPage,
      }));
    } catch {
      /* Prototype runs fine without storage. */
    }
  };

  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 180);
  };

  const toast = (message) => {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), 2200);
  };

  const timeLabel = () => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  };

  const formatElapsed = (ms) => {
    const mins = Math.max(0, Math.floor(ms / 60000));
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  };

  const messageHTML = (message) => {
    const isUser = message.role === "user";
    return `
      <div class="msg ${isUser ? "user" : "agent"}">
        <div class="msg-avatar">${isUser ? "ZF" : icon("logo")}</div>
        <div class="msg-body">
          <div class="msg-name">${isUser ? "You" : "main"}<span>${esc(message.time || "")}</span></div>
          <div class="msg-text">${esc(message.text)}</div>
          ${message.note ? `<div class="msg-note">${esc(message.note)}</div>` : ""}
        </div>
      </div>`;
  };

  const taskById = (id) => state.tasks.find((task) => task.id === id) || null;
  const runById = (id) => DEFAULT_RUNS.find((run) => run.id === id) || DEFAULT_RUNS[0];
  const columnLabel = (id) => TASK_COLUMNS.find((column) => column.id === id)?.label || id;

  const taskCardHTML = (task) => {
    const selected = task.id === state.selectedTask ? "is-selected" : "";
    const progress = task.progress || 0;
    return `
      <button class="task-card ${selected}" data-task-id="${esc(task.id)}">
        <div class="task-card-title">${esc(task.title)}</div>
        <p class="task-card-desc">${esc(task.desc)}</p>
        <div class="task-card-labels">${esc((task.labels || []).join(" · "))}</div>
        ${progress ? `<div class="task-card-progress"><span class="progress"><i style="width:${progress}%"></i></span><span>${progress}%</span></div>` : ""}
        <div class="task-card-foot"><span>${esc(task.meta)}</span><span>${task.column === "done" ? "Done" : progress ? "Active" : "Backlog"}</span></div>
      </button>`;
  };

  const taskDetailHTML = (task) => {
    if (!task) return `<div class="task-detail-empty">Select a task.</div>`;
    return `
      <div class="task-detail-head">
        <p class="kicker">${esc(columnLabel(task.column))} · ${esc(task.meta)}</p>
        <h2>${esc(task.title)}</h2>
        <p>${esc(task.desc)}</p>
        <div class="task-detail-actions">
          <button class="primary" data-task-action="approve">Approve</button>
          <button class="secondary" data-task-action="reject">Reject</button>
        </div>
      </div>
      <div class="task-detail-body">
        <div class="section-label">Phases</div>
        <div class="phase-list">
          ${(task.phases || []).map((phase, index) => `
            <div class="phase ${phase.state}">
              <span class="phase-num">${phase.state === "done" ? icon("check") : String(index + 1).padStart(2, "0")}</span>
              <div class="phase-main"><b>${esc(phase.title)}</b><span>${esc(phase.meta)}</span></div>
              <span class="phase-state">${phase.state === "done" ? "Passed" : phase.state === "running" ? "Active" : "Next"}</span>
            </div>`).join("")}
        </div>

        <div class="section-label">Acceptance</div>
        <div class="check-list">
          ${(task.checks || []).map((check) => `
            <div class="check ${check.done ? "is-done" : ""}">
              <span class="check-box">${check.done ? icon("check") : ""}</span>
              <span>${esc(check.label)}</span>
            </div>`).join("")}
        </div>
        <div class="callout">${esc(task.acceptance || "No acceptance note yet.")}</div>
        <button class="secondary task-open-run" data-task-action="open-run">${icon("activity")}Open run</button>
      </div>`;
  };

  const runElapsed = (run) => {
    if (run.status === "running" && run.startedAt) {
      return `<span data-run-elapsed data-start="${run.startedAt}">${formatElapsed(Date.now() - run.startedAt)}</span>`;
    }
    return `<span>${esc(run.elapsed || "—")}</span>`;
  };

  const runItemHTML = (run) => {
    const status = RUN_STATUS[run.status];
    return `
      <button class="run-item ${run.id === state.selectedRun ? "is-selected" : ""}" data-run-id="${esc(run.id)}">
        <span class="run-status-dot ${status.className}"></span>
        <span class="run-item-main">
          <span class="run-item-title">${esc(run.title)}</span>
          <span class="run-item-meta">${esc(run.repo)} · ${esc(run.branch)}</span>
        </span>
        <span class="run-item-side">
          ${run.status === "running" ? `<span class="run-mini"><i style="width:${run.progress}%"></i></span>` : ""}
          <span class="run-item-elapsed">${runElapsed(run)}</span>
        </span>
      </button>`;
  };

  const runNodes = (run) => {
    const done = run.status === "done";
    const running = run.status === "running";
    const waiting = run.status === "waiting";
    const started = done || running || waiting;
    return [
      { label: "Intake", meta: "bash · 1.2s", state: "done" },
      { label: "Build", meta: "agent · 7 turns", state: started ? "done" : "queued" },
      { label: "Review", meta: "swarm · 2 rounds", state: started ? "done" : "queued" },
      { label: "Fix", meta: "agent · 2 turns", state: started ? "done" : "queued" },
      { label: "Verify", meta: "acceptance · 4/5", state: done ? "done" : running ? "running" : waiting ? "waiting" : "queued" },
      { label: "Deliver", meta: "approval", state: done ? "done" : "queued" },
    ];
  };

  const runGraphHTML = (run) => `
    <div class="run-flow">
      ${runNodes(run).map((node, index) => `
        ${index ? `<span class="flow-arrow ${node.state}"></span>` : ""}
        <div class="flow-node ${node.state}">
          <div class="flow-node-head"><span class="flow-dot"></span><b>${esc(node.label)}</b></div>
          <div class="flow-node-meta">${esc(node.meta)}</div>
        </div>`).join("")}
    </div>
    <div class="flow-note">${icon("branch")}Fix loop · one retry returned to Verify.</div>
    <div class="run-subhead">Recent events <span>SSE live</span></div>
    ${runLogsHTML(run, 4)}`;

  const runTimelineHTML = (run) => `
    <div class="timeline">
      ${(run.steps || []).map((step) => `
        <div class="timeline-row ${step.state}">
          <span class="timeline-dot">${step.state === "done" ? icon("check") : ""}</span>
          <div class="timeline-main"><b>${esc(step.title)}</b><span>${esc(step.meta)}</span></div>
          <time>${esc(step.time)}</time>
        </div>`).join("")}
    </div>`;

  const runLogsHTML = (run, limit = (run.logs || []).length) => `
    <div class="run-logs">
      ${(run.logs || []).slice(0, limit).map((log) => `
        <div class="log-row">
          <time>${esc(log.time)}</time>
          <span class="log-tag ${esc(log.tone || "")}">${esc(log.tag)}</span>
          <span class="log-text">${esc(log.text)}</span>
        </div>`).join("")}
    </div>`;

  const runDetailHTML = (run) => {
    const status = RUN_STATUS[run.status];
    const tab = state.runTab;
    return `
      <div class="run-detail-head">
        <div>
          <p class="kicker">Execution ${esc(run.code)} · ${esc(status.label)}</p>
          <h2>${esc(run.title)}</h2>
          <p>${esc(run.repo)} · ${esc(run.branch)}</p>
        </div>
        <div class="run-actions">
          ${run.status === "running" ? `<button class="icon-btn" data-run-action="pause" title="Pause">${icon("pause")}</button>` : ""}
          ${run.status === "waiting" ? `<button class="icon-btn" data-run-action="resume" title="Resume">${icon("play")}</button>` : ""}
          <button class="icon-btn" data-run-action="abort" title="Abort">${icon("stop")}</button>
        </div>
      </div>
      <div class="run-metrics">
        <div><span>Elapsed</span><b>${runElapsed(run)}</b></div>
        <div><span>Cost</span><b>${esc(run.cost)}</b></div>
        <div><span>Tokens</span><b>${esc(run.tokens)}</b></div>
        <div><span>Nodes</span><b>${esc(run.nodes)}</b></div>
      </div>
      <div class="run-tabs">
        <button class="run-tab ${tab === "graph" ? "is-active" : ""}" data-run-tab="graph">Graph</button>
        <button class="run-tab ${tab === "timeline" ? "is-active" : ""}" data-run-tab="timeline">Timeline</button>
        <button class="run-tab ${tab === "logs" ? "is-active" : ""}" data-run-tab="logs">Logs</button>
        <span class="run-live"><i class="status-dot"></i>${run.status === "running" ? "SSE live" : status.label}</span>
      </div>
      <div class="run-tab-body">
        ${tab === "graph" ? runGraphHTML(run) : tab === "timeline" ? runTimelineHTML(run) : runLogsHTML(run)}
      </div>`;
  };

  const articleHTML = (pageKey) => {
    const page = WIKI_PAGES[pageKey];
    return `
      <p class="kicker">${esc(page.kicker)}</p>
      <h2>${esc(page.title)}</h2>
      <p class="lead">${esc(page.lead)}</p>
      ${page.body}`;
  };

  const chatLog = () => views.get("chat")?.querySelector(".chat-log") || null;

  const scrollChat = () => {
    const log = chatLog();
    if (log) log.scrollTop = log.scrollHeight;
  };

  const appendMessage = (role, text, note = "") => {
    const message = { role, text, time: timeLabel(), note };
    state.messages.push(message);
    const log = chatLog();
    if (log) {
      log.insertAdjacentHTML("beforeend", messageHTML(message));
      scrollChat();
    }
    render();
    save();
  };

  const WINDOWS = {
    home: {
      label: "Today",
      icon: "home",
      subtitle: "Monday, 19 October",
      render() {
        const draft = state.chatDraft.trim() ? "Draft saved" : "Conversation preserved";
        return `
          <div class="home">
            <div class="home-inner">
              <div class="home-head">
                <div>
                  <p class="kicker">Monday, 19 October</p>
                  <h2>Good afternoon.</h2>
                  <p class="lead">Two runs are moving. The board has six active tasks and one decision is waiting.</p>
                </div>
                <button class="primary" data-new-task>${icon("plus")}New task</button>
              </div>

              <section class="section">
                <div class="section-head"><h3>Continue</h3></div>
                <div class="rows">
                  <button class="row row-button" data-open="chat">
                    <span class="row-icon">${icon("message")}</span>
                    <span class="row-main">
                      <span class="row-title">main · agent</span>
                      <span class="row-meta">${draft} · ${state.messages.length} messages</span>
                    </span>
                    <span class="row-side">${icon("chevron-right")}</span>
                  </button>
                  <button class="row row-button" data-open="wiki">
                    <span class="row-icon">${icon("book")}</span>
                    <span class="row-main">
                      <span class="row-title">Wiki · ${esc(WIKI_PAGES[state.wikiPage].title)}</span>
                      <span class="row-meta">${esc(WIKI_PAGES[state.wikiPage].section)} · scroll position kept</span>
                    </span>
                    <span class="row-side">${icon("chevron-right")}</span>
                  </button>
                </div>
              </section>

              <div class="home-columns">
                <section class="section">
                  <div class="section-head"><h3>Running</h3><button class="link" data-open="runs">All runs ${icon("arrow-right")}</button></div>
                  <div class="rows">
                    <button class="row row-button" data-open="runs">
                      <span class="row-icon">${icon("activity")}</span>
                      <span class="row-main">
                        <span class="row-title">Build desktop shell</span>
                        <span class="row-meta">open-octopus · step 4 of 5</span>
                      </span>
                      <span class="row-side">
                        <span class="progress"><i style="width:68%"></i></span>
                        <span class="state is-running">Running</span>
                      </span>
                    </button>
                    <button class="row row-button" data-open="runs">
                      <span class="row-icon">${icon("check")}</span>
                      <span class="row-main">
                        <span class="row-title">Task acceptance · round 2</span>
                        <span class="row-meta">desktop-v2 · 4/5 probes pass</span>
                      </span>
                      <span class="row-side">
                        <span class="progress"><i style="width:80%"></i></span>
                        <span class="state is-waiting">Waiting</span>
                      </span>
                    </button>
                  </div>
                </section>

                <section class="section">
                  <div class="section-head"><h3>Needs you</h3></div>
                  <div class="rows">
                    <div class="row">
                      <span class="row-icon">${icon("sparkle")}</span>
                      <span class="row-main">
                        <span class="row-title">Approve deploy</span>
                        <span class="row-meta">harness guard · 40m left</span>
                      </span>
                      <button class="secondary" data-open="runs">Review</button>
                    </div>
                    <div class="row">
                      <span class="row-icon">${icon("kanban")}</span>
                      <span class="row-main">
                        <span class="row-title">Acceptance walkthrough</span>
                        <span class="row-meta">one focus-order defect</span>
                      </span>
                      <button class="secondary" data-open="tasks">Open task</button>
                    </div>
                  </div>
                </section>
              </div>

              <section class="section">
                <div class="section-head"><h3>Board</h3><button class="link" data-open="tasks">Open board ${icon("arrow-right")}</button></div>
                <div class="board-stats">
                  ${TASK_COLUMNS.map((column) => `
                    <button class="board-stat" data-open="tasks">
                      <span>${state.tasks.filter((task) => task.column === column.id).length}</span>
                      <span>${esc(column.label)}</span>
                    </button>`).join("")}
                </div>
              </section>
            </div>
          </div>`;
      },
    },

    chat: {
      label: "Chat",
      icon: "message",
      subtitle: "main · ready",
      render() {
        return `
          <div class="chat">
            <div class="chat-log" data-scroll>
              ${state.messages.map(messageHTML).join("")}
            </div>
            <div class="chat-status"><span class="status-dot"></span><span>desktop-v2 · running in background · 68%</span></div>
            <form class="composer">
              <div class="composer-inner">
                <textarea rows="1" placeholder="Message main…" aria-label="Message main">${esc(state.chatDraft)}</textarea>
                <div class="composer-foot">
                  <span class="composer-meta">main · opus · 42% context</span>
                  <button class="send" type="submit" aria-label="Send message">${icon("send")}</button>
                </div>
              </div>
            </form>
          </div>`;
      },
      mount(view) {
        const form = $(".composer", view);
        const textarea = $("textarea", view);
        const submit = () => {
          const text = textarea.value.trim();
          if (!text) return;
          textarea.value = "";
          state.chatDraft = "";
          appendMessage("user", text);
          setTimeout(() => appendMessage("agent", "Noted. This view stays mounted while you check the wiki — scroll, draft, and the run are still here."), 800);
        };
        textarea.addEventListener("input", () => {
          state.chatDraft = textarea.value;
          saveSoon();
        });
        textarea.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        });
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          submit();
        });
        requestAnimationFrame(scrollChat);
      },
    },

    tasks: {
      label: "Tasks",
      icon: "kanban",
      subtitle: "6 open · 2 executing",
      render() {
        const active = state.tasks.filter((task) => task.column !== "done").length;
        const executing = state.tasks.filter((task) => task.column === "executing").length;
        const selected = taskById(state.selectedTask) || state.tasks[0];
        return `
          <div class="tasks">
            <div class="tasks-toolbar">
              <div class="toolbar-meta"><b>${active}</b> active <span>·</span> <b>${executing}</b> executing <span>·</span> $12.84 today</div>
              <button class="secondary" data-new-task>${icon("plus")}New task</button>
            </div>
            <div class="tasks-layout">
              <div class="board">
                ${TASK_COLUMNS.map((column) => {
                  const items = state.tasks.filter((task) => task.column === column.id);
                  return `
                    <section class="task-lane lane-${column.id}">
                      <header class="task-lane-head">
                        <span class="lane-status"></span>
                        <h3>${esc(column.label)}</h3>
                        <span>${items.length}</span>
                      </header>
                      <div class="task-lane-body">
                        ${items.map(taskCardHTML).join("")}
                        ${column.id === "queued" ? `
                          <form class="lane-add">
                            ${icon("plus")}
                            <input placeholder="Add a task…" aria-label="Add a task" autocomplete="off" />
                          </form>` : ""}
                      </div>
                    </section>`;
                }).join("")}
              </div>
              <aside class="task-detail">${taskDetailHTML(selected)}</aside>
            </div>
          </div>`;
      },
      mount(view) {
        view.addEventListener("click", (event) => {
          const card = event.target.closest("[data-task-id]");
          if (card) {
            state.selectedTask = card.dataset.taskId;
            refreshTasks(view);
            const detail = $(".task-detail", view);
            if (detail) detail.scrollTop = 0;
            save();
            return;
          }

          const action = event.target.closest("[data-task-action]")?.dataset.taskAction;
          if (!action) return;
          const task = taskById(state.selectedTask);
          if (!task) return;

          if (action === "approve") {
            task.column = "done";
            task.progress = 100;
            refreshTasks(view);
            save();
            toast("Task approved · moved to Done");
          } else if (action === "reject") {
            task.column = "verify";
            task.progress = Math.max(40, task.progress || 0);
            refreshTasks(view);
            save();
            toast("Task returned to Verify");
          } else if (action === "open-run") {
            state.selectedRun = "r1";
            openWindow("runs");
            refreshRunsView();
            save();
          }
        });

        view.addEventListener("submit", (event) => {
          if (!event.target.matches(".lane-add")) return;
          event.preventDefault();
          const input = $("input", event.target);
          const title = input.value.trim();
          if (!title) return;
          const task = {
            id: `t${Date.now()}`,
            title,
            desc: "New task from the board.",
            column: "queued",
            progress: 0,
            meta: "Octopus · just now",
            labels: ["new"],
            phases: [{ title: "Draft", meta: "needs a spec", state: "next" }],
            checks: [{ label: "Write the spec", done: false }],
            acceptance: "Not started.",
          };
          state.tasks.unshift(task);
          state.selectedTask = task.id;
          refreshTasks(view);
          save();
          toast("Task added to Queued");
        });
      },
    },

    wiki: {
      label: "Wiki",
      icon: "book",
      subtitle: "Design · compiled knowledge",
      render() {
        return `
          <div class="wiki">
            <aside class="wiki-tree">
              <p class="tree-label">Design</p>
              <button class="tree-item ${state.wikiPage === "window-model" ? "is-active" : ""}" data-wiki-page="window-model">Window model</button>
              <button class="tree-item ${state.wikiPage === "interface" ? "is-active" : ""}" data-wiki-page="interface">Interface principles</button>
              <p class="tree-label">Engineering</p>
              <button class="tree-item ${state.wikiPage === "persistence" ? "is-active" : ""}" data-wiki-page="persistence">State persistence</button>
              <button class="tree-item ${state.wikiPage === "runs" ? "is-active" : ""}" data-wiki-page="runs">Runs</button>
            </aside>
            <div class="wiki-page" data-scroll>
              <article class="article">${articleHTML(state.wikiPage)}</article>
            </div>
          </div>`;
      },
      mount(view) {
        const tree = $(".wiki-tree", view);
        const page = $(".wiki-page", view);
        tree.addEventListener("click", (event) => {
          const button = event.target.closest("[data-wiki-page]");
          if (!button) return;
          const next = button.dataset.wikiPage;
          if (!WIKI_PAGES[next] || next === state.wikiPage) return;
          wikiScroll[state.wikiPage] = page.scrollTop;
          state.wikiPage = next;
          tree.querySelectorAll("[data-wiki-page]").forEach((item) => {
            item.classList.toggle("is-active", item.dataset.wikiPage === next);
          });
          $(".article", view).innerHTML = articleHTML(next);
          page.scrollTop = wikiScroll[next] || 0;
          render();
          save();
        });
      },
    },

    runs: {
      label: "Runs",
      icon: "activity",
      subtitle: "2 active · 4 today",
      render() {
        const run = runById(state.selectedRun);
        const active = DEFAULT_RUNS.filter((item) => item.status === "running" || item.status === "waiting").length;
        return `
          <div class="runs">
            <div class="runs-toolbar">
              <div class="toolbar-meta"><b>${active}</b> active <span>·</span> ${DEFAULT_RUNS.length} today <span>·</span> $2.17</div>
              <span class="run-live"><i class="status-dot"></i>SSE connected</span>
            </div>
            <div class="runs-layout">
              <aside class="run-list">${DEFAULT_RUNS.map(runItemHTML).join("")}</aside>
              <section class="run-detail">${runDetailHTML(run)}</section>
            </div>
          </div>`;
      },
      mount(view) {
        view.addEventListener("click", (event) => {
          const item = event.target.closest("[data-run-id]");
          if (item) {
            state.selectedRun = item.dataset.runId;
            refreshRuns(view);
            save();
            return;
          }

          const tab = event.target.closest("[data-run-tab]")?.dataset.runTab;
          if (tab) {
            state.runTab = tab;
            refreshRuns(view);
            save();
            return;
          }

          const action = event.target.closest("[data-run-action]")?.dataset.runAction;
          if (!action) return;
          const run = runById(state.selectedRun);
          if (action === "pause") {
            run.elapsed = formatElapsed(Date.now() - run.startedAt);
            run.status = "waiting";
            toast("Run paused");
          } else if (action === "resume") {
            run.startedAt = Date.now() - 42 * 60 * 1000;
            run.status = "running";
            toast("Run resumed");
          } else if (action === "abort") {
            run.elapsed = formatElapsed(Date.now() - (run.startedAt || Date.now()));
            run.status = "done";
            run.progress = 100;
            run.nodes = "5/5";
            toast("Run aborted");
          }
          refreshRuns(view);
        });
      },
    },

    settings: {
      label: "Settings",
      icon: "settings",
      subtitle: "shell preferences",
      render() {
        return `
          <div class="settings">
            <div class="settings-inner">
              <h2>Settings</h2>
              <p>Quiet defaults for the workbench. These are stored locally.</p>
              <div class="setting-row">
                <div class="setting-main">
                  <div class="setting-title">Appearance</div>
                  <div class="setting-meta">Warm paper light, or graphite dark.</div>
                </div>
                <button class="secondary" data-action="theme">Toggle theme</button>
              </div>
              <div class="setting-row">
                <div class="setting-main">
                  <div class="setting-title">Layout</div>
                  <div class="setting-meta">Open views, split state, and drafts.</div>
                </div>
                <button class="secondary" data-action="reset">Reset layout</button>
              </div>
              <div class="setting-row">
                <div class="setting-main">
                  <div class="setting-title">Version</div>
                  <div class="setting-meta">Static interaction prototype.</div>
                </div>
                <span class="setting-meta">desktop-v2</span>
              </div>
            </div>
          </div>`;
      },
    },
  };

  const getView = (id) => {
    if (views.has(id)) return views.get(id);
    const view = document.createElement("div");
    view.className = "view";
    view.dataset.view = id;
    view.innerHTML = WINDOWS[id].render();
    views.set(id, view);
    WINDOWS[id].mount?.(view);
    return view;
  };

  const refreshTasks = (view = views.get("tasks")) => {
    if (!view) return;
    const board = $(".board", view);
    const left = board?.scrollLeft || 0;
    const detail = $(".task-detail", view);
    const top = detail?.scrollTop || 0;
    view.innerHTML = WINDOWS.tasks.render();
    const nextBoard = $(".board", view);
    if (nextBoard) nextBoard.scrollLeft = left;
    const nextDetail = $(".task-detail", view);
    if (nextDetail) nextDetail.scrollTop = top;
  };

  const refreshRuns = (view = views.get("runs")) => {
    if (!view) return;
    const list = $(".run-list", view);
    const top = list?.scrollTop || 0;
    const detail = $(".run-detail", view);
    const detailTop = detail?.scrollTop || 0;
    view.innerHTML = WINDOWS.runs.render();
    const nextList = $(".run-list", view);
    if (nextList) nextList.scrollTop = top;
    const nextDetail = $(".run-detail", view);
    if (nextDetail) nextDetail.scrollTop = detailTop;
  };

  const refreshRunsView = () => refreshRuns();

  const saveScroll = (id, view) => {
    if (!id || !view) return;
    scrollPositions[id] = $$("[data-scroll]", view).map((el) => el.scrollTop);
  };

  const restoreScroll = (id, view) => {
    const positions = scrollPositions[id];
    if (!positions) return;
    $$("[data-scroll]", view).forEach((el, index) => {
      el.scrollTop = positions[index] || 0;
    });
  };

  const activeId = () => {
    if (!state.main) return null;
    if (!state.split) return state.main;
    return state.activePane === 1 ? state.side : state.main;
  };

  const touchRecent = (id) => {
    if (!id) return;
    state.recent = [id, ...state.recent.filter((item) => item !== id)];
  };

  const normalize = () => {
    state.open = [...new Set(state.open.filter((id) => WINDOWS[id]))];
    state.recent = [...new Set(state.recent.filter((id) => WINDOWS[id] && state.open.includes(id)))];
    state.open.forEach((id) => {
      if (!state.recent.includes(id)) state.recent.push(id);
    });
    if (!state.open.length) {
      state.main = null;
      state.side = null;
      state.split = false;
      state.activePane = 0;
      return;
    }
    if (!state.main || !state.open.includes(state.main)) state.main = state.open[0];
    if (state.split) {
      if (!state.side || state.side === state.main || !state.open.includes(state.side)) {
        const candidate = state.open.find((id) => id !== state.main);
        if (candidate) state.side = candidate;
        else state.split = false;
      }
    } else {
      state.activePane = 0;
    }
    if (state.main === state.side) state.side = null;
  };

  const windowSubtitle = (id) => {
    if (id === "tasks") {
      const open = state.tasks.filter((task) => task.column !== "done").length;
      const done = state.tasks.length - open;
      return `${open} open · ${done} done`;
    }
    if (id === "runs") {
      const active = DEFAULT_RUNS.filter((run) => run.status === "running" || run.status === "waiting").length;
      return `${active} active · ${DEFAULT_RUNS.length} today`;
    }
    if (id === "chat") return `main · ready · ${state.messages.length} messages`;
    if (id === "wiki") return `${WIKI_PAGES[state.wikiPage].section} · ${WIKI_PAGES[state.wikiPage].title}`;
    return WINDOWS[id].subtitle;
  };

  const emptyHTML = `
    <div class="empty">
      <div>
        <p class="kicker">No view open</p>
        <h2>Pick a view.</h2>
        <p>Open views stay in the dock. Nothing reloads.</p>
        <div class="empty-actions">
          <button class="primary" data-open="home">Open Today</button>
          <button class="secondary" data-open="chat">Open chat</button>
        </div>
      </div>
    </div>`;

  const panes = $$(".pane");

  const renderPane = (index) => {
    const pane = panes[index];
    const id = index === 0 ? state.main : state.split ? state.side : null;
    const head = $(".pane-head", pane);
    const host = $(".view-host", pane);
    const previousId = pane.dataset.view;

    if (!id) {
      if (previousId) saveScroll(previousId, host.firstElementChild);
      if (index === 0) {
        pane.hidden = false;
        pane.classList.remove("is-active");
        head.innerHTML = "";
        host.innerHTML = emptyHTML;
      } else {
        pane.hidden = true;
        head.innerHTML = "";
        host.replaceChildren();
      }
      delete pane.dataset.view;
      return;
    }

    pane.hidden = false;
    pane.classList.toggle("is-active", state.split && state.activePane === index);
    pane.dataset.view = id;
    const win = WINDOWS[id];
    head.innerHTML = `
      <div class="pane-title">
        <div class="pane-icon">${icon(win.icon)}</div>
        <div class="pane-name">
          <h1>${esc(win.label)}</h1>
          <p>${esc(windowSubtitle(id))}</p>
        </div>
      </div>
      <div class="pane-actions">
        <button class="icon-btn" data-action="split" title="${state.split ? "Close split view" : "Split view"}" aria-label="${state.split ? "Close split view" : "Split view"}">${icon("columns")}</button>
        <button class="icon-btn" data-close title="Close view" aria-label="Close view">${icon("x")}</button>
      </div>`;

    const view = getView(id);
    if (host.firstElementChild !== view) {
      if (previousId && previousId !== id) saveScroll(previousId, host.firstElementChild);
      host.replaceChildren(view);
      restoreScroll(id, view);
    }
  };

  const syncRail = () => {
    const active = activeId();
    $$(".rail-item[data-open]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.open === active);
      button.classList.toggle("is-open", state.open.includes(button.dataset.open));
    });
  };

  const renderDock = () => {
    const dock = $("#dock-items");
    if (!state.open.length) {
      dock.innerHTML = `<span class="dock-empty">No open views</span>`;
      return;
    }
    const active = activeId();
    dock.innerHTML = state.open.map((id) => {
      const win = WINDOWS[id];
      return `
        <button class="dock-item ${id === active ? "is-active" : "is-open"}" data-open="${id}" title="${esc(win.label)}">
          ${icon(win.icon)}
          <span>${esc(win.label)}</span>
        </button>`;
    }).join("");
  };

  const syncSplit = () => {
    const button = $(".split-btn");
    button.setAttribute("aria-pressed", String(state.split));
    button.title = state.split ? "Return to a single view" : "Open a second view";
    $("span", button).textContent = state.split ? "Single" : "Split";
  };

  const syncActivePane = () => {
    panes.forEach((pane, index) => {
      pane.classList.toggle("is-active", state.split && state.activePane === index && !pane.hidden);
    });
  };

  const render = () => {
    normalize();
    $("#stage").classList.toggle("is-split", state.split);
    $("#stage").classList.toggle("is-single", !state.split);
    renderPane(0);
    renderPane(1);
    syncRail();
    renderDock();
    syncSplit();
  };

  const openWindow = (id) => {
    if (!WINDOWS[id]) return;
    if (!state.open.includes(id)) state.open.push(id);
    if (state.split) {
      if (id === state.main) state.activePane = 0;
      else if (id === state.side) state.activePane = 1;
      else if (state.activePane === 1) state.side = id;
      else state.main = id;
    } else {
      state.main = id;
      state.activePane = 0;
    }
    touchRecent(id);
    render();
    save();
  };

  const closeWindow = (id) => {
    if (!id) return;
    state.open = state.open.filter((item) => item !== id);
    state.recent = state.recent.filter((item) => item !== id);
    if (state.split) {
      if (id === state.side) {
        state.side = null;
        state.split = false;
        state.activePane = 0;
      } else if (id === state.main) {
        if (state.side) {
          state.main = state.side;
          state.side = null;
          state.split = false;
          state.activePane = 0;
        } else {
          state.main = state.open[0] || null;
          state.split = false;
          state.activePane = 0;
        }
      }
    } else if (id === state.main) {
      state.main = state.open[0] || null;
      state.activePane = 0;
    }
    render();
    save();
  };

  const toggleSplit = () => {
    if (state.split) {
      state.split = false;
      state.activePane = 0;
      render();
      save();
      toast("Back to a single view");
      return;
    }
    if (!state.main) openWindow("home");
    let side = state.recent.find((id) => id !== state.main && state.open.includes(id)) || state.side;
    if (!side || side === state.main || !state.open.includes(side)) {
      side = state.open.find((id) => id !== state.main) || null;
    }
    if (!side) {
      side = state.main === "wiki" ? "chat" : "wiki";
      if (!state.open.includes(side)) state.open.push(side);
    }
    state.side = side;
    state.split = true;
    state.activePane = 0;
    render();
    save();
    toast("Split view — click either pane to make it active");
  };

  const toggleTheme = () => {
    state.theme = state.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = state.theme;
    save();
    toast(state.theme === "dark" ? "Graphite dark" : "Warm paper light");
  };

  const focusTasks = () => {
    openWindow("tasks");
    requestAnimationFrame(() => {
      const input = views.get("tasks")?.querySelector(".lane-add input");
      input?.focus();
    });
  };

  document.addEventListener("click", (event) => {
    const open = event.target.closest("[data-open]");
    if (open) {
      event.preventDefault();
      openWindow(open.dataset.open);
      return;
    }

    const close = event.target.closest("[data-close]");
    if (close) {
      event.preventDefault();
      closeWindow(close.closest(".pane")?.dataset.view);
      return;
    }

    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "split") {
      toggleSplit();
      return;
    }
    if (action === "theme") {
      toggleTheme();
      return;
    }
    if (action === "reset") {
      localStorage.removeItem(KEY);
      location.reload();
      return;
    }

    if (event.target.closest("[data-new-task]")) {
      event.preventDefault();
      focusTasks();
    }
  });

  panes.forEach((pane, index) => {
    pane.addEventListener("pointerdown", () => {
      if (!state.split || pane.hidden || state.activePane === index) return;
      state.activePane = index;
      touchRecent(state.activePane === 1 ? state.side : state.main);
      syncActivePane();
      renderDock();
      save();
    }, true);
  });

  setInterval(() => {
    const view = views.get("runs");
    if (!view) return;
    const now = Date.now();
    view.querySelectorAll("[data-run-elapsed][data-start]").forEach((el) => {
      el.textContent = formatElapsed(now - Number(el.dataset.start));
    });
  }, 1000);

  window.addEventListener("beforeunload", save);
  render();
})();

