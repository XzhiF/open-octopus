# Octopus Desktop — v2 prototype

A quieter direction for the windowed workbench. The point is not more windows. The point is **one desktop whose views stay alive**.

## Open it

- Direct: open `index.html` in a browser.
- Through the dev server: `pnpm dev`, then <http://localhost:3000/prototype/desktop-v2/index.html>.
- `desktop-v1/` is left untouched for comparison.

## What changed

- **One desktop, not one desktop per rail item.** The left rail opens or focuses a view. It never navigates to a new scene and never creates another desktop.
- **The dock shows open views, not running tasks.** Clicking a dock item focuses that view. Closing a view removes it from the dock.
- **Split is the combination model.** Use `Split` to show two views side by side. Click either pane first to choose where the next view lands.
- **Views are mounted once.** Switching hides a view instead of remounting it. Chat draft, scroll position, task input, wiki page, and run state survive the switch.
- **No page reloads.** The shell changes visibility, not routes. Reloading the browser also restores the layout, draft, and tasks from local storage.
- **Core surfaces are dense, not decorative.** The task board has four lanes and a working inspector. Runs have a run list, graph, timeline, logs, metrics, and controls.
- **Less chrome.** Warm paper by default, one accent, 15px body text, fewer pills, no grids or glows.

## Core surfaces

- **Today** — continue, running, needs-you, and a board snapshot.
- **Tasks** — Queued / Executing / Verify / Done lanes, task inspector, phases, acceptance checks, approve/reject, inline add.
- **Runs** — run list, selected run, elapsed/cost/tokens/nodes, Graph / Timeline / Logs tabs, pause/resume/abort, recent events.
- **Chat** — mounted conversation, draft persistence, background run status.
- **Wiki** — tree + compiled article, page and scroll preserved.
- **Settings** — theme, reset, storage.

## Interactions

| Action | How |
| --- | --- |
| Open / focus a view | Left rail or dock |
| Replace the active pane | Click the pane, then open a view |
| Split / unsplit | `Split` in the bottom-right |
| Close a view | `×` in the pane header |
| New task | Today → `New task`, or Tasks → Queued lane input |
| Select a task | Click a board card; inspector opens on the right |
| Approve / reject | Task inspector buttons |
| Open run from task | Task inspector → `Open run` |
| Select / inspect a run | Runs list → pick a run |
| Run tabs | Graph / Timeline / Logs |
| Pause / resume / abort | Run detail header controls |
| Change theme | Top bar sun/moon, or Settings |
| Reset prototype | Settings → `Reset layout` |

## Files

- `index.html` — shell, rail, two pane slots, dock.
- `assets/app.css` — tokens, shell, views, split layout, light/dark themes.
- `assets/app.js` — view cache, open/focus/split, chat draft, tasks, wiki, localStorage.
