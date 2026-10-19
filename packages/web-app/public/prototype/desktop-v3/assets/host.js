(() => {
  "use strict";

  const ACTIVE_KEY = "octopus.desktop.v3.scene";
  const THEME_KEY = "octopus.desktop.theme";
  const frames = new Map(
    [...document.querySelectorAll(".scene-frame")].map((frame) => [frame.dataset.scene, frame])
  );

  const HREF_TO_SCENE = {
    "index.html": "home",
    "home.html": "home",
    "workspaces.html": "spaces",
    "workspace.html": "workspace",
    "agent.html": "agent",
    "tasks.html": "tasks",
    "runs.html": "runs",
    "scheduler.html": "schedule",
    "knowledge.html": "wiki",
    "resources.html": "library",
    "settings.html": "system",
    "design.html": "home",
  };

  const getTheme = () => localStorage.getItem(THEME_KEY) || "light";

  const applyTheme = (frame, theme) => {
    try {
      const root = frame.contentDocument?.documentElement;
      if (root) root.dataset.theme = theme;
    } catch {
      /* same-origin document not ready yet */
    }
  };

  const applyThemeAll = (theme) => {
    document.documentElement.dataset.theme = theme;
    frames.forEach((frame) => applyTheme(frame, theme));
  };

  const show = (id, initial = false) => {
    const next = frames.has(id) ? id : "home";
    frames.forEach((frame, key) => {
      const active = key === next;
      frame.hidden = !active;
      if (active && !frame.getAttribute("src")) {
        frame.setAttribute("src", frame.dataset.src);
      }
    });
    localStorage.setItem(ACTIVE_KEY, next);
    const frame = frames.get(next);
    applyTheme(frame, getTheme());
    if (!initial) {
      requestAnimationFrame(() => frame.contentWindow?.focus());
    }
  };

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin && !(location.protocol === "file:" && event.origin === "null")) {
      return;
    }
    const data = event.data || {};
    if (data.type === "octopus-scene") {
      const clean = String(data.href || "").split("?")[0].split("#")[0];
      show(data.scene || HREF_TO_SCENE[clean] || "home");
    } else if (data.type === "octopus-theme") {
      const theme = data.theme === "dark" ? "dark" : "light";
      localStorage.setItem(THEME_KEY, theme);
      applyThemeAll(theme);
    }
  });

  frames.forEach((frame) => {
    frame.addEventListener("load", () => applyTheme(frame, getTheme()));
  });

  applyThemeAll(getTheme());
  show(localStorage.getItem(ACTIVE_KEY) || "home", true);
})();
