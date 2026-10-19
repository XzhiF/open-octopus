(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));

  const KEY = "octopus.desktop.v4";
  const WINDOW_KEY = "octopus.desktop.v4.windows";
  const SPACE_KEY = "octopus.desktop.v4.space";

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
      <symbol id="i-bell" viewBox="0 0 24 24"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 19a2 2 0 0 0 4 0"/></symbol>
      <symbol id="i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></symbol>
      <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/></symbol>
      <symbol id="i-chevron-down" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
      <symbol id="i-more" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none"/></symbol>
      <symbol id="i-sparkle" viewBox="0 0 24 24"><path d="m12 3 1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8L12 3Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/></symbol>
    </defs>
  </svg>`;

  document.body.insertAdjacentHTML("afterbegin", SPRITE);

  const icon = (name, cls = "") =>
    `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  const DEFAULT_MESSAGES = [
    { role: "user", text: "I need to check the wiki, then come back to this.", time: "09:41" },
    { role: "agent", text: "Go ahead. I’ll keep the conversation and the running task here. Nothing reloads when you switch.", time: "09:41" },
    { role: "agent", text: "The draft, the scroll position, and the run below all stay alive.", time: "09:42", note: "desktop-v4 · background task · 68%" },
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
      meta: "open-octopus · feat/desktop-v4",
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

  let DEFAULT_RUNS = [
    {
      id: "r1",
      code: "#e2f1",
      title: "Build desktop shell",
      repo: "open-octopus",
      branch: "feat/desktop-v4",
      status: "running",
      progress: 68,
      cost: "$0.84",
      tokens: "48.2k",
      nodes: "4/5",
      startedAt: RUN_START,
      steps: [
        { title: "Intake · bash", meta: "worktree ready · branch feat/desktop-v4", time: "00:01", state: "done" },
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
      repo: "desktop-v4",
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
      title: "One desktop, many windows.",
      lead: "A space is a project desktop. A window is a view over durable state.",
      body: `
        <p>The launcher opens windows. The dock shows what is open in the current space. Closing a window releases the view, not the task or run behind it.</p>
        <p>Spaces keep separate layouts. The main agent is global: it stays available while you move between project desktops.</p>
        <h3>Window controls</h3>
        <ul>
          <li>Drag a title bar, snap to an edge, or double-click to maximize.</li>
          <li>Use Mission Control to see every open window at once.</li>
          <li>Command palette: open apps, switch spaces, or ask main.</li>
        </ul>
        <div class="callout">Closing the inspector does not cancel the run. Reopen it from the dock or launcher.</div>
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
        <p>Every window is mounted once. Switching spaces hides one desktop layer and shows another; it does not remount the windows inside.</p>
        <p>Chat drafts, task input, wiki scroll, and run output live outside the window transition. Window geometry and the active space are restored from local storage.</p>
        <h3>Invariant</h3>
        <div class="callout">Switching away and back must not trigger a reload or reset local interaction state.</div>
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

  const MARKETING_TASKS = [
    {
      id: "m1",
      title: "Landing page build",
      desc: "Ship the launch page with the new brand tokens.",
      column: "executing",
      progress: 55,
      meta: "marketing-site · feat/landing",
      labels: ["frontend", "launch"],
      phases: [
        { title: "Layout", meta: "hero · pricing · footer", state: "done" },
        { title: "Copy pass", meta: "voice + proof points", state: "running" },
        { title: "Deploy preview", meta: "staging URL", state: "next" },
      ],
      checks: [
        { label: "Hero at 1440 and 390", done: true },
        { label: "Copy reviewed by main", done: false },
        { label: "Preview deployed", done: false },
      ],
      acceptance: "Waiting on the copy pass.",
    },
    {
      id: "m2",
      title: "Copy review · v3",
      desc: "Tighten the launch narrative and remove repeated claims.",
      column: "verify",
      progress: 80,
      meta: "marketing-site · round 3",
      labels: ["copy"],
      phases: [
        { title: "Draft", meta: "hero + proof", state: "done" },
        { title: "Review", meta: "tone + length", state: "running" },
      ],
      checks: [
        { label: "No duplicated claims", done: true },
        { label: "CTA is single and clear", done: false },
      ],
      acceptance: "One CTA conflict remains.",
    },
    {
      id: "m3",
      title: "Analytics wiring",
      desc: "Track signup, demo, and docs events.",
      column: "queued",
      progress: 0,
      meta: "marketing-site · backlog",
      labels: ["analytics"],
      phases: [{ title: "Event map", meta: "signup · demo · docs", state: "next" }],
      checks: [{ label: "Event names agreed", done: false }],
      acceptance: "Not started.",
    },
    {
      id: "m4",
      title: "Brand tokens",
      desc: "Lock the type scale, paper background, and accent.",
      column: "done",
      progress: 100,
      meta: "landed · yesterday",
      labels: ["design"],
      phases: [{ title: "Tokens", meta: "light + dark", state: "done" }],
      checks: [{ label: "Contrast checked", done: true }],
      acceptance: "Passed.",
    },
  ];

  const RESEARCH_TASKS = [
    {
      id: "s1",
      title: "Source scan",
      desc: "Scan the research queue for primary sources.",
      column: "executing",
      progress: 42,
      meta: "research-scout · scan/04",
      labels: ["research", "agent"],
      phases: [
        { title: "Collect", meta: "12 candidate sources", state: "done" },
        { title: "Verify", meta: "primary-source check", state: "running" },
        { title: "Summarize", meta: "scout note", state: "next" },
      ],
      checks: [
        { label: "Source dates captured", done: true },
        { label: "Primary sources only", done: false },
      ],
      acceptance: "Scan still running.",
    },
    {
      id: "s2",
      title: "Summary review",
      desc: "Check the scout summary against the source set.",
      column: "verify",
      progress: 75,
      meta: "research-scout · review",
      labels: ["review"],
      phases: [
        { title: "Draft summary", meta: "4 findings", state: "done" },
        { title: "Review", meta: "claims + citations", state: "running" },
      ],
      checks: [
        { label: "Every claim has a source", done: true },
        { label: "No stale references", done: false },
      ],
      acceptance: "One citation needs an update.",
    },
    {
      id: "s3",
      title: "Outreach list",
      desc: "Build a short list for the next research round.",
      column: "queued",
      progress: 0,
      meta: "research-scout · backlog",
      labels: ["outreach"],
      phases: [{ title: "Shortlist", meta: "5 names", state: "next" }],
      checks: [{ label: "No duplicates", done: false }],
      acceptance: "Not started.",
    },
    {
      id: "s4",
      title: "Clone policy",
      desc: "Document when a research clone becomes a workspace.",
      column: "done",
      progress: 100,
      meta: "landed · 2h ago",
      labels: ["policy"],
      phases: [{ title: "Policy note", meta: "lifecycle + merge", state: "done" }],
      checks: [{ label: "Published to wiki", done: true }],
      acceptance: "Passed.",
    },
  ];

  const MARKETING_RUNS = [
    {
      id: "m-run",
      code: "#m2a1",
      title: "Build landing page",
      repo: "marketing-site",
      branch: "feat/landing",
      status: "running",
      progress: 55,
      cost: "$0.42",
      tokens: "22.8k",
      nodes: "3/5",
      startedAt: Date.now() - 12 * 60 * 1000,
      steps: [
        { title: "Intake · bash", meta: "worktree ready", time: "00:01", state: "done" },
        { title: "Build · agent", meta: "hero + pricing", time: "06:18", state: "done" },
        { title: "Copy · agent", meta: "headline pass", time: "live", state: "running" },
        { title: "Preview · bash", meta: "pending", time: "next", state: "queued" },
      ],
      logs: [
        { time: "10:12:04", tag: "copy", text: "headline pass started · 2 variants", tone: "running" },
        { time: "10:09:31", tag: "build", text: "hero section compiled", tone: "done" },
        { time: "10:04:12", tag: "engine", text: "checkpoint saved", tone: "tool" },
      ],
    },
    {
      id: "m-run2",
      code: "#m2a2",
      title: "Copy acceptance",
      repo: "marketing-site",
      branch: "acceptance/copy",
      status: "waiting",
      progress: 80,
      cost: "$0.31",
      tokens: "18.4k",
      nodes: "4/5",
      elapsed: "18m",
      steps: [
        { title: "Compare variants", meta: "tone + length", time: "08:12", state: "done" },
        { title: "Human pick", meta: "one CTA", time: "18m", state: "waiting" },
      ],
      logs: [{ time: "10:14:22", tag: "accept", text: "two CTAs found · needs a decision", tone: "waiting" }],
    },
    {
      id: "m-run3",
      code: "#m2a3",
      title: "Deploy preview",
      repo: "marketing-site",
      branch: "deploy/preview",
      status: "queued",
      progress: 0,
      cost: "—",
      tokens: "—",
      nodes: "0/5",
      elapsed: "next",
      steps: [{ title: "Wait for build", meta: "preview URL", time: "next", state: "queued" }],
      logs: [{ time: "—", tag: "scheduler", text: "queued behind copy acceptance", tone: "tool" }],
    },
  ];

  const RESEARCH_RUNS = [
    {
      id: "s-run",
      code: "#s4c2",
      title: "Research scout",
      repo: "research-scout",
      branch: "scan/04",
      status: "running",
      progress: 42,
      cost: "$0.18",
      tokens: "12.1k",
      nodes: "2/5",
      startedAt: Date.now() - 9 * 60 * 1000,
      steps: [
        { title: "Collect · bash", meta: "12 sources", time: "00:01", state: "done" },
        { title: "Verify · agent", meta: "primary-source check", time: "live", state: "running" },
        { title: "Summarize · agent", meta: "pending", time: "next", state: "queued" },
      ],
      logs: [
        { time: "10:18:44", tag: "verify", text: "source 08 · primary check", tone: "running" },
        { time: "10:14:11", tag: "collect", text: "12 candidates found", tone: "done" },
      ],
    },
    {
      id: "s-run2",
      code: "#s4c3",
      title: "Source summary",
      repo: "research-scout",
      branch: "summary",
      status: "waiting",
      progress: 75,
      cost: "$0.12",
      tokens: "9.3k",
      nodes: "4/5",
      elapsed: "11m",
      steps: [
        { title: "Draft summary", meta: "4 findings", time: "06:40", state: "done" },
        { title: "Citation review", meta: "one stale ref", time: "11m", state: "waiting" },
      ],
      logs: [{ time: "10:16:09", tag: "review", text: "citation 03 needs an update", tone: "waiting" }],
    },
    {
      id: "s-run3",
      code: "#s4c1",
      title: "Archive sources",
      repo: "research-scout",
      branch: "archive",
      status: "done",
      progress: 100,
      cost: "$0.09",
      tokens: "5.6k",
      nodes: "5/5",
      elapsed: "4m",
      steps: [{ title: "Archive", meta: "12 sources stored", time: "4m", state: "done" }],
      logs: [{ time: "09:42:10", tag: "archive", text: "12 sources stored", tone: "done" }],
    },
  ];

  const SPACE_DATA = {
    "open-octopus": { tasks: null, runs: DEFAULT_RUNS, selectedTask: "t1", selectedRun: "r1" },
    "marketing-site": { tasks: MARKETING_TASKS, runs: MARKETING_RUNS, selectedTask: "m1", selectedRun: "m-run" },
    "research-scout": { tasks: RESEARCH_TASKS, runs: RESEARCH_RUNS, selectedTask: "s1", selectedRun: "s-run" },
  };

  const SPACES = [
    {
      id: "open-octopus",
      name: "open-octopus",
      subtitle: "main workspace",
      status: "2 active",
      accent: "#2f6b55",
      layout: [
        { app: "tasks", x: 18, y: 18, w: 780, h: 760 },
        { app: "runs", x: 808, y: 18, w: 620, h: 760 },
        { app: "task-detail", x: 980, y: 90, w: 420, h: 680, min: true },
        { app: "chat", x: 980, y: 90, w: 420, h: 610, min: true, global: true },
      ],
    },
    {
      id: "marketing-site",
      name: "marketing-site",
      subtitle: "site launch",
      status: "2 active",
      accent: "#a9772d",
      layout: [
        { app: "tasks", x: 18, y: 18, w: 750, h: 760 },
        { app: "wiki", x: 778, y: 18, w: 650, h: 760 },
        { app: "chat", x: 980, y: 90, w: 420, h: 610, min: true, global: true },
      ],
    },
    {
      id: "research-scout",
      name: "research-scout",
      subtitle: "research queue",
      status: "2 active",
      accent: "#4c6fa8",
      layout: [
        { app: "runs", x: 18, y: 18, w: 700, h: 760 },
        { app: "wiki", x: 728, y: 18, w: 700, h: 760 },
        { app: "chat", x: 980, y: 90, w: 420, h: 610, min: true, global: true },
      ],
    },
  ];

  const defaults = () => ({
    activeSpace: "open-octopus",
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
  if (!SPACES.some((space) => space.id === state.activeSpace)) state.activeSpace = SPACES[0].id;
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
  if (state.spaceData) {
    SPACES.forEach((space) => {
      const saved = state.spaceData[space.id];
      if (saved) SPACE_DATA[space.id] = { ...SPACE_DATA[space.id], ...saved };
    });
  }
  if (SPACE_DATA[state.activeSpace]) {
    SPACE_DATA[state.activeSpace].tasks = state.tasks;
    SPACE_DATA[state.activeSpace].selectedTask = state.selectedTask;
    if (!SPACE_DATA[state.activeSpace].runs.some((run) => run.id === state.selectedRun)) {
      state.selectedRun = SPACE_DATA[state.activeSpace].runs[0]?.id || state.selectedRun;
    }
    SPACE_DATA[state.activeSpace].selectedRun = state.selectedRun;
  }
  if (!SPACE_DATA["open-octopus"].tasks) {
    SPACE_DATA["open-octopus"].tasks = JSON.parse(JSON.stringify(DEFAULT_TASKS));
  }

  document.documentElement.dataset.theme = state.theme;

  const views = new Map();
  const scrollPositions = {};
  const wikiScroll = {};
  let saveTimer;
  let toastTimer;

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        activeSpace: state.activeSpace,
        open: state.open,
        recent: state.recent,
        main: state.main,
        side: state.side,
        split: state.split,
        theme: state.theme,
        spaceData: Object.fromEntries(SPACES.map((space) => [space.id, {
          tasks: SPACE_DATA[space.id].tasks,
          runs: SPACE_DATA[space.id].runs,
          selectedTask: SPACE_DATA[space.id].selectedTask,
          selectedRun: SPACE_DATA[space.id].selectedRun,
        }])),
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

  const chatLog = () => document.querySelector('.win[data-app="chat"] .chat-log');

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
    save();
  };

  const WINDOWS = {
    home: {
      label: "Today",
      icon: "home",
      subtitle: "Monday, 19 October",
      render() {
        const draft = state.chatDraft.trim() ? "Draft saved" : "Conversation preserved";
        const activeRuns = DEFAULT_RUNS.filter((run) => run.status === "running" || run.status === "waiting");
        const activeTasks = state.tasks.filter((task) => task.column !== "done").length;
        return `
          <div class="home">
            <div class="home-inner">
              <div class="home-head">
                <div>
                  <p class="kicker">Monday, 19 October</p>
                  <h2>Good afternoon.</h2>
                  <p class="lead">${activeRuns.length} runs are moving. ${activeTasks} tasks are active and one decision is waiting.</p>
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
                    ${activeRuns.slice(0, 2).map((run) => `
                      <button class="row row-button" data-open="runs">
                        <span class="row-icon">${icon(run.status === "waiting" ? "check" : "activity")}</span>
                        <span class="row-main">
                          <span class="row-title">${esc(run.title)}</span>
                          <span class="row-meta">${esc(run.repo)} · ${esc(run.branch)}</span>
                        </span>
                        <span class="row-side">
                          <span class="progress"><i style="width:${run.progress}%"></i></span>
                          <span class="state ${run.status === "waiting" ? "is-waiting" : "is-running"}">${RUN_STATUS[run.status].label}</span>
                        </span>
                      </button>`).join("") || `<div class="row"><span class="row-main"><span class="row-title">No active runs</span><span class="row-meta">The board is quiet.</span></span></div>`}
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
            <div class="chat-status"><span class="status-dot"></span><span>desktop-v4 · running in background · 68%</span></div>
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

    "task-detail": {
      label: "Task",
      icon: "check",
      subtitle: "task inspector",
      render() {
        return `<div class="task-detail task-detail-window">${taskDetailHTML(taskById(state.selectedTask))}</div>`;
      },
      mount(view) {
        view.addEventListener("click", (event) => {
          const action = event.target.closest("[data-task-action]")?.dataset.taskAction;
          if (!action) return;
          const task = taskById(state.selectedTask);
          if (!task) return;
          if (action === "approve") {
            task.column = "done";
            task.progress = 100;
            toast("Task approved · moved to Done");
          } else if (action === "reject") {
            task.column = "verify";
            task.progress = Math.max(40, task.progress || 0);
            toast("Task returned to Verify");
          } else if (action === "open-run") {
            state.selectedRun = DEFAULT_RUNS[0]?.id || "r1";
            SPACE_DATA[state.activeSpace].selectedRun = state.selectedRun;
            openApp("runs");
            refreshRunsView();
            save();
            return;
          }
          refreshTasks(windowFor("tasks", state.activeSpace)?.body);
          refreshTaskDetail();
          save();
        });
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
            SPACE_DATA[state.activeSpace].selectedTask = state.selectedTask;
            refreshTasks(view);
            openApp("task-detail");
            refreshTaskDetail();
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
            refreshTaskDetail();
            save();
            toast("Task approved · moved to Done");
          } else if (action === "reject") {
            task.column = "verify";
            task.progress = Math.max(40, task.progress || 0);
            refreshTasks(view);
            refreshTaskDetail();
            save();
            toast("Task returned to Verify");
          } else if (action === "open-run") {
            state.selectedRun = DEFAULT_RUNS[0]?.id || "r1";
            SPACE_DATA[state.activeSpace].selectedRun = state.selectedRun;
            openApp("runs");
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
          SPACE_DATA[state.activeSpace].selectedTask = task.id;
          refreshTasks(view);
          refreshTaskDetail();
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
          updateWindowChrome("wiki");
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
            SPACE_DATA[state.activeSpace].selectedRun = state.selectedRun;
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

    artifacts: {
      label: "Artifacts",
      icon: "folder",
      subtitle: "files from this space",
      render() {
        const rows = [
          { name: "spec.md", meta: "agent · 12m ago", size: "8.4 KB", kind: "SPEC" },
          { name: "acceptance-r2.md", meta: "acceptance · 42m ago", size: "4.1 KB", kind: "REPORT" },
          { name: "diff.patch", meta: "run #e2f1 · 18m ago", size: "62 KB", kind: "DIFF" },
          { name: "window-model.md", meta: "wiki · 1h ago", size: "6.2 KB", kind: "WIKI" },
          { name: "desktop-v4.css", meta: "build · 2h ago", size: "31 KB", kind: "CSS" },
        ];
        return `
          <div class="artifacts-view">
            <div class="spaces-head">
              <div>
                <p class="kicker">Workspace artifacts</p>
                <h2>Everything the agents produced.</h2>
                <p>Specs, reports, diffs, and compiled knowledge stay attached to this space.</p>
              </div>
              <button class="secondary" data-app-launch="wiki">Open wiki</button>
            </div>
            <div class="artifact-list">
              ${rows.map((row) => `
                <div class="artifact-row">
                  <span class="artifact-kind">${esc(row.kind)}</span>
                  <span class="artifact-main"><b>${esc(row.name)}</b><span>${esc(row.meta)}</span></span>
                  <span class="artifact-size">${esc(row.size)}</span>
                </div>`).join("")}
            </div>
            <div class="space-note">Artifacts are window-local views. The files keep existing after you close the window.</div>
          </div>`;
      },
    },

    spaces: {
      label: "Spaces",
      icon: "folder",
      subtitle: "project desktops",
      render() {
        return `
          <div class="spaces-view">
            <div class="spaces-head">
              <div>
                <p class="kicker">Project desktops</p>
                <h2>Switch context, keep windows.</h2>
                <p>Each space owns its layout. Runs and conversations keep going when you leave.</p>
              </div>
              <button class="secondary" data-action="reset">Reset layout</button>
            </div>
            <div class="spaces-list">
              ${SPACES.map((space) => `
                <button class="space-card ${space.id === state.activeSpace ? "is-active" : ""}" data-space-go="${space.id}">
                  <span class="space-dot" style="--space:${space.accent}"></span>
                  <span class="space-main">
                    <span class="space-name">${esc(space.name)}</span>
                    <span class="space-sub">${esc(space.subtitle)} · ${esc(space.status)}</span>
                  </span>
                  <span class="space-count">${space.layout.filter((item) => !item.min).length} windows</span>
                  ${icon("chevron-right")}
                </button>`).join("")}
            </div>
            <div class="space-note">Spaces are virtual desktops. The dock always shows the current space plus the global agent.</div>
          </div>`;
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
                  <div class="setting-title">Keyboard</div>
                  <div class="setting-meta">Command, agent, tile, spaces.</div>
                </div>
                <span class="setting-meta">⌘K · ⌘J · ⌥T · ⌥1–3</span>
              </div>
              <div class="setting-row">
                <div class="setting-main">
                  <div class="setting-title">Version</div>
                  <div class="setting-meta">Static interaction prototype.</div>
                </div>
                <span class="setting-meta">desktop-v4</span>
              </div>
            </div>
          </div>`;
      },
    },
  };

  const spaceById = (id) => SPACES.find((space) => space.id === id) || SPACES[0];
  const GLOBAL_APPS = new Set(["chat", "settings", "spaces"]);
  const APP_SIZES = {
    home: { w: 720, h: 580 },
    chat: { w: 420, h: 610 },
    tasks: { w: 700, h: 760 },
    runs: { w: 700, h: 760 },
    wiki: { w: 700, h: 760 },
    artifacts: { w: 560, h: 500 },
    spaces: { w: 620, h: 520 },
    settings: { w: 500, h: 440 },
  };

  const desktop = $("#desktop");
  const globalLayer = $("#global-layer");
  const snapPreview = $("#snap-preview");
  const windows = new Map();
  const initializedSpaces = new Set();
  let z = 40;
  let focused = null;
  let paletteIndex = 0;
  let paletteFiltered = [];
  let savedWindows = loadWindows();

  function loadWindows() {
    try {
      const raw = localStorage.getItem(WINDOW_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveWindows() {
    const data = { spaces: {}, globals: {} };
    windows.forEach((win) => {
      const record = {
        x: Math.round(win.rect.x),
        y: Math.round(win.rect.y),
        w: Math.round(win.rect.w),
        h: Math.round(win.rect.h),
        min: win.min,
        closed: win.closed,
        max: win.el.classList.contains("is-max"),
      };
      if (win.global) data.globals[win.app] = record;
      else {
        data.spaces[win.space] = data.spaces[win.space] || {};
        data.spaces[win.space][win.app] = record;
      }
    });
    try {
      localStorage.setItem(WINDOW_KEY, JSON.stringify(data));
      localStorage.setItem(SPACE_KEY, state.activeSpace);
    } catch {
      /* Prototype still works without storage. */
    }
  }

  const keyFor = (app, space) => `${GLOBAL_APPS.has(app) ? "global" : space}:${app}`;
  const windowFor = (app, space = state.activeSpace) => windows.get(keyFor(app, space));
  const layerFor = (app, space) =>
    GLOBAL_APPS.has(app) ? globalLayer : $(`.space-layer[data-space="${space}"]`);

  const appTitle = (app) => {
    if (app === "chat") return "main";
    if (app === "task-detail") return taskById(state.selectedTask)?.title || "Task";
    return WINDOWS[app].label;
  };

  const appSubtitle = (app) => {
    if (app === "task-detail") {
      const task = taskById(state.selectedTask);
      return task ? `${columnLabel(task.column)} · ${task.progress || 0}%` : "task inspector";
    }
    if (app === "tasks") {
      const open = state.tasks.filter((task) => task.column !== "done").length;
      const done = state.tasks.length - open;
      return `${open} open · ${done} done`;
    }
    if (app === "runs") {
      const active = DEFAULT_RUNS.filter((run) => run.status === "running" || run.status === "waiting").length;
      return `${active} active · ${DEFAULT_RUNS.length} today`;
    }
    if (app === "wiki") return `Design · ${WIKI_PAGES[state.wikiPage].title}`;
    if (app === "chat") return `ready · ${state.messages.length} messages`;
    if (app === "home") return "today";
    return WINDOWS[app].subtitle;
  };

  function setChrome(win) {
    if (!win) return;
    const title = $(".win-titles b", win.el);
    const sub = $(".win-titles span", win.el);
    if (title) title.textContent = appTitle(win.app);
    if (sub) sub.textContent = appSubtitle(win.app);
  }

  const updateWindowChrome = (app) => setChrome(windowFor(app, state.activeSpace));

  const refreshTasks = (view) => {
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
    updateWindowChrome("tasks");
  };

  const refreshRuns = (view) => {
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
    updateWindowChrome("runs");
  };

  const refreshRunsView = () => refreshRuns(windowFor("runs", state.activeSpace)?.body);

  const refreshTaskDetail = () => {
    const win = windowFor("task-detail", state.activeSpace);
    if (!win) return;
    win.body.innerHTML = WINDOWS["task-detail"].render();
    updateWindowChrome("task-detail");
  };

  function focusWindow(win, silent = false) {
    if (!win || win.closed) return;
    if (win.min) {
      win.min = false;
      win.el.classList.remove("is-min");
    }
    z += 1;
    win.el.style.zIndex = z;
    windows.forEach((item) => item.el.classList.remove("is-focused"));
    win.el.classList.add("is-focused");
    focused = win;
    if (!silent) {
      renderDock();
      saveWindows();
    }
  }

  function nextVisible(win) {
    const list = [...windows.values()].filter(
      (item) => !item.closed && !item.min && (item.global || item.space === state.activeSpace)
    );
    return list.find((item) => item !== win) || null;
  }

  function minimizeWindow(win, silent = false) {
    if (!win) return;
    win.min = true;
    win.el.classList.add("is-min");
    win.el.classList.remove("is-focused");
    if (focused === win) {
      focused = null;
      const next = nextVisible(win);
      if (next) focusWindow(next, true);
    }
    if (!silent) {
      renderDock();
      saveWindows();
    }
  }

  function closeWindow(win, silent = false) {
    if (!win) return;
    win.closed = true;
    win.el.classList.add("is-closed");
    win.el.classList.remove("is-focused");
    if (focused === win) {
      focused = null;
      const next = nextVisible(win);
      if (next) focusWindow(next, true);
    }
    if (!silent) {
      renderDock();
      saveWindows();
    }
  }

  function restoreWindow(win) {
    if (!win) return;
    win.closed = false;
    win.min = false;
    win.el.classList.remove("is-closed", "is-min");
    focusWindow(win);
  }

  function defaultGeometry(app, space) {
    const layout = spaceById(space).layout.find((item) => item.app === app);
    if (layout) return { ...layout };
    const size = APP_SIZES[app] || { w: 640, h: 480 };
    const dw = desktop.clientWidth || 1440;
    const dh = desktop.clientHeight || 790;
    return {
      x: Math.max(16, Math.round((dw - size.w) / 2)),
      y: Math.max(16, Math.round((dh - size.h) / 2)),
      w: size.w,
      h: size.h,
    };
  }

  function savedGeometry(app, space) {
    if (GLOBAL_APPS.has(app)) return savedWindows.globals?.[app];
    return savedWindows.spaces?.[space]?.[app];
  }

  function applyRect(win, x, y, width, height) {
    const dw = desktop.clientWidth || 1440;
    const dh = desktop.clientHeight || 790;
    const ww = clamp(width, 280, Math.max(280, dw - 12));
    const hh = clamp(height, 180, Math.max(180, dh - 12));
    const xx = clamp(x, -ww + 120, Math.max(8, dw - 90));
    const yy = clamp(y, 0, Math.max(8, dh - 48));
    win.rect = { x: Math.round(xx), y: Math.round(yy), w: Math.round(ww), h: Math.round(hh) };
    win.el.style.setProperty("--x", `${win.rect.x}px`);
    win.el.style.setProperty("--y", `${win.rect.y}px`);
    win.el.style.setProperty("--w", `${win.rect.w}px`);
    win.el.style.setProperty("--h", `${win.rect.h}px`);
  }

  function snapRect(kind) {
    const dw = desktop.clientWidth || 1440;
    const dh = desktop.clientHeight || 790;
    const pad = 8;
    const gap = 8;
    const h = dh - pad * 2;
    if (kind === "left") return { x: pad, y: pad, w: (dw - pad * 2 - gap) / 2, h };
    if (kind === "right") return { x: pad + (dw - pad * 2 - gap) / 2 + gap, y: pad, w: (dw - pad * 2 - gap) / 2, h };
    return { x: pad, y: pad, w: dw - pad * 2, h };
  }

  function showSnap(kind) {
    if (!kind) {
      snapPreview.classList.remove("is-on");
      return;
    }
    const rect = snapRect(kind);
    snapPreview.style.left = `${rect.x}px`;
    snapPreview.style.top = `${rect.y}px`;
    snapPreview.style.width = `${rect.w}px`;
    snapPreview.style.height = `${rect.h}px`;
    snapPreview.classList.add("is-on");
  }

  function snapAt(clientX, clientY) {
    const rect = desktop.getBoundingClientRect();
    if (clientY < rect.top + 24) return "top";
    if (clientX < rect.left + 24) return "left";
    if (clientX > rect.right - 24) return "right";
    return null;
  }

  function setupDrag(win) {
    const bar = $(".win-bar", win.el);
    let start = null;
    bar.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest(".win-actions")) return;
      focusWindow(win);
      if (win.el.classList.contains("is-max")) return;
      start = { px: event.clientX, py: event.clientY, ...win.rect };
      bar.setPointerCapture(event.pointerId);
      win.el.classList.add("is-dragging");
      event.preventDefault();

      const move = (ev) => {
        if (!start) return;
        applyRect(win, start.x + ev.clientX - start.px, start.y + ev.clientY - start.py, start.w, start.h);
        showSnap(snapAt(ev.clientX, ev.clientY));
      };
      const up = (ev) => {
        if (!start) return;
        const snap = snapAt(ev.clientX, ev.clientY);
        start = null;
        win.el.classList.remove("is-dragging");
        showSnap(null);
        if (snap) {
          const rect = snapRect(snap);
          applyRect(win, rect.x, rect.y, rect.w, rect.h);
          win.el.classList.remove("is-max");
        }
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
        bar.removeEventListener("pointercancel", up);
        saveWindows();
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
      bar.addEventListener("pointercancel", up);
    });

    bar.addEventListener("dblclick", (event) => {
      if (event.target.closest(".win-actions")) return;
      win.el.classList.toggle("is-max");
      saveWindows();
    });
  }

  function setupResize(win) {
    const handle = $(".win-resize", win.el);
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || win.el.classList.contains("is-max")) return;
      event.preventDefault();
      event.stopPropagation();
      focusWindow(win);
      const start = { px: event.clientX, py: event.clientY, ...win.rect };
      handle.setPointerCapture(event.pointerId);
      win.el.classList.add("is-dragging");
      const move = (ev) => {
        applyRect(win, start.x, start.y, start.w + ev.clientX - start.px, start.h + ev.clientY - start.py);
      };
      const up = () => {
        win.el.classList.remove("is-dragging");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        saveWindows();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  function createWindow(app, space, geometry) {
    const def = WINDOWS[app];
    const el = document.createElement("article");
    el.className = "win";
    el.dataset.app = app;
    el.dataset.space = space;
    el.innerHTML = `
      <header class="win-bar">
        <span class="win-icon">${icon(def.icon)}</span>
        <div class="win-titles"><b>${esc(appTitle(app))}</b><span>${esc(appSubtitle(app))}</span></div>
        <div class="win-actions">
          <button class="win-btn" data-wact="min" title="Minimize">${icon("minus")}</button>
          <button class="win-btn" data-wact="max" title="Maximize">${icon("square")}</button>
          <button class="win-btn" data-wact="close" title="Close">${icon("x")}</button>
        </div>
      </header>
      <div class="win-body view"></div>
      <div class="win-resize" title="Resize"></div>`;

    const body = $(".win-body", el);
    body.innerHTML = def.render();
    def.mount?.(body);

    const layer = layerFor(app, space);
    layer.appendChild(el);

    const win = {
      app,
      space,
      global: GLOBAL_APPS.has(app),
      el,
      body,
      rect: { x: 0, y: 0, w: 0, h: 0 },
      min: false,
      closed: false,
    };

    applyRect(win, geometry.x, geometry.y, geometry.w, geometry.h);
    if (geometry.max) el.classList.add("is-max");
    el.addEventListener("pointerdown", () => focusWindow(win), { passive: true });
    $('[data-wact="min"]', el).addEventListener("click", (event) => {
      event.stopPropagation();
      minimizeWindow(win);
    });
    $('[data-wact="max"]', el).addEventListener("click", (event) => {
      event.stopPropagation();
      el.classList.toggle("is-max");
      focusWindow(win);
      saveWindows();
    });
    $('[data-wact="close"]', el).addEventListener("click", (event) => {
      event.stopPropagation();
      closeWindow(win);
    });
    setupDrag(win);
    setupResize(win);
    windows.set(keyFor(app, space), win);
    return win;
  }

  function openApp(app, options = {}) {
    if (!WINDOWS[app]) return null;
    const space = options.space || state.activeSpace;
    const key = keyFor(app, space);
    const existing = windows.get(key);
    if (app === "chat" || app === "task-detail") {
      const other = windowFor(app === "chat" ? "task-detail" : "chat", space);
      if (other && !other.closed && !other.min && other !== existing) minimizeWindow(other, true);
    }
    if (existing) {
      if (existing.closed) existing.closed = false;
      if (existing.min) existing.min = false;
      existing.el.classList.remove("is-closed", "is-min");
      if (!options.silent) focusWindow(existing);
      renderDock();
      saveWindows();
      return existing;
    }
    const geometry = options.geometry || savedGeometry(app, space) || defaultGeometry(app, space);
    const win = createWindow(app, space, geometry);
    if (options.closed || geometry.closed) closeWindow(win, true);
    if (options.min || geometry.min) minimizeWindow(win, true);
    if (!options.silent && !win.closed && !win.min) focusWindow(win, true);
    renderDock();
    saveWindows();
    return win;
  }

  const openWindow = (app) => openApp(app);

  function focusTasks() {
    openApp("tasks");
    requestAnimationFrame(() => {
      windowFor("tasks", state.activeSpace)?.body.querySelector(".lane-add input")?.focus();
    });
  }

  function updateTopbar() {
    const space = spaceById(state.activeSpace);
    $("#space-name").textContent = space.name;
    $("#space-dot").style.background = space.accent;
    const activeRuns = DEFAULT_RUNS.filter((run) => run.status === "running" || run.status === "waiting").length;
    $("#running-label").textContent = `${activeRuns} active`;
    document.title = `Octopus — ${space.name}`;
  }

  function renderDock() {
    const dock = $("#dock-items");
    const list = [...windows.values()]
      .filter((win) => !win.closed && (win.global || win.space === state.activeSpace))
      .sort((a, b) => {
        const rank = { tasks: 0, runs: 1, "task-detail": 2, wiki: 3, home: 4, spaces: 5, settings: 6, chat: 7 };
        return (rank[a.app] ?? 9) - (rank[b.app] ?? 9);
      });
    if (!list.length) {
      dock.innerHTML = `<span class="dock-empty">No open windows</span>`;
      return;
    }
    dock.innerHTML = list.map((win) => `
      <button class="dock-item ${win === focused ? "is-active" : ""} ${win.min ? "is-min" : ""}" data-dock-key="${esc(win.el.dataset.app)}:${esc(win.global ? "global" : win.space)}" title="${esc(appTitle(win.app))}">
        ${icon(WINDOWS[win.app].icon)}
        <span>${esc(WINDOWS[win.app].label)}</span>
        ${win.app === "runs" ? `<i class="dock-live"></i>` : ""}
      </button>`).join("");
  }

  function ensureGlobals() {
    const saved = savedWindows.globals || {};
    if (saved.chat) {
      openApp("chat", { geometry: saved.chat, min: saved.chat.min, closed: saved.chat.closed, silent: true });
    } else {
      openApp("chat", { geometry: defaultGeometry("chat", "open-octopus"), min: true, silent: true });
    }
  }

  function applySpaceData(id) {
    const data = SPACE_DATA[id];
    if (!data) return;
    state.tasks = data.tasks || state.tasks;
    state.selectedTask = data.selectedTask || state.tasks[0]?.id || null;
    state.selectedRun = data.selectedRun || data.runs[0]?.id || "r1";
    DEFAULT_RUNS = data.runs;
  }

  function refreshSpaceWindows(id) {
    windows.forEach((win) => {
      if (win.space !== id) return;
      if (win.app === "tasks") refreshTasks(win.body);
      else if (win.app === "runs") refreshRuns(win.body);
      else if (win.app === "task-detail") refreshTaskDetail();
      else if (win.app === "home") win.body.innerHTML = WINDOWS.home.render();
    });
  }

  function ensureSpace(id) {
    if (initializedSpaces.has(id)) return;
    const saved = savedWindows.spaces?.[id];
    if (saved) {
      Object.entries(saved).forEach(([app, geometry]) => {
        openApp(app, { space: id, geometry, min: geometry.min, closed: geometry.closed, silent: true });
      });
    } else {
      spaceById(id).layout
        .filter((item) => !GLOBAL_APPS.has(item.app))
        .forEach((item) => {
          openApp(item.app, { space: id, geometry: item, min: item.min, closed: item.closed, silent: true });
        });
    }
    initializedSpaces.add(id);
  }

  function switchSpace(id) {
    const space = spaceById(id);
    if (!space) return;
    const changed = state.activeSpace !== id;
    state.activeSpace = id;
    document.querySelectorAll(".space-layer").forEach((layer) => {
      layer.hidden = layer.dataset.space !== id;
    });
    applySpaceData(id);
    ensureSpace(id);
    refreshSpaceWindows(id);
    updateTopbar();
    if (changed) focused = null;
    const first = [...windows.values()].find(
      (win) => !win.global && win.space === id && !win.min && !win.closed
    );
    if (!focused || (focused.space !== id && !focused.global)) {
      if (first) focusWindow(first, true);
    }
    renderDock();
    closeSpaceMenu();
    saveWindows();
    save();
  }

  function visibleSpaceWindows() {
    return [...windows.values()].filter(
      (win) => !win.closed && (win.global || win.space === state.activeSpace)
    );
  }

  function tileWindows() {
    const list = visibleSpaceWindows().filter((win) => !win.min && !win.global);
    if (!list.length) return;
    const dw = desktop.clientWidth;
    const dh = desktop.clientHeight;
    const pad = 10;
    const gap = 10;
    const cols = list.length === 1 ? 1 : 2;
    const rows = Math.ceil(list.length / cols);
    const ww = (dw - pad * 2 - gap * (cols - 1)) / cols;
    const hh = (dh - pad * 2 - gap * (rows - 1)) / rows;
    list.forEach((win, index) => {
      win.el.classList.remove("is-min", "is-max");
      applyRect(win, pad + (index % cols) * (ww + gap), pad + Math.floor(index / cols) * (hh + gap), ww, hh);
    });
    renderDock();
    saveWindows();
    toast("Windows tiled");
  }

  function cascadeWindows() {
    const list = visibleSpaceWindows().filter((win) => !win.min && !win.global);
    const width = Math.min(760, desktop.clientWidth - 140);
    const height = Math.min(600, desktop.clientHeight - 100);
    list.forEach((win, index) => {
      win.el.classList.remove("is-min", "is-max");
      applyRect(win, 18 + index * 28, 18 + index * 24, width, height);
      z += 1;
      win.el.style.zIndex = z;
    });
    saveWindows();
  }

  function showOverlay(id) {
    closeSpaceMenu();
    closeNotifications();
    document.querySelectorAll(".overlay").forEach((overlay) => {
      const active = overlay.id === id;
      overlay.classList.toggle("is-open", active);
      overlay.setAttribute("aria-hidden", String(!active));
    });
  }

  function closeOverlay(id) {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.classList.remove("is-open");
    overlay.setAttribute("aria-hidden", "true");
  }

  const closePalette = () => closeOverlay("palette");
  const closeMission = () => closeOverlay("mission");
  const closeLauncher = () => closeOverlay("launcher");

  function renderLauncher() {
    const apps = ["home", "tasks", "runs", "wiki", "artifacts", "spaces", "chat", "settings"];
    $("#launcher-grid").innerHTML = apps.map((app) => `
      <button class="launcher-item" data-app-launch="${app}">
        <span class="launcher-icon">${icon(WINDOWS[app].icon)}</span>
        <span class="launcher-name">${esc(app === "chat" ? "Main agent" : WINDOWS[app].label)}</span>
        <span class="launcher-sub">${esc(appSubtitle(app))}</span>
      </button>`).join("");
  }

  function openLauncher() {
    renderLauncher();
    showOverlay("launcher");
  }

  function paletteItems() {
    const items = [];
    windows.forEach((win) => {
      if (win.space !== state.activeSpace && !win.global) return;
      items.push({
        group: "Windows",
        label: appTitle(win.app),
        hint: win.closed ? "closed" : win.min ? "minimized" : "open",
        icon: WINDOWS[win.app].icon,
        run: () => {
          if (win.closed) restoreWindow(win);
          else focusWindow(win);
        },
      });
    });
    ["home", "tasks", "runs", "wiki", "artifacts", "spaces", "chat", "settings"].forEach((app) => {
      items.push({
        group: "Apps",
        label: app === "chat" ? "Main agent" : WINDOWS[app].label,
        hint: "open",
        icon: WINDOWS[app].icon,
        run: () => openApp(app),
      });
    });
    SPACES.forEach((space) => {
      items.push({
        group: "Spaces",
        label: space.name,
        hint: space.subtitle,
        icon: "folder",
        run: () => switchSpace(space.id),
      });
    });
    items.push(
      { group: "Actions", label: "Mission Control", hint: "All open windows", icon: "grid", run: openMission },
      { group: "Actions", label: "Tile windows", hint: "Fill the desktop", icon: "columns", run: tileWindows },
      { group: "Actions", label: "Cascade windows", hint: "Stack windows", icon: "layers", run: cascadeWindows },
      { group: "Actions", label: "Toggle theme", hint: "Paper / graphite", icon: "moon", run: toggleTheme },
      { group: "Actions", label: "Settings", hint: "Theme and reset", icon: "settings", run: () => openApp("settings") }
    );
    return items;
  }

  function renderPalette() {
    const input = $("#palette-input");
    const query = input.value.trim();
    const q = query.toLowerCase();
    const all = paletteItems();
    paletteFiltered = all.filter((item) => !q || `${item.label} ${item.hint} ${item.group}`.toLowerCase().includes(q));
    if (query) {
      paletteFiltered.unshift({
        group: "Ask",
        label: `Ask main: ${query}`,
        hint: "send to the agent",
        icon: "message",
        run: () => askMain(query),
      });
    }
    paletteIndex = clamp(paletteIndex, 0, Math.max(0, paletteFiltered.length - 1));
    let group = "";
    let html = "";
    paletteFiltered.forEach((item, index) => {
      if (item.group !== group) {
        group = item.group;
        html += `<div class="palette-group">${group}</div>`;
      }
      html += `
        <button class="palette-item ${index === paletteIndex ? "is-selected" : ""}" data-palette-index="${index}">
          ${icon(item.icon)}
          <span class="palette-label">${esc(item.label)}<span>${esc(item.hint)}</span></span>
        </button>`;
    });
    $("#palette-list").innerHTML = html || `<div class="palette-empty">No matches</div>`;
  }

  function openPalette() {
    showOverlay("palette");
    const input = $("#palette-input");
    input.value = "";
    paletteIndex = 0;
    renderPalette();
    requestAnimationFrame(() => input.focus());
  }

  function openMission() {
    const grid = $("#mission-grid");
    const list = visibleSpaceWindows();
    grid.innerHTML = list.map((win) => `
      <button class="mission-card ${win.min ? "is-min" : ""}" data-mission-key="${esc(win.el.dataset.app)}:${esc(win.global ? "global" : win.space)}">
        <span class="mission-preview"></span>
        <span class="mission-meta">
          <span class="mission-icon">${icon(WINDOWS[win.app].icon)}</span>
          <span class="mission-name">${esc(appTitle(win.app))}<span>${esc(win.min ? "minimized" : appSubtitle(win.app))}</span></span>
          ${icon("arrow-up-right")}
        </span>
      </button>`).join("");
    showOverlay("mission");
    list.forEach((win, index) => {
      const card = grid.children[index];
      const preview = $(".mission-preview", card);
      requestAnimationFrame(() => {
        const rect = win.rect;
        const pw = preview.clientWidth || 300;
        const ph = preview.clientHeight || 170;
        const scale = Math.min(pw / rect.w, ph / rect.h, 1);
        const clone = win.el.cloneNode(true);
        clone.classList.remove("is-focused", "is-min", "is-max", "is-closed", "is-dragging");
        clone.classList.add("mc-clone");
        clone.style.left = `${(pw - rect.w * scale) / 2}px`;
        clone.style.top = `${(ph - rect.h * scale) / 2}px`;
        clone.style.width = `${rect.w}px`;
        clone.style.height = `${rect.h}px`;
        clone.style.transform = `scale(${scale})`;
        clone.style.transformOrigin = "top left";
        preview.appendChild(clone);
      });
    });
  }

  function buildSpaceMenu() {
    const menu = $("#space-menu");
    menu.innerHTML = `
      <div class="panel-head">Spaces</div>
      ${SPACES.map((space) => `
        <button class="space-menu-row ${space.id === state.activeSpace ? "is-active" : ""}" data-space-switch="${space.id}">
          <span class="space-dot" style="background:${space.accent}"></span>
          <span class="space-menu-main"><b>${esc(space.name)}</b><span>${esc(space.subtitle)} · ${esc(space.status)}</span></span>
          ${icon("chevron-right")}
        </button>`).join("")}
      <div class="panel-foot">Each space keeps its own windows.</div>`;
    menu.hidden = false;
    closeNotifications();
  }

  function closeSpaceMenu() {
    const menu = $("#space-menu");
    if (menu) menu.hidden = true;
  }

  function buildNotifications() {
    const panel = $("#notifications");
    panel.innerHTML = `
      <div class="panel-head">Notifications</div>
      <button class="notification-row" data-open-app="tasks">
        <span class="notif-icon">${icon("shield")}</span>
        <span class="notif-main"><b>Approve deploy to production</b><span>harness guard · 40m left</span></span>
        ${icon("chevron-right")}
      </button>
      <button class="notification-row" data-open-app="tasks">
        <span class="notif-icon">${icon("kanban")}</span>
        <span class="notif-main"><b>Acceptance needs you</b><span>one focus-order defect</span></span>
        ${icon("chevron-right")}
      </button>
      <div class="panel-foot">Approvals stay visible while you work.</div>`;
    panel.hidden = false;
    closeSpaceMenu();
  }

  function closeNotifications() {
    const panel = $("#notifications");
    if (panel) panel.hidden = true;
  }

  function toggleTheme() {
    state.theme = state.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = state.theme;
    save();
    toast(state.theme === "dark" ? "Graphite dark" : "Warm paper light");
  }

  function askMain(text) {
    const win = openApp("chat");
    const time = timeLabel();
    const message = { role: "user", text, time };
    state.messages.push(message);
    const log = win?.body.querySelector(".chat-log");
    if (log) {
      log.insertAdjacentHTML("beforeend", messageHTML(message));
      log.scrollTop = log.scrollHeight;
    }
    save();
    updateWindowChrome("chat");
    closePalette();
    setTimeout(() => {
      const reply = { role: "agent", text: "I have the desktop context. I’ll keep this thread here while you work.", time: timeLabel() };
      state.messages.push(reply);
      const target = windowFor("chat")?.body.querySelector(".chat-log");
      if (target) {
        target.insertAdjacentHTML("beforeend", messageHTML(reply));
        target.scrollTop = target.scrollHeight;
      }
      save();
      updateWindowChrome("chat");
    }, 700);
  }

  document.addEventListener("click", (event) => {
    const actionEl = event.target.closest("[data-action]");
    if (actionEl) {
      const action = actionEl.dataset.action;
      if (action === "palette") openPalette();
      else if (action === "agent") openApp("chat");
      else if (action === "launcher") openLauncher();
      else if (action === "mission") openMission();
      else if (action === "space-menu") buildSpaceMenu();
      else if (action === "notifications") buildNotifications();
      else if (action === "open-runs") openApp("runs");
      else if (action === "theme") toggleTheme();
      else if (action === "tile") tileWindows();
      else if (action === "cascade") cascadeWindows();
      else if (action === "close-launcher") closeLauncher();
      else if (action === "close-mission") closeMission();
      else if (action === "reset") {
        localStorage.removeItem(KEY);
        localStorage.removeItem(WINDOW_KEY);
        localStorage.removeItem(SPACE_KEY);
        location.reload();
      }
      return;
    }

    const launch = event.target.closest("[data-app-launch]");
    if (launch) {
      openApp(launch.dataset.appLaunch);
      closeLauncher();
      return;
    }

    if (event.target.closest("[data-new-task]")) {
      focusTasks();
      return;
    }

    const open = event.target.closest("[data-open]");
    if (open) {
      event.preventDefault();
      openApp(open.dataset.open);
      return;
    }

    const dock = event.target.closest("[data-dock-key]");
    if (dock) {
      const [app, scope] = dock.dataset.dockKey.split(":");
      const win = windows.get(scope === "global" ? `global:${app}` : `${scope}:${app}`);
      if (!win) return;
      if (win.closed) restoreWindow(win);
      else if (win.min) focusWindow(win);
      else if (focused === win) minimizeWindow(win);
      else focusWindow(win);
      return;
    }

    const spaceSwitch = event.target.closest("[data-space-switch]");
    if (spaceSwitch) {
      switchSpace(spaceSwitch.dataset.spaceSwitch);
      return;
    }

    const spaceGo = event.target.closest("[data-space-go]");
    if (spaceGo) {
      switchSpace(spaceGo.dataset.spaceGo);
      return;
    }

    const openAppButton = event.target.closest("[data-open-app]");
    if (openAppButton) {
      openApp(openAppButton.dataset.openApp);
      closeNotifications();
      return;
    }

    const missionCard = event.target.closest("[data-mission-key]");
    if (missionCard) {
      const [app, scope] = missionCard.dataset.missionKey.split(":");
      const win = windows.get(scope === "global" ? `global:${app}` : `${scope}:${app}`);
      closeMission();
      if (win) restoreWindow(win);
      return;
    }

    if (event.target.classList.contains("overlay")) {
      closePalette();
      closeMission();
      closeLauncher();
    }

    if (!event.target.closest("#space-menu") && !event.target.closest('[data-action="space-menu"]')) {
      closeSpaceMenu();
    }
    if (!event.target.closest("#notifications") && !event.target.closest('[data-action="notifications"]')) {
      closeNotifications();
    }
  });

  $("#palette").addEventListener("input", (event) => {
    if (event.target.id === "palette-input") {
      paletteIndex = 0;
      renderPalette();
    }
  });

  $("#palette").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!paletteFiltered.length) return;
      paletteIndex = (paletteIndex + 1) % paletteFiltered.length;
      renderPalette();
      $(".palette-item.is-selected")?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!paletteFiltered.length) return;
      paletteIndex = (paletteIndex - 1 + paletteFiltered.length) % paletteFiltered.length;
      renderPalette();
      $(".palette-item.is-selected")?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = paletteFiltered[paletteIndex];
      if (item) {
        closePalette();
        item.run();
      }
    } else if (event.key === "Escape") {
      closePalette();
    }
  });

  $("#palette").addEventListener("click", (event) => {
    const item = event.target.closest("[data-palette-index]");
    if (!item) return;
    const target = paletteFiltered[Number(item.dataset.paletteIndex)];
    if (!target) return;
    closePalette();
    target.run();
  });

  document.addEventListener("keydown", (event) => {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (mod && key === "k") {
      event.preventDefault();
      $("#palette").classList.contains("is-open") ? closePalette() : openPalette();
      return;
    }
    if (mod && key === "j") {
      event.preventDefault();
      openApp("chat");
      return;
    }
    if (mod && event.shiftKey && key === "m") {
      event.preventDefault();
      $("#mission").classList.contains("is-open") ? closeMission() : openMission();
      return;
    }
    if (event.altKey && key === "t") {
      event.preventDefault();
      tileWindows();
      return;
    }
    if (event.altKey && ["1", "2", "3"].includes(event.key)) {
      event.preventDefault();
      const space = SPACES[Number(event.key) - 1];
      if (space) switchSpace(space.id);
      return;
    }
    if (event.key === "Escape") {
      closePalette();
      closeMission();
      closeLauncher();
      closeSpaceMenu();
      closeNotifications();
    }
  });

  window.addEventListener("resize", () => {
    windows.forEach((win) => {
      const dw = desktop.clientWidth;
      const dh = desktop.clientHeight;
      if (win.rect.x > dw - 100) applyRect(win, Math.max(8, dw - win.rect.w - 12), win.rect.y, win.rect.w, win.rect.h);
      if (win.rect.y > dh - 60) applyRect(win, win.rect.x, Math.max(8, dh - win.rect.h - 12), win.rect.w, win.rect.h);
    });
  });

  window.addEventListener("beforeunload", saveWindows);

  const initialSpace = spaceById(localStorage.getItem(SPACE_KEY) || state.activeSpace);
  state.activeSpace = initialSpace.id;
  document.querySelectorAll(".space-layer").forEach((layer) => {
    layer.hidden = layer.dataset.space !== initialSpace.id;
  });
  applySpaceData(initialSpace.id);
  ensureGlobals();
  ensureSpace(initialSpace.id);
  updateTopbar();
  const firstWindow = [...windows.values()].find(
    (win) => !win.global && win.space === initialSpace.id && !win.min && !win.closed
  );
  if (firstWindow) focusWindow(firstWindow, true);
  renderDock();
  save();
})();
