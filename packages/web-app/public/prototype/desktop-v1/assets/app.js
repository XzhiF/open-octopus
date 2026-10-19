
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const page = document.body.dataset.page || "index";
  const STORE_KEY = `octopus.desktop.v1.${page}`;
  const TAB_KEY = `octopus.desktop.tabs.${page}`;
  const THEME_KEY = "octopus.desktop.theme";

  const RAIL = [
    { id: "home", label: "Home", icon: "layout-grid", href: "index.html" },
    { id: "workspace", label: "Spaces", icon: "folder-git", href: "workspaces.html" },
    { id: "agent", label: "Agent", icon: "bot", href: "agent.html" },
    { id: "tasks", label: "Tasks", icon: "list-todo", href: "tasks.html", badge: "2" },
    { id: "runs", label: "Runs", icon: "activity", href: "runs.html", badge: "3" },
    { id: "schedule", label: "Schedule", icon: "clock", href: "scheduler.html" },
    { id: "knowledge", label: "Wiki", icon: "book-open", href: "knowledge.html" },
    { id: "resources", label: "Library", icon: "package", href: "resources.html" },
    { id: "system", label: "System", icon: "sliders", href: "settings.html" },
  ];

  const SPRITE = `
  <svg width="0" height="0" style="position:absolute;overflow:hidden" aria-hidden="true">
    <defs>
      <symbol id="i-logo" viewBox="0 0 24 24"><path d="M12 2.8 20 7.2v9.6L12 21.2 4 16.8V7.2L12 2.8Z"/><circle cx="12" cy="10" r="2.2"/><path d="M8.4 14.7c.7 1.8 2 2.8 3.6 2.8s2.9-1 3.6-2.8"/></symbol>
      <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/></symbol>
      <symbol id="i-command" viewBox="0 0 24 24"><path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6Z"/></symbol>
      <symbol id="i-layout-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></symbol>
      <symbol id="i-folder-git" viewBox="0 0 24 24"><path d="M4 20h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7l-2-2H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2Z"/><path d="M12 11v5"/><circle cx="12" cy="18" r="1.4"/><path d="M15 8.5a2.5 2.5 0 0 1-3 2.5"/></symbol>
      <symbol id="i-bot" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="10" rx="3"/><path d="M12 6.5V10"/><circle cx="12" cy="5" r="1.5"/><path d="M8.5 15h.01M15.5 15h.01"/><path d="M4 14H2.5M20 14h1.5"/></symbol>
      <symbol id="i-users" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></symbol>
      <symbol id="i-github" viewBox="0 0 24 24"><path d="M9 19c-4 1.5-4-2-6-2.5M15 22v-3.5c0-1 .1-1.5-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.2 1.2a11 11 0 0 0-5.8 0C6.4 3.8 5.4 4.1 5.4 4.1a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 10.5c0 4.6 2.7 5.7 5.5 6-.6.5-.6 1.2-.5 2V22"/></symbol>
      <symbol id="i-list-todo" viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1.5 1.5L7.5 5M3.5 12 5 13.5 7.5 11M3.5 18 5 19.5 7.5 17"/></symbol>
      <symbol id="i-activity" viewBox="0 0 24 24"><path d="M3 12h4l2.5-7 4 14L16 12h5"/></symbol>
      <symbol id="i-book-open" viewBox="0 0 24 24"><path d="M12 6.5C10.5 5 8.5 4.3 6 4.3H3v14.4h3c2.5 0 4.5.7 6 2.2 1.5-1.5 3.5-2.2 6-2.2h3V4.3h-3c-2.5 0-4.5.7-6 2.2Z"/><path d="M12 6.5V21"/></symbol>
      <symbol id="i-package" viewBox="0 0 24 24"><path d="M21 8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></symbol>
      <symbol id="i-sliders" viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></symbol>
      <symbol id="i-bell" viewBox="0 0 24 24"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6"/><path d="M10 19a2 2 0 0 0 4 0"/></symbol>
      <symbol id="i-layers" viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/><path d="m3 17 9 5 9-5"/></symbol>
      <symbol id="i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></symbol>
      <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></symbol>
      <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></symbol>
      <symbol id="i-minus" viewBox="0 0 24 24"><path d="M5 12h14"/></symbol>
      <symbol id="i-square" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1.5"/></symbol>
      <symbol id="i-x" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></symbol>
      <symbol id="i-chevron-down" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
      <symbol id="i-chevron-right" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></symbol>
      <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
      <symbol id="i-play" viewBox="0 0 24 24"><path d="m7 4 13 8-13 8V4Z"/></symbol>
      <symbol id="i-pause" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></symbol>
      <symbol id="i-stop" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none"/></symbol>
      <symbol id="i-more" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none"/></symbol>
      <symbol id="i-check" viewBox="0 0 24 24"><path d="m4 12.5 5 5L20 6.5"/></symbol>
      <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
      <symbol id="i-alert" viewBox="0 0 24 24"><path d="M10.3 4.3 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></symbol>
      <symbol id="i-git-branch" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M8.5 6H13a3 3 0 0 1 3 3v11"/></symbol>
      <symbol id="i-git-pr" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M13 6h2a3 3 0 0 1 3 3v6"/><path d="m16 13 2 2 2-2"/></symbol>
      <symbol id="i-terminal" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 9 3 3-3 3M13 15h4"/></symbol>
      <symbol id="i-file-code" viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M9.5 13 8 14.5 9.5 16M14.5 13l1.5 1.5-1.5 1.5"/></symbol>
      <symbol id="i-sparkles" viewBox="0 0 24 24"><path d="m12 3 1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8L12 3Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/><path d="m5 15 .6 1.4L7 17l-1.4.6L5 19l-.6-1.4L3 17l1.4-.6L5 15Z"/></symbol>
      <symbol id="i-brain" viewBox="0 0 24 24"><path d="M9.5 4.5A3 3 0 0 0 5 7a3 3 0 0 0-1.5 5.6A3.4 3.4 0 0 0 6 18.5a3 3 0 0 0 5 2.2V4.9a2.6 2.6 0 0 0-1.5-.4Z"/><path d="M14.5 4.5A3 3 0 0 1 19 7a3 3 0 0 1 1.5 5.6 3.4 3.4 0 0 1-2.5 5.9 3 3 0 0 1-5 2.2"/><path d="M9.5 9H8M14.5 9H16M9.5 14H8M14.5 14H16"/></symbol>
      <symbol id="i-arrow-up-right" viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"/></symbol>
      <symbol id="i-arrow-right" viewBox="0 0 24 24"><path d="M4 12h16M14 6l6 6-6 6"/></symbol>
      <symbol id="i-arrow-left" viewBox="0 0 24 24"><path d="M20 12H4M10 6l-6 6 6 6"/></symbol>
      <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3 4.5 6v5.5c0 4.5 3 8 7.5 9.5 4.5-1.5 7.5-5 7.5-9.5V6L12 3Z"/><path d="m8.5 12 2.3 2.3 4.7-4.6"/></symbol>
      <symbol id="i-wallet" viewBox="0 0 24 24"><path d="M20 8V7a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7"/><path d="M16 13h.01"/></symbol>
      <symbol id="i-cpu" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></symbol>
      <symbol id="i-zap" viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></symbol>
      <symbol id="i-message" viewBox="0 0 24 24"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L3 21l1.8-5.4A8.5 8.5 0 1 1 21 11.5Z"/></symbol>
      <symbol id="i-send" viewBox="0 0 24 24"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z"/></symbol>
      <symbol id="i-paperclip" viewBox="0 0 24 24"><path d="m20 11.5-8.5 8.5a5 5 0 0 1-7-7L13 4.5a3.5 3.5 0 0 1 5 5L9.5 18a2 2 0 0 1-3-3L15 6.5"/></symbol>
      <symbol id="i-at" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5"/><path d="M15.5 12V8.5a3 3 0 0 1 6 0V12a6 6 0 1 1-3-5.2"/></symbol>
      <symbol id="i-filter" viewBox="0 0 24 24"><path d="M3 5h18l-7 8v5.5L10 21v-8L3 5Z"/></symbol>
      <symbol id="i-columns" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></symbol>
      <symbol id="i-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></symbol>
      <symbol id="i-external" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></symbol>
      <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 11A8 8 0 0 0 6.3 5.3L4 7.5"/><path d="M4 4v4h4M4 13a8 8 0 0 0 13.7 5.7L20 16.5"/><path d="M20 20v-4h-4"/></symbol>
      <symbol id="i-inbox" viewBox="0 0 24 24"><path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5l2-8Z"/></symbol>
      <symbol id="i-database" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></symbol>
      <symbol id="i-wand" viewBox="0 0 24 24"><path d="m15 4 5 5L7 22l-5-5L15 4Z"/><path d="m14 5 5 5M6 15l3 3"/><path d="M19 2v3M20.5 3.5h-3M5 2v2M6 3H4"/></symbol>
      <symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/></symbol>
      <symbol id="i-history" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></symbol>
      <symbol id="i-key" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 4l4 4M14 6l3 3"/></symbol>
      <symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></symbol>
      <symbol id="i-lock" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></symbol>
      <symbol id="i-eye" viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></symbol>
      <symbol id="i-panel-right" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></symbol>
      <symbol id="i-scale" viewBox="0 0 24 24"><path d="M12 3v18M7 21h10M5 7h14"/><path d="m5 7-3 6h6L5 7ZM19 7l-3 6h6l-3-6Z"/></symbol>
      <symbol id="i-diff" viewBox="0 0 24 24"><path d="M6 3v18M18 3v18"/><path d="M3 8h6M15 16h6M3 16h6M15 8h6"/></symbol>
      <symbol id="i-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></symbol>
      <symbol id="i-loader" viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9"/></symbol>
    </defs>
  </svg>`;

  const icon = (name, cls = "") =>
    `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  const safeStore = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        
      }
    },
    raw(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    rawSet(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        
      }
    },
  };

  document.body.insertAdjacentHTML("afterbegin", SPRITE);


  const initialTheme = safeStore.raw(THEME_KEY) || "dark";
  document.documentElement.dataset.theme = initialTheme;

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    safeStore.rawSet(THEME_KEY, theme);
    toast(theme === "light" ? "Bone light theme" : "Graphite dark theme", "moon");
  }

  function toggleTheme() {
    setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  }


  const app = $(".app");
  const shell = $(".shell");
  const canvas = $("#canvas");
  const nav = document.body.dataset.nav || (page === "index" ? "home" : page);
  const scene = document.body.dataset.scene || "Workbench";
  const crumb = document.body.dataset.crumb || "";
  const runningLabel = document.body.dataset.running || "3 running";

  const appbar = document.createElement("header");
  appbar.className = "appbar";
  appbar.innerHTML = `
    <div class="ab-left">
      <div class="traffic" aria-hidden="true"><i class="t-red"></i><i class="t-yel"></i><i class="t-grn"></i></div>
      <a class="brand" href="index.html">${icon("logo")}<span>octopus</span></a>
      <span class="ab-sep"></span>
      <div class="scene"><b>${esc(scene)}</b><span>${esc(crumb)}</span></div>
    </div>
    <button class="omni" data-action="palette" aria-label="Command palette">
      ${icon("search")}
      <span>Search, open a window, jump to…</span>
      <kbd>⌘ K</kbd>
    </button>
    <div class="ab-right">
      <span class="status-pill"><i class="dot live"></i>${esc(runningLabel)}</span>
      <button class="iconbtn" data-action="bell" title="Notifications">${icon("bell")}</button>
      <button class="iconbtn" data-action="windows" title="Windows">${icon("layers")}</button>
      <button class="iconbtn" data-action="mission" title="Mission Control">${icon("grid")}</button>
      <button class="iconbtn theme-toggle" data-action="theme" title="Theme">${icon("moon", "theme-dark")}${icon("sun", "theme-light")}</button>
      <div class="avatar" title="zxf@personal">ZF</div>
      <div class="menu-pop" id="window-menu"></div>
    </div>`;
  app.prepend(appbar);

  const rail = document.createElement("aside");
  rail.className = "rail";
  const railLinks = RAIL.map((item) => {
    const active = item.id === nav;
    return `<a class="rail-item ${active ? "is-active" : ""}" href="${item.href}" title="${item.label}">
      ${icon(item.icon)}
      <span>${item.label}</span>
      ${item.badge ? `<span class="badge">${item.badge}</span>` : ""}
    </a>`;
  }).join("");
  rail.innerHTML = `
    <a class="rail-brand" href="index.html" title="Octopus home">${icon("logo")}</a>
    <nav class="rail-nav" aria-label="Spaces">${railLinks}</nav>
    <div class="rail-foot">
      <button class="rail-item" data-action="palette" title="Command palette">${icon("search")}<span>Find</span></button>
      <a class="rail-item" href="design.html" title="Design notes">${icon("sparkles")}<span>Design</span></a>
    </div>`;
  shell.prepend(rail);


  let z = 40;
  let focused = null;
  const wins = [];
  const byId = new Map();
  const savedLayout = safeStore.get(STORE_KEY, {});

  const canvasSize = () => ({
    w: canvas.clientWidth,
    h: canvas.clientHeight,
  });

  function winState(w) {
    return {
      x: Math.round(parseFloat(w.el.style.getPropertyValue("--x")) || 0),
      y: Math.round(parseFloat(w.el.style.getPropertyValue("--y")) || 0),
      w: Math.round(parseFloat(w.el.style.getPropertyValue("--w")) || 0),
      h: Math.round(parseFloat(w.el.style.getPropertyValue("--h")) || 0),
    };
  }

  function applyRect(w, x, y, width, height) {
    w.el.style.setProperty("--x", `${Math.round(x)}px`);
    w.el.style.setProperty("--y", `${Math.round(y)}px`);
    w.el.style.setProperty("--w", `${Math.round(width)}px`);
    w.el.style.setProperty("--h", `${Math.round(height)}px`);
  }

  function persist() {
    const out = {};
    for (const w of wins) {
      out[w.id] = {
        ...winState(w),
        min: w.el.classList.contains("is-min"),
        max: w.el.classList.contains("is-max"),
        closed: w.el.classList.contains("is-closed"),
      };
    }
    safeStore.set(STORE_KEY, out);
  }

  function resetZ() {
    wins.forEach((w, i) => {
      w.el.style.zIndex = 2 + i;
    });
    z = Math.max(40, wins.length + 4);
  }

  function focusWin(w) {
    if (!w || w.el.classList.contains("is-closed")) return;
    if (w.el.classList.contains("is-min")) setMin(w, false);
    z += 1;
    w.el.style.zIndex = z;
    wins.forEach((x) => x.el.classList.remove("is-focused"));
    w.el.classList.add("is-focused");
    focused = w;
    updateDock();
    updateWindowMenu();
  }

  function focusNext() {
    const open = wins.filter((w) => !w.el.classList.contains("is-closed") && !w.el.classList.contains("is-min"));
    if (!open.length) {
      focused = null;
      return;
    }
    const idx = focused ? open.indexOf(focused) : -1;
    focusWin(open[(idx + 1) % open.length]);
  }

  function setMin(w, min) {
    w.el.classList.toggle("is-min", min);
    if (min) {
      w.el.classList.remove("is-focused");
      if (focused === w) {
        focused = null;
        const next = wins.find((x) => !x.el.classList.contains("is-closed") && !x.el.classList.contains("is-min"));
        if (next) focusWin(next);
      }
    }
    updateDock();
    persist();
  }

  function toggleMax(w) {
    if (w.el.classList.contains("is-min")) w.el.classList.remove("is-min");
    w.el.classList.toggle("is-max");
    focusWin(w);
    updateDock();
    persist();
  }

  function closeWin(w) {
    w.el.classList.add("is-closed");
    w.el.classList.remove("is-focused");
    if (focused === w) {
      focused = null;
      const next = wins.find((x) => !x.el.classList.contains("is-closed") && !x.el.classList.contains("is-min"));
      if (next) focusWin(next);
    }
    updateDock();
    updateWindowMenu();
    persist();
  }

  function reopenWin(w) {
    w.el.classList.remove("is-closed", "is-min");
    focusWin(w);
    persist();
  }

  function snapRect(kind) {
    const { w: cw, h: ch } = canvasSize();
    const pad = 10;
    const gap = 8;
    const h = ch - 78;
    if (kind === "left") return { x: pad, y: pad, w: (cw - pad * 2 - gap) / 2, h };
    if (kind === "right") return { x: pad + (cw - pad * 2 - gap) / 2 + gap, y: pad, w: (cw - pad * 2 - gap) / 2, h };
    return { x: pad, y: pad, w: cw - pad * 2, h };
  }

  const snapPreview = document.createElement("div");
  snapPreview.className = "snap-preview";
  canvas.appendChild(snapPreview);

  function showSnap(kind) {
    if (!kind) {
      snapPreview.classList.remove("is-on");
      return;
    }
    const r = snapRect(kind);
    snapPreview.style.left = `${r.x}px`;
    snapPreview.style.top = `${r.y}px`;
    snapPreview.style.width = `${r.w}px`;
    snapPreview.style.height = `${r.h}px`;
    snapPreview.classList.add("is-on");
  }

  function setupDrag(w, bar) {
    let start = null;

    bar.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".wbtn")) return;
      focusWin(w);
      if (w.el.classList.contains("is-max")) return;
      const r = winState(w);
      start = { px: e.clientX, py: e.clientY, ...r };
      bar.setPointerCapture(e.pointerId);
      w.el.classList.add("is-dragging");
      e.preventDefault();

      const move = (ev) => {
        if (!start) return;
        const nx = start.x + ev.clientX - start.px;
        const ny = start.y + ev.clientY - start.py;
        applyRect(w, nx, ny, start.w, start.h);

        const cr = canvas.getBoundingClientRect();
        let snap = null;
        if (ev.clientY < cr.top + 14) snap = "top";
        else if (ev.clientX < cr.left + 18) snap = "left";
        else if (ev.clientX > cr.right - 18) snap = "right";
        showSnap(snap);
        w.nearestSnap = snap;
      };

      const up = () => {
        if (!start) return;
        const snap = w.nearestSnap;
        w.nearestSnap = null;
        start = null;
        w.el.classList.remove("is-dragging");
        showSnap(null);
        if (snap) {
          const r = snapRect(snap);
          applyRect(w, r.x, r.y, r.w, r.h);
          w.el.classList.remove("is-max");
        }
        persist();
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
        bar.removeEventListener("pointercancel", up);
      };

      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
      bar.addEventListener("pointercancel", up);
    });

    bar.addEventListener("dblclick", (e) => {
      if (e.target.closest(".wbtn")) return;
      toggleMax(w);
    });
  }

  function setupResize(w, handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || w.el.classList.contains("is-max")) return;
      e.preventDefault();
      e.stopPropagation();
      focusWin(w);
      const r = winState(w);
      const start = { px: e.clientX, py: e.clientY, ...r };
      handle.setPointerCapture(e.pointerId);
      w.el.classList.add("is-dragging");

      const move = (ev) => {
        const nw = Math.max(220, start.w + ev.clientX - start.px);
        const nh = Math.max(130, start.h + ev.clientY - start.py);
        applyRect(w, start.x, start.y, nw, nh);
      };
      const up = () => {
        w.el.classList.remove("is-dragging");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        persist();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  function initWindows() {
    $$(".win", canvas).forEach((el) => {
      const id = el.dataset.win || `win-${wins.length + 1}`;
      const title = el.dataset.title || "Untitled";
      const sub = el.dataset.sub || "";
      const ic = el.dataset.icon || "layout-grid";

      const content = document.createElement("div");
      content.className = "win-content";
      [...el.children].forEach((child) => content.appendChild(child));

      const bar = document.createElement("div");
      bar.className = "win-bar";
      bar.innerHTML = `
        <span class="wicon">${icon(ic)}</span>
        <div class="wtitles"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ""}</div>
        <div class="wactions">
          <button class="wbtn" data-wact="min" title="Minimize">${icon("minus")}</button>
          <button class="wbtn" data-wact="max" title="Maximize">${icon("square")}</button>
          <button class="wbtn" data-wact="close" title="Close">${icon("x")}</button>
        </div>`;

      const resize = document.createElement("div");
      resize.className = "wresize";
      resize.title = "Resize";

      el.append(bar, content, resize);
      el.dataset.title = title;

      const saved = savedLayout[id];
      const cw = canvas.clientWidth || 1400;
      const ch = canvas.clientHeight || 850;
      let x = saved?.x ?? Number(el.dataset.x ?? 24);
      let y = saved?.y ?? Number(el.dataset.y ?? 20);
      let width = saved?.w ?? Number(el.dataset.w ?? 560);
      let height = saved?.h ?? Number(el.dataset.h ?? 420);
      width = clamp(width, 220, Math.max(220, cw - 16));
      height = clamp(height, 130, Math.max(130, ch - 12));
      x = clamp(x, -width + 140, Math.max(8, cw - 70));
      y = clamp(y, 0, Math.max(8, ch - 44));

      applyRect({ el }, x, y, width, height);

      const w = {
        id,
        title,
        sub,
        icon: ic,
        el,
        bar,
        content,
        initial: { x: Number(el.dataset.x ?? 24), y: Number(el.dataset.y ?? 20), w: Number(el.dataset.w ?? 560), h: Number(el.dataset.h ?? 420) },
      };

      if (saved?.min || el.dataset.min === "1") el.classList.add("is-min");
      if (saved?.max) el.classList.add("is-max");
      if (saved?.closed) el.classList.add("is-closed");

      el.addEventListener("pointerdown", () => focusWin(w), { passive: true });

      bar.querySelector('[data-wact="min"]').addEventListener("click", (e) => {
        e.stopPropagation();
        setMin(w, true);
      });
      bar.querySelector('[data-wact="max"]').addEventListener("click", (e) => {
        e.stopPropagation();
        toggleMax(w);
      });
      bar.querySelector('[data-wact="close"]').addEventListener("click", (e) => {
        e.stopPropagation();
        closeWin(w);
      });

      setupDrag(w, bar);
      setupResize(w, resize);

      wins.push(w);
      byId.set(id, w);
    });

    resetZ();
    const first = wins.find((w) => !w.el.classList.contains("is-closed") && !w.el.classList.contains("is-min"));
    if (first) focusWin(first);
    updateDock();
    updateWindowMenu();
  }


  const dockwrap = document.createElement("div");
  dockwrap.className = "dockwrap";
  dockwrap.innerHTML = `<div class="dock" id="dock"></div>`;
  canvas.appendChild(dockwrap);

  function buildDock() {
    const dock = $("#dock");
    dock.innerHTML =
      wins
        .map(
          (w) => `<button class="dock-item" data-dock="${w.id}" title="${esc(w.title)}">
            ${icon(w.icon)}
            <span class="dock-tip">${esc(w.title)}</span>
          </button>`
        )
        .join("") +
      `<span class="dock-sep"></span>
       <button class="dock-item" data-action="mission" title="Mission Control">${icon("grid")}<span class="dock-tip">All windows</span></button>`;
    updateDock();
  }

  function updateDock() {
    $$("[data-dock]").forEach((btn) => {
      const w = byId.get(btn.dataset.dock);
      if (!w) return;
      btn.classList.toggle("is-min", w.el.classList.contains("is-min"));
      btn.classList.toggle("is-closed", w.el.classList.contains("is-closed"));
      btn.classList.toggle("is-active", focused === w && !w.el.classList.contains("is-min"));
    });
  }


  const winMenu = $("#window-menu");

  function updateWindowMenu() {
    if (!winMenu) return;
    const rows = wins
      .filter((w) => !w.el.classList.contains("is-closed"))
      .map(
        (w) => `<button class="menu-row" data-focus="${w.id}">
          ${icon(w.icon)}
          <span class="grow ellipsis">${esc(w.title)}</span>
          ${w.el.classList.contains("is-min") ? `<span class="mr-meta">min</span>` : focused === w ? `<span class="mr-dot"></span>` : ""}
        </button>`
      )
      .join("");
    winMenu.innerHTML = `
      <div class="menu-label">Open windows</div>
      ${rows || `<div class="menu-row muted">No open windows</div>`}
      <div class="menu-sep"></div>
      <button class="menu-row" data-layout="tile">${icon("columns")}<span>Tile windows</span><kbd>⌥T</kbd></button>
      <button class="menu-row" data-layout="cascade">${icon("layers")}<span>Cascade</span></button>
      <button class="menu-row" data-layout="reset">${icon("refresh")}<span>Reset layout</span></button>
      <div class="menu-sep"></div>
      <button class="menu-row" data-layout="min-all">${icon("minus")}<span>Minimize all</span></button>
      <button class="menu-row" data-layout="close-all">${icon("x")}<span>Close all</span></button>`;
  }

  function toggleWindowMenu(force) {
    const open = force ?? !winMenu.classList.contains("is-open");
    winMenu.classList.toggle("is-open", open);
    if (open) updateWindowMenu();
  }


  function visibleWins(includeMin = true) {
    return wins.filter((w) => !w.el.classList.contains("is-closed") && (includeMin || !w.el.classList.contains("is-min")));
  }

  function tileWindows() {
    const list = visibleWins();
    if (!list.length) return;
    const { w: cw, h: ch } = canvasSize();
    const pad = 12;
    const gap = 12;
    const dock = 74;
    list.forEach((w) => w.el.classList.remove("is-min", "is-max"));

    if (list.length === 1) {
      applyRect(list[0], pad, pad, cw - pad * 2, ch - pad - dock);
    } else if (list.length === 2) {
      const half = (cw - pad * 2 - gap) / 2;
      applyRect(list[0], pad, pad, half, ch - pad - dock);
      applyRect(list[1], pad + half + gap, pad, half, ch - pad - dock);
    } else if (list.length === 3) {
      const half = (cw - pad * 2 - gap) / 2;
      const hh = (ch - pad * 2 - dock - gap) / 2;
      applyRect(list[0], pad, pad, half, hh);
      applyRect(list[1], pad + half + gap, pad, half, hh);
      applyRect(list[2], pad, pad + hh + gap, cw - pad * 2, hh);
    } else {
      const cols = Math.ceil(Math.sqrt(list.length));
      const rows = Math.ceil(list.length / cols);
      const ww = (cw - pad * 2 - gap * (cols - 1)) / cols;
      const hh = (ch - pad * 2 - dock - gap * (rows - 1)) / rows;
      list.forEach((w, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        applyRect(w, pad + col * (ww + gap), pad + row * (hh + gap), ww, hh);
      });
    }
    updateDock();
    updateWindowMenu();
    persist();
    toast(`${list.length} windows tiled`, "columns");
  }

  function cascadeWindows() {
    const list = visibleWins();
    if (!list.length) return;
    const { w: cw, h: ch } = canvasSize();
    const width = Math.min(760, cw - 120);
    const height = Math.min(560, ch - 150);
    list.forEach((w, i) => {
      w.el.classList.remove("is-min", "is-max");
      applyRect(w, 26 + i * 30, 20 + i * 26, width, height);
      w.el.style.zIndex = 10 + i;
    });
    z = 40 + list.length;
    updateDock();
    updateWindowMenu();
    persist();
    toast("Cascaded", "layers");
  }

  function resetLayout() {
    wins.forEach((w) => {
      w.el.classList.remove("is-min", "is-max", "is-closed");
      applyRect(w, w.initial.x, w.initial.y, w.initial.w, w.initial.h);
    });
    resetZ();
    fitSceneToViewport();
    const first = wins[0];
    if (first) focusWin(first);
    updateDock();
    updateWindowMenu();
    persist();
    toast("Layout reset", "refresh");
  }

  function fitSceneToViewport() {
    const all = wins.filter((w) => !w.el.classList.contains("is-closed"));
    const open = all.filter((w) => !w.el.classList.contains("is-min"));
    if (!open.length) return;
    const rects = all.map(winState);
    const openRects = open.map(winState);
    const minX = Math.min(...openRects.map((r) => r.x));
    const minY = Math.min(...openRects.map((r) => r.y));
    const maxX = Math.max(...openRects.map((r) => r.x + r.w));
    const maxY = Math.max(...openRects.map((r) => r.y + r.h));
    const availW = canvas.clientWidth - 24;
    const availH = canvas.clientHeight - 80;
    const f = Math.min(1, availW / Math.max(1, maxX - minX), availH / Math.max(1, maxY - minY));
    if (f >= 0.97) return;
    all.forEach((w, i) => {
      const r = rects[i];
      const x = 16 + (r.x - minX) * f;
      const y = 16 + (r.y - minY) * f;
      const ww = Math.max(220, r.w * f);
      const hh = Math.max(130, r.h * f);
      applyRect(w, x, y, ww, hh);
    });
  }

  function minimizeAll() {
    visibleWins().forEach((w) => w.el.classList.add("is-min"));
    focused = null;
    updateDock();
    persist();
    toast("All windows minimized", "minus");
  }

  function closeAll() {
    visibleWins().forEach((w) => {
      w.el.classList.add("is-closed");
      w.el.classList.remove("is-focused");
    });
    focused = null;
    updateDock();
    updateWindowMenu();
    persist();
    toast("Windows closed — use ⌘K to reopen", "x");
  }


  const mission = document.createElement("div");
  mission.className = "overlay mission";
  mission.id = "mission";
  mission.innerHTML = `
    <div class="mission-head">
      <div class="grow">
        <h2>All windows</h2>
        <p id="mission-sub">Everything stays alive. Nothing gets replaced by navigation.</p>
      </div>
      <button class="btn" data-layout="tile">${icon("columns")}Tile</button>
      <button class="btn" data-layout="cascade">${icon("layers")}Cascade</button>
      <button class="btn btn-primary" data-close-overlay>Back to work</button>
    </div>
    <div class="mission-grid" id="mission-grid"></div>`;
  document.body.appendChild(mission);

  function openMission() {
    closePalette();
    toggleWindowMenu(false);
    const grid = $("#mission-grid");
    const list = visibleWins();
    grid.innerHTML = "";
    $("#mission-sub").textContent = `${list.length} open · ${wins.filter((w) => w.el.classList.contains("is-min")).length} minimized · everything stays alive.`;

    list.forEach((w) => {
      const card = document.createElement("div");
      card.className = `mission-card ${w.el.classList.contains("is-min") ? "is-min" : ""}`;
      card.setAttribute("role", "button");
      card.tabIndex = 0;
      card.innerHTML = `
        <div class="mission-preview"></div>
        <div class="mission-meta">
          <span class="mi">${icon(w.icon)}</span>
          <div class="grow"><b>${esc(w.title)}</b><span>${esc(w.sub || "Window")}${w.el.classList.contains("is-min") ? " · minimized" : ""}</span></div>
          ${icon("arrow-up-right", "sm")}
        </div>`;
      const openThis = () => {
        closeMission();
        reopenWin(w);
      };
      card.addEventListener("click", openThis);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openThis();
        }
      });
      grid.appendChild(card);

      const preview = card.querySelector(".mission-preview");
      requestAnimationFrame(() => {
        const rect = winState(w);
        const pw = preview.clientWidth || 320;
        const ph = preview.clientHeight || 182;
        const scale = Math.min(pw / rect.w, ph / rect.h, 1);
        const clone = w.el.cloneNode(true);
        clone.classList.remove("is-focused", "is-min", "is-max", "is-closed", "is-dragging");
        clone.classList.add("mc-clone");
        clone.style.left = `${(pw - rect.w * scale) / 2}px`;
        clone.style.top = `${(ph - rect.h * scale) / 2}px`;
        clone.style.width = `${rect.w}px`;
        clone.style.height = `${rect.h}px`;
        clone.style.transform = `scale(${scale})`;
        clone.style.transformOrigin = "top left";
        clone.style.zIndex = "1";
        preview.appendChild(clone);
      });
    });

    mission.classList.add("is-open");
  }

  function closeMission() {
    mission.classList.remove("is-open");
    const grid = $("#mission-grid");
    if (grid) grid.innerHTML = "";
  }


  const paletteWrap = document.createElement("div");
  paletteWrap.className = "overlay palette-wrap";
  paletteWrap.id = "palette";
  paletteWrap.innerHTML = `
    <div class="palette" role="dialog" aria-label="Command palette">
      <div class="palette-input">
        ${icon("search")}
        <input id="palette-input" placeholder="Type a window, space, or action…" autocomplete="off" spellcheck="false" />
        <kbd>esc</kbd>
      </div>
      <div class="palette-list" id="palette-list"></div>
    </div>`;
  document.body.appendChild(paletteWrap);

  let paletteIndex = 0;
  let paletteFiltered = [];

  function paletteSource() {
    const items = [];
    wins.forEach((w) => {
      const state = w.el.classList.contains("is-closed") ? "closed" : w.el.classList.contains("is-min") ? "minimized" : "open";
      items.push({
        group: "Windows",
        label: w.title,
        hint: w.sub || "Window",
        icon: w.icon,
        meta: state,
        run: () => {
          if (w.el.classList.contains("is-closed")) reopenWin(w);
          else focusWin(w);
        },
      });
    });
    items.push(
      { group: "Actions", label: "Mission Control", hint: "See every open window", icon: "grid", key: "⌃⌥M", run: openMission },
      { group: "Actions", label: "Tile windows", hint: "Fill the canvas as a grid", icon: "columns", key: "⌥T", run: tileWindows },
      { group: "Actions", label: "Cascade windows", hint: "Stack windows diagonally", icon: "layers", run: cascadeWindows },
      { group: "Actions", label: "Reset layout", hint: "Back to the authored scene", icon: "refresh", run: resetLayout },
      { group: "Actions", label: "Minimize all", hint: "Clear the canvas, keep state", icon: "minus", run: minimizeAll },
      { group: "Actions", label: "Toggle theme", hint: "Graphite / bone", icon: "moon", run: toggleTheme },
      { group: "Actions", label: "Open design notes", hint: "Principles, tokens, window model", icon: "sparkles", run: () => (location.href = "design.html") }
    );
    RAIL.forEach((r) => {
      items.push({
        group: "Go to",
        label: r.label,
        hint: r.href.replace(".html", ""),
        icon: r.icon,
        run: () => (location.href = r.href),
      });
    });
    return items;
  }

  function renderPalette() {
    const input = $("#palette-input");
    const q = input.value.trim().toLowerCase();
    const all = paletteSource();
    paletteFiltered = all.filter((it) => {
      if (!q) return true;
      return `${it.label} ${it.hint} ${it.group}`.toLowerCase().includes(q);
    });
    paletteIndex = clamp(paletteIndex, 0, Math.max(0, paletteFiltered.length - 1));

    const list = $("#palette-list");
    let html = "";
    let group = "";
    paletteFiltered.forEach((it, i) => {
      if (it.group !== group) {
        group = it.group;
        html += `<div class="pgroup">${group}</div>`;
      }
      html += `<button class="pitem ${i === paletteIndex ? "is-sel" : ""}" data-pi="${i}">
        ${icon(it.icon)}
        <span class="grow ellipsis">${esc(it.label)}<span class="faint small"> · ${esc(it.hint)}</span></span>
        ${it.key ? `<kbd>${it.key}</kbd>` : it.meta ? `<span class="ptype">${esc(it.meta)}</span>` : ""}
      </button>`;
    });
    if (!paletteFiltered.length) {
      html = `<div class="empty">${icon("search")}<span>No windows or actions match “${esc(q)}”.</span></div>`;
    }
    list.innerHTML = html;
  }

  function openPalette() {
    closeMission();
    toggleWindowMenu(false);
    paletteWrap.classList.add("is-open");
    const input = $("#palette-input");
    input.value = "";
    paletteIndex = 0;
    renderPalette();
    requestAnimationFrame(() => input.focus());
  }

  function closePalette() {
    paletteWrap.classList.remove("is-open");
  }

  paletteWrap.addEventListener("input", (e) => {
    if (e.target.id === "palette-input") {
      paletteIndex = 0;
      renderPalette();
    }
  });

  paletteWrap.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!paletteFiltered.length) return;
      paletteIndex = (paletteIndex + 1) % paletteFiltered.length;
      renderPalette();
      $$(".pitem")[paletteIndex]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!paletteFiltered.length) return;
      paletteIndex = (paletteIndex - 1 + paletteFiltered.length) % paletteFiltered.length;
      renderPalette();
      $$(".pitem")[paletteIndex]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = paletteFiltered[paletteIndex];
      if (it) {
        closePalette();
        it.run();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  });

  paletteWrap.addEventListener("click", (e) => {
    if (e.target === paletteWrap) {
      closePalette();
      return;
    }
    const item = e.target.closest("[data-pi]");
    if (item) {
      const it = paletteFiltered[Number(item.dataset.pi)];
      if (it) {
        closePalette();
        it.run();
      }
    }
  });


  const toastHost = document.createElement("div");
  toastHost.className = "toast-host";
  document.body.appendChild(toastHost);

  function toast(message, ic = "check") {
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `${icon(ic)}<span>${esc(message)}</span>`;
    toastHost.appendChild(el);
    setTimeout(() => {
      el.classList.add("is-out");
      setTimeout(() => el.remove(), 180);
    }, 1900);
  }


  const tabState = safeStore.get(TAB_KEY, {});

  function activateTab(group, key) {
    const btn = $(`[data-tab="${key}"]`, group);
    if (!btn) return;
    const scope = btn.closest(".win-content") || group.parentElement;
    $$("[data-tab]", group).forEach((b) => b.classList.toggle("is-active", b === btn));
    $$("[data-pane]", scope).forEach((p) => p.classList.toggle("is-active", p.dataset.pane === key));
  }

  function setupTabs() {
    $$("[data-tabs]").forEach((group, index) => {
      const win = group.closest(".win");
      const storeKey = `${win?.dataset.win || "win"}:${index}`;
      if (tabState[storeKey]) activateTab(group, tabState[storeKey]);

      group.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-tab]");
        if (!btn) return;
        const key = btn.dataset.tab;
        const scope = btn.closest(".win-content") || group.parentElement;
        $$("[data-tab]", group).forEach((b) => b.classList.toggle("is-active", b === btn));
        $$("[data-pane]", scope).forEach((p) => p.classList.toggle("is-active", p.dataset.pane === key));
        tabState[storeKey] = key;
        safeStore.set(TAB_KEY, tabState);
      });
    });
  }

  function setupSegments() {
    $$(".seg").forEach((seg) => {
      seg.addEventListener("click", (e) => {
        const btn = e.target.closest("button");
        if (!btn) return;
        $$("button", seg).forEach((b) => b.classList.toggle("is-active", b === btn));
      });
    });
  }

  function setupSwitches() {
    document.addEventListener("click", (e) => {
      const sw = e.target.closest(".switch");
      if (sw) sw.classList.toggle("is-on");
    });
  }

  function setupGraphs() {
    $$("[data-graph-fit]").forEach((stage) => {
      const wrap = stage.parentElement;
      const sw = Number(stage.dataset.stageW || 760);
      const sh = Number(stage.dataset.stageH || 440);
      const fit = () => {
        const r = wrap.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) return;
        const scale = Math.min((r.width - 46) / sw, (r.height - 46) / sh, 1.25);
        stage.style.transform = `scale(${Math.max(scale, 0.32)})`;
        stage.style.left = `${Math.max(0, (r.width - sw * scale) / 2)}px`;
        stage.style.top = `${Math.max(0, (r.height - sh * scale) / 2)}px`;
      };
      if (window.ResizeObserver) new ResizeObserver(fit).observe(wrap);
      fit();
      setTimeout(fit, 30);
    });
  }

  function setupActions() {
    document.addEventListener("click", (e) => {
      const actionEl = e.target.closest("[data-action]");
      if (actionEl) {
        const action = actionEl.dataset.action;
        if (action === "palette") openPalette();
        else if (action === "mission") openMission();
        else if (action === "windows") toggleWindowMenu();
        else if (action === "theme") toggleTheme();
        else if (action === "bell") toast("No unread notifications", "bell");
        else if (action === "close-overlay") closeMission();
        else if (action === "reset-layout") resetLayout();
        else if (action === "tile") tileWindows();
        else if (action === "cascade") cascadeWindows();
        else if (action === "copy") toast("Copied to clipboard", "copy");
        return;
      }

      const dock = e.target.closest("[data-dock]");
      if (dock) {
        const w = byId.get(dock.dataset.dock);
        if (w) {
          if (w.el.classList.contains("is-min")) {
            w.el.classList.remove("is-min");
            focusWin(w);
            persist();
          } else if (focused === w) {
            setMin(w, true);
          } else {
            focusWin(w);
          }
        }
        return;
      }

      const focusEl = e.target.closest("[data-focus]");
      if (focusEl) {
        const w = byId.get(focusEl.dataset.focus);
        if (w) focusWin(w);
        toggleWindowMenu(false);
        return;
      }

      const layoutEl = e.target.closest("[data-layout]");
      if (layoutEl) {
        const kind = layoutEl.dataset.layout;
        if (kind === "tile") tileWindows();
        else if (kind === "cascade") cascadeWindows();
        else if (kind === "reset") resetLayout();
        else if (kind === "min-all") minimizeAll();
        else if (kind === "close-all") closeAll();
        toggleWindowMenu(false);
        return;
      }

      const closeOverlay = e.target.closest("[data-close-overlay]");
      if (closeOverlay) {
        closeMission();
        return;
      }

      if (e.target === mission) closeMission();
      if (e.target === paletteWrap) closePalette();

      const toastEl = e.target.closest("[data-toast]");
      if (toastEl) toast(toastEl.dataset.toast, toastEl.dataset.toastIcon || "check");

      const hrefEl = e.target.closest("[data-href]");
      if (hrefEl) location.href = hrefEl.dataset.href;

      if (!e.target.closest("#window-menu") && !e.target.closest('[data-action="windows"]')) {
        toggleWindowMenu(false);
      }
    });
  }


  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();

    if (mod && key === "k") {
      e.preventDefault();
      paletteWrap.classList.contains("is-open") ? closePalette() : openPalette();
      return;
    }
    if (mod && e.shiftKey && key === "m") {
      e.preventDefault();
      mission.classList.contains("is-open") ? closeMission() : openMission();
      return;
    }
    if (e.altKey && key === "t") {
      e.preventDefault();
      tileWindows();
      return;
    }
    if (e.altKey && key === "w" && focused) {
      e.preventDefault();
      closeWin(focused);
      return;
    }
    if (e.key === "Escape") {
      if (paletteWrap.classList.contains("is-open")) closePalette();
      else if (mission.classList.contains("is-open")) closeMission();
      else if (winMenu.classList.contains("is-open")) toggleWindowMenu(false);
      return;
    }
    if (e.altKey && e.key === "]") {
      e.preventDefault();
      focusNext();
    }
  });

  window.addEventListener("resize", () => {
    const { w: cw, h: ch } = canvasSize();
    wins.forEach((w) => {
      const r = winState(w);
      if (r.x > cw - 80) applyRect(w, Math.max(8, cw - r.w - 12), r.y, r.w, r.h);
      if (r.y > ch - 50) applyRect(w, r.x, Math.max(8, ch - r.h - 12), r.w, r.h);
    });
  });


  initWindows();
  buildDock();
  fitSceneToViewport();
  setupTabs();
  setupSegments();
  setupSwitches();
  setupGraphs();
  setupActions();
  setTimeout(() => {
    setupGraphs();
    $$(".win").forEach((w) => w.classList.add("is-ready"));
  }, 60);
})();
