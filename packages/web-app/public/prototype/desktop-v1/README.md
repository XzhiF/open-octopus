# Octopus Desktop — v1 prototype

A static, no-build redesign of Octopus as a **windowed workbench** instead of a routed web app.

Direction: **Codex-quiet** — graphite surfaces, 1px hairlines, one warm bone accent, monospace data, no decorative chrome. The important change is not visual: navigation no longer replaces the screen. Workflows, runs, agents, tasks, wiki pages and settings are windows with independent lifecycles.

## Open it

- Direct: open `index.html` in a browser.
- Through the dev server: `pnpm dev`, then <http://localhost:3000/prototype/desktop-v1/index.html>.
- Start anywhere from the left rail; every scene is standalone.

Designed at **1440×900**. On shorter displays (< ~820px canvas height) the shell scales the authored arrangement once so windows stay reachable. Drag or use **Windows → Reset layout** to recover.

## Scenes

| File | What it shows |
| --- | --- |
| `index.html` | Workbench: Today, main agent chat, live runs, minimized inbox |
| `workspaces.html` | Space list (live/idle/cold), create workspace, archive preview |
| `workspace.html` | Workflow canvas + YAML/files + run inspector + terminal |
| `agent.html` | Session list, conversation, run context / memory / tools |
| `tasks.html` | Task board, phase spec, acceptance gate |
| `runs.html` | Execution graph (loops), cost & tokens, live logs, harness |
| `scheduler.html` | Cron jobs, next-trigger queue, scheduler chat, job history |
| `knowledge.html` | Wiki tree, compiled article, curator inbox |
| `resources.html` | Skill library, resource detail, git sources |
| `settings.html` | Preferences, model config, billing, harness |
| `design.html` | Principles, tokens, window model and shortcuts |

## Window model

A window is a **view over durable state** — never the state itself.

- **Close ≠ cancel.** Closing releases the view. Runs keep streaming and can be reopened from the palette.
- **Minimize to the shelf.** The bottom dock keeps every open window reachable.
- **Mission Control** shows every window, including minimized ones, with live previews.
- **Scenes are desktops.** Rail navigation switches spaces; each scene remembers its own window positions, sizes, active tab, minimized and closed state in `localStorage`.
- **Cross-window comparison** is the default: a run can stay open while you read its logs, cost, harness or task spec.

### Interactions

| Action | How |
| --- | --- |
| Move / focus | Drag a title bar |
| Resize | Drag the bottom-right handle |
| Snap | Drag to left/right edge or top |
| Maximize | Double-click title bar, or the title-bar button |
| Minimize / restore | Title-bar button, or click its dock icon |
| Reopen closed | `⌘K` / `Ctrl+K`, search the window title |
| Mission Control | `Ctrl+Shift+M` or the top-bar grid button |
| Tile / cascade / reset | Windows menu, or `⌥T` for tile |
| Theme | Top-bar sun/moon; graphite + warm bone light |

## Design rules

1. **Context is the product** — at least 3–4 active windows per scene, plus the shelf.
2. **Quiet by default** — color marks state only; focus is a 1px lift, not a glow.
3. **Window, not page** — every durable object gets a lifecycle.
4. **Data in mono, prose in sans** — IDs, tokens, cost, times use tabular figures.
5. **Native-first** — the same model maps to Tauri/Electron: in-app windows first, detachable OS windows later.

## Implementation

- `assets/app.css` — tokens, themes, window chrome, all scene modules.
- `assets/app.js` — shell injection, drag/resize/snap, shelf, mission control, command palette, layout presets, persistence, auto-fit.
- Shared SVG sprite is injected by the shell — no icon dependency.
- Fake data only; wire to the existing REST/SSE APIs by replacing window content. A window should bind to a resource id, not own the resource.

### Suggested next steps

1. Port the shell into the real app as a `WindowCanvas` + `WindowShelf` pair.
2. Replace scene data with existing fetchers/SSE; keep window identity stable per resource.
3. Persist scroll/tab/cursor in the server-side window session, not just `localStorage`.
4. Add keyboard focus order + ARIA dialog semantics to Mission Control and the palette.
5. Wrap with Tauri when the in-app window model is stable; offer “detach to OS window” as an opt-in.
