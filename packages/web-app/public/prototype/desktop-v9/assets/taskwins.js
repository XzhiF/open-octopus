/* ============================================================
   V9 — Tasks owns the execution surface.
   Task -> Workspace window -> Run window. No global Spaces/Runs nav.
   ============================================================ */
(function () {
  "use strict";

  const App = window.App;
  const $ = (s, r) => (r || document).querySelector(s);
  const ico = (name, cls = "") => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const data = App.data;
  const spaceById = (id) => data.spaces.find((s) => s.id === id);
  const runById = (id) => data.runs.find((r) => r.id === id);

  const TASKS = {
    mobile: {
      id: "mobile", title: "Mobile compact mode", pitch: "窄屏下把窗口折叠成栈，只保留当前任务与最近一次 Execution。",
      status: "draft", progress: 8, tag: "authoring", spaceIds: ["feat-desktop-shell"], runIds: [],
    },
    "run-compare": {
      id: "run-compare", title: "Run compare view", pitch: "并排比较两次 Run 的 token 曲线、节点耗时与失败位置。",
      status: "draft", progress: 0, tag: "v4", spaceIds: ["main"], runIds: ["e2e8"],
    },
    dock: {
      id: "dock", title: "Restore dock hover tips", pitch: "Shelf 图标需要可读标题、运行状态和最近一次 Run。",
      status: "queued", progress: 0, tag: "queued", spaceIds: ["feat-desktop-shell"], runIds: ["e2e1"],
    },
    scheduler: {
      id: "scheduler", title: "Scheduler · cost guard", pitch: "夜间编译超过 $2 时暂停，并把原因写进下一次 Run。",
      status: "queued", progress: 0, tag: "workflow", spaceIds: ["main"], runIds: ["e2e9"],
    },
    desktop: {
      id: "desktop", title: "Desktop multi-window redesign", pitch: "Windowed workbench, dock, mission control, 10 scenes.",
      status: "executing", progress: 68, tag: "frontend-design", spaceIds: ["feat-desktop-shell"], runIds: ["e2f1", "e2ef", "e2e4", "e2e1"],
    },
    wiki: {
      id: "wiki", title: "Wiki compile · ADR-0034", pitch: "把 window model decisions 编译成 cases page，保留可追溯引用。",
      status: "executing", progress: 45, tag: "agent", spaceIds: ["research-scout"], runIds: ["e2e2"],
    },
    acceptance: {
      id: "acceptance", title: "Acceptance · r2 walkthrough", pitch: "4/5 probes pass. One draft: keyboard focus order.",
      status: "waiting", progress: 80, tag: "needs you", spaceIds: ["feat-desktop-shell"], runIds: ["e2e4"],
    },
    state: {
      id: "state", title: "Window state persistence", pitch: "localStorage per scene · position/size/min/max.",
      status: "passed", progress: 100, tag: "passed", spaceIds: ["main"], runIds: ["e2e9"],
    },
    palette: {
      id: "palette", title: "Command palette", pitch: "⌘K over windows, spaces and layout actions.",
      status: "passed", progress: 100, tag: "passed", spaceIds: ["feat-desktop-shell"], runIds: ["e2ef"],
    },
  };

  const TASK_STATUS = {
    draft: { label: "draft", pill: "" },
    queued: { label: "queued", pill: "blue" },
    executing: { label: "executing", pill: "amber" },
    waiting: { label: "waiting", pill: "purple" },
    passed: { label: "passed", pill: "green" },
  };
  const RUN_LABEL = {
    running: "running", passed: "passed", failed: "failed", waiting: "waiting",
  };
  const SPACE_META = {
    "feat-desktop-shell": { server: 3101, web: 3100, db: "octopus-feat-desktop.db" },
    "research-scout": { server: 3111, web: 3110, db: "octopus-research.db" },
    main: { server: 3001, web: 3000, db: "octopus.db" },
  };
  const state = {};

  function taskRuns(task) {
    return task.runIds.map(runById).filter(Boolean);
  }
  function activeSpace(taskId) {
    const task = TASKS[taskId];
    if (!task) return null;
    if (!state[taskId]?.spaceId || !task.spaceIds.includes(state[taskId].spaceId)) return task.spaceIds[0] || null;
    return state[taskId].spaceId;
  }
  function money(n) { return "$" + Number(n || 0).toFixed(2); }
  function totalCost(runs) { return money(runs.reduce((n, r) => n + parseFloat(String(r.cost).replace("$", "")), 0)); }
  function stepStates(status, count = 6) {
    const order = ["queued", "queued", "queued", "queued", "queued", "queued"];
    if (status === "passed") return order.map(() => "done");
    if (status === "failed") return ["done", "done", "done", "done", "failed", "queued"];
    if (status === "running") return ["done", "done", "running", "queued", "queued", "queued"];
    if (status === "waiting") return ["done", "done", "done", "queued", "queued", "queued"];
    return order;
  }
  function flowNodes(states) {
    const defs = [
      ["Intake", "bash"], ["Plan", "agent"], ["Build", "agent"],
      ["Review", "swarm"], ["Verify", "acceptance"], ["Deliver", "approval"],
    ];
    return defs.map(([name, type], i) => `<div class="tw-flow-node is-${states[i]}"><b>${name}</b><span>${type}</span></div>`).join('<span class="tw-flow-line is-queued"></span>');
  }
  function logRows(run) {
    if (!run) return [];
    if (run.status === "failed") return [
      ["09:41:02", "err", "verify 4/5 failed · keyboard focus visible on dialog"],
      ["09:40:58", "ok", "fix completed · +42 lines"],
      ["09:40:21", "info", "review consensus 0.86 · 2 experts agreed"],
      ["09:39:44", "ok", "pnpm lint --filter web-app · exit 0"],
    ];
    if (run.status === "running") return [
      ["09:44:12", "info", "verify running · probe 4/5 keyboard focus"],
      ["09:43:51", "ok", "review consensus 0.91 · 3 experts agreed"],
      ["09:42:06", "ok", "build completed · 8 files changed"],
      ["09:39:40", "info", "plan produced 3 phases / 12 tickets"],
    ];
    if (run.status === "waiting") return [
      ["09:48:00", "warn", "approval gate · waiting for review"],
      ["09:47:12", "ok", "verify 4/5 probes passed"],
      ["09:44:30", "info", "review consensus 0.84"],
    ];
    return [
      ["11:18:03", "ok", "deliver · PR #214 merged"],
      ["11:16:40", "ok", "verify 5/5 probes passed"],
      ["11:12:19", "info", "review consensus 0.91"],
      ["11:06:02", "ok", "build completed · 8 files changed"],
    ];
  }
  function runSteps(run) {
    const states = stepStates(run?.status);
    const defs = [
      ["Intake", "bash", "worktree + 环境检查", "1.2s"],
      ["Plan", "agent", "Spec → phases / tickets", "2m 14s"],
      ["Build", "agent", run?.phase || "build", "14m 08s"],
      ["Review", "swarm", "debate · consensus", "4m 21s"],
      ["Verify", "acceptance", run?.status === "failed" ? "4/5 probes · failed" : "4/5 probes", "42s"],
      ["Deliver", "approval", run?.status === "passed" ? "PR #214 merged" : "waiting approval", "—"],
    ];
    return defs.map(([name, type, sub, time], i) => ({ name, type, sub, time, state: states[i] }));
  }

  function renderTask(taskId) {
    const task = TASKS[taskId];
    if (!task) return "";
    const spaceId = activeSpace(taskId);
    const space = spaceId ? spaceById(spaceId) : null;
    const runs = taskRuns(task);
    const latest = runs[0] || null;
    const stateLabel = TASK_STATUS[task.status] || TASK_STATUS.draft;
    const meta = spaceId ? SPACE_META[spaceId] || {} : {};
    const spaces = task.spaceIds.map(spaceById).filter(Boolean);
    return `<div class="tw">
      <div class="tw-top">
        <div class="tw-top-main">
          <div class="tw-kicker"><span>Task</span><span>·</span><span>${esc(task.id)}</span><span class="pill ${stateLabel.pill}" style="height:18px;font-size:9px">${stateLabel.label}</span></div>
          <h2>${esc(task.title)}</h2>
          <p>${esc(task.pitch)}</p>
        </div>
        <div class="tw-top-side">
          <div class="row tight"><span class="pill">${esc(task.tag)}</span><span class="pill">${runs.length} runs</span></div>
          <button class="btn btn-sm" data-task-action="queue">${ico("play", "sm")}Queue next run</button>
        </div>
      </div>
      <div class="tw-facts">
        <div class="tw-fact"><span>Progress</span><b>${task.progress}%</b><div class="bar ${task.status === "executing" ? "amber" : task.status === "passed" ? "green" : ""}"><i style="width:${task.progress}%"></i></div></div>
        <div class="tw-fact"><span>Executions</span><b>${runs.length}</b><small>${runs.filter((r) => r.status === "running").length} live · ${runs.filter((r) => r.status === "failed").length} failed</small></div>
        <div class="tw-fact"><span>Spend</span><b>${totalCost(runs)}</b><small>${runs.reduce((n, r) => n + (r.status === "running" ? 1 : 0), 0)} active attempts</small></div>
        <div class="tw-fact"><span>Workspace</span><b>${space ? esc(space.name) : "—"}</b><small>${space ? esc(space.branch) : "not attached"}</small></div>
      </div>
      ${space ? `<div class="tw-spacebar">
        <div class="tw-space-main"><span class="tw-space-icon">${ico("git-branch")}</span><div><b>${esc(space.name)}</b><span>${esc(space.branch)} · ${esc(space.activity)}</span></div></div>
        <div class="tw-space-facts"><span class="pill">server :${meta.server}</span><span class="pill">web :${meta.web}</span><span class="pill">${esc(meta.db || "—")}</span></div>
      </div>` : ""}
      <div class="tw-body">
        <aside class="tw-runs">
          <div class="tw-runs-head"><span>Runs</span><span class="count">${runs.length}</span><span class="spacer"></span><span>click to open</span></div>
          ${runs.length ? `<div class="tw-run-list">
            ${runs.map((r) => `<button class="tw-run ${r.id === latest?.id ? "is-active" : ""}" data-open-run data-task-id="${task.id}" data-run-id="${r.id}">
              <i class="tw-dot is-${r.status}"></i>
              <span class="tw-run-copy"><b class="mono">#${esc(r.id)}</b><span>${esc(r.phase)}</span></span>
              <span class="tw-run-side"><span class="tw-run-state is-${r.status}">${RUN_LABEL[r.status] || r.status}</span><span>${esc(r.nodes)}</span></span>
            </button>`).join("")}
          </div>` : `<div class="tw-empty" style="border:0;background:transparent;padding:22px 12px">${ico("activity")}<b>还没有 Execution</b><span>Queue 一次 Run 后，这里会出现执行现场。</span></div>`}
        </aside>
        <section class="tw-stage">
          ${space ? `<div class="tw-stage-head"><b>${esc(space.name)}</b><span>workspace</span><span class="spacer"></span><span class="tw-stage-live"><i></i>live context</span></div>
            <div class="tw-flow">${flowNodes(stepStates(latest?.status || "waiting"))}</div>
            <div class="tw-terminal">
              <div class="tw-terminal-head">${ico("terminal")}<span>terminal</span><span class="spacer"></span><span class="mono">${esc(space.branch)}</span></div>
              <div class="tw-terminal-body"><span class="prompt">$</span> octopus task open ${esc(task.id)}<br><span class="ok">● workspace attached</span> · ${esc(space.name)}<br><span style="color:var(--text-4)">${esc(space.branch)} @ :${meta.server} · ${esc(meta.db || "")}</span></div>
            </div>` : `<div class="tw-empty">${ico("git-branch")}<b>没有 Workspace</b><span>Task 还没有绑定执行环境。</span></div>`}
        </section>
      </div>
      ${spaces.length > 1 ? `<div class="row wrap" style="margin-top:9px;gap:4px">${spaces.map((s) => `<button class="pill ${s.id === spaceId ? "accent" : ""}" data-open-space data-task-id="${task.id}" data-space-id="${s.id}">${esc(s.name)}</button>`).join("")}</div>` : ""}
    </div>`;
  }

  function openTask(taskId) {
    const task = TASKS[taskId];
    if (!task) return;
    const spaceId = activeSpace(taskId);
    const space = spaceId ? spaceById(spaceId) : null;
    const win = App.spawnWindow({
      id: "task-" + taskId,
      title: task.title,
      sub: space ? `workspace · ${space.name} · ${task.runIds.length} runs` : "task workspace",
      icon: "list-todo",
      html: renderTask(taskId),
      x: 96 + (Object.keys(TASKS).indexOf(taskId) % 3) * 26,
      y: 38 + (Object.keys(TASKS).indexOf(taskId) % 3) * 20,
      w: 980,
      h: 680,
    });
    if (win) {
      $$(".win").forEach((w) => w.classList.remove("is-focused"));
      win.el.classList.add("is-focused");
    }
  }

  function renderRun(runId) {
    const run = runById(runId);
    if (!run) return "";
    const states = stepStates(run.status);
    const logs = logRows(run);
    const steps = runSteps(run);
    const space = spaceById(run.space);
    return `<div class="rw">
      <div class="rw-head">
        <div class="rw-head-main">
          <div class="rw-kicker">Execution · ${esc(run.task)}</div>
          <h2>Run · <span class="mono">#${esc(run.id)}</span></h2>
          <p>${esc(run.phase)} · ${esc(run.space)} · started ${esc(run.started)}</p>
        </div>
        <div class="rw-head-side"><span class="pill ${run.status === "running" ? "amber" : run.status === "failed" ? "red" : run.status === "waiting" ? "blue" : "green"}"><i class="dot ${run.status === "running" ? "live " : ""}c-${run.status === "running" ? "amber" : run.status === "failed" ? "red" : run.status === "waiting" ? "blue" : "green"}"></i>${RUN_LABEL[run.status] || run.status}</span><span class="mono faint" style="font-size:10px">${esc(run.nodes)} nodes</span></div>
      </div>
      <div class="rw-metrics">
        <div class="rw-metric"><span>Elapsed</span><b>${esc(run.elapsed)}</b></div>
        <div class="rw-metric"><span>Cost</span><b>${esc(run.cost)}</b></div>
        <div class="rw-metric"><span>Tokens</span><b>${esc(run.tokens)}</b></div>
        <div class="rw-metric"><span>Progress</span><b>${run.progress}%</b></div>
      </div>
      <div class="rw-panel">
        <div class="rw-panel-head"><span>Execution graph</span><span class="spacer"></span><span class="mono">${esc(run.phase)}</span></div>
        <div class="rw-flow">${flowNodes(states)}</div>
      </div>
      <div class="rw-grid">
        <div class="rw-panel">
          <div class="rw-panel-head"><span>Steps</span><span class="spacer"></span><span>${states.filter((s) => s === "done").length}/6 done</span></div>
          <div class="rw-steps">${steps.map((s) => `<div class="rw-step is-${s.state}"><span class="rw-step-dot"></span><div><b>${esc(s.name)} · ${esc(s.type)}</b><span>${esc(s.sub)}</span></div><time>${esc(s.time)}</time></div>`).join("")}</div>
        </div>
        <div class="rw-panel">
          <div class="rw-panel-head"><span>Events</span><span class="spacer"></span><span style="color:var(--green)">SSE</span></div>
          <div class="rw-log">${logs.map(([time, level, text]) => `<div class="rw-log-row"><time>${esc(time)}</time><span class="lv lv-${esc(level)}">${esc(level)}</span><span>${esc(text)}</span></div>`).join("")}</div>
        </div>
      </div>
      <div class="rw-callout ${run.status === "failed" ? "is-failed" : run.status === "running" ? "is-running" : ""}">${run.status === "failed" ? "Run 在 Verify 失败。Task 与 Workspace 都保留，下一次 attempt 可复用现场。" : run.status === "running" ? "Run 正在执行。Task workspace 窗口保持打开，关闭这个 Run 窗口不会中断。" : "Run 已完成。可从 Task workspace 的 Runs 列表重新打开任意历史。"}</div>
      <div class="tw-terminal" style="margin:9px 0 0"><div class="tw-terminal-head">${ico("terminal")}<span>attach</span><span class="spacer"></span><span class="mono">${esc(space?.branch || run.space)}</span></div><div class="tw-terminal-body"><span class="prompt">$</span> octopus runs attach ${esc(run.id)}<br><span class="ok">● attached</span> · ${esc(space?.name || run.space)}</div></div>
    </div>`;
  }

  function openRun(taskId, runId) {
    const run = runById(runId);
    if (!run) return;
    App.spawnWindow({
      id: "run-" + runId,
      title: "Run · #" + run.id,
      sub: `${RUN_LABEL[run.status] || run.status} · ${run.phase} · ${run.elapsed}`,
      icon: "activity",
      html: renderRun(runId),
      x: 216 + (Object.keys(TASKS).indexOf(taskId) % 3) * 18,
      y: 92 + (Object.keys(TASKS).indexOf(taskId) % 3) * 14,
      w: 760,
      h: 610,
    });
  }

  function $$(s, r) { return Array.from((r || document).querySelectorAll(s)); }

  document.addEventListener("click", (e) => {
    const spaceBtn = e.target.closest("[data-open-space]");
    if (spaceBtn) {
      const taskId = spaceBtn.dataset.taskId;
      state[taskId] = state[taskId] || {};
      state[taskId].spaceId = spaceBtn.dataset.spaceId;
      openTask(taskId);
      return;
    }
    const runBtn = e.target.closest("[data-open-run]");
    if (runBtn) {
      e.preventDefault();
      openRun(runBtn.dataset.taskId, runBtn.dataset.runId);
      return;
    }
    const card = e.target.closest("[data-task-card]");
    if (card) {
      e.preventDefault();
      openTask(card.dataset.taskCard);
      return;
    }
    const action = e.target.closest("[data-task-action]");
    if (action) {
      e.preventDefault();
      App.toast("已加入 Tasks 队列（原型演示）", "play");
    }
  });

  window.TaskWins = { openTask, openRun, TASKS };
})();
