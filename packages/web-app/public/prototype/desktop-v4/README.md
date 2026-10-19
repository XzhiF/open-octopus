# Octopus Desktop — v4 prototype

A complete desktop shell for agentic work: **Spaces**, persistent **windows**, a
global **main agent**, a dock, command palette, Mission Control, and a launcher.

v1, v2 and v3 are kept for comparison.

## Open it

- Direct: open `index.html` in a browser.
- Through the dev server: `pnpm dev`, then <http://localhost:3000/prototype/desktop-v4/index.html>.

## Desktop model

```text
top bar      space switcher · command / ask · runs · notifications · theme
desktop      floating windows with drag, resize, snap, minimize, maximize
dock         open windows in the current space + global agent
launcher     all apps
mission      previews for every open window in the current space
```

- **Space** = project desktop. Each space has its own window layout, tasks, runs,
  and selected task/run. Switching does not reload the windows.
- **Window** = a durable view. Close releases the view; the task/run behind it
  keeps going. Reopen from the launcher or dock.
- **Global agent** = the main-agent window is global and stays available across
  spaces. `Ask` opens it; `⌘J` does the same.
- **Dock** = open windows, not app navigation. Clicking a dock item focuses it or
  minimizes the focused window.
- **Launcher** = app grid. **Mission Control** = overview and window switching.

## Apps

| App | What it does |
| --- | --- |
| Today | Running, needs-you, and board snapshot |
| Tasks | Four-lane task board; selecting a card opens the task inspector window |
| Task inspector | Phases, acceptance checks, approve/reject, open run |
| Runs | Run list, execution graph, timeline, logs, cost/tokens, pause/abort |
| Main agent | Persistent global chat with draft and messages |
| Wiki | Compiled knowledge, tree, article |
| Artifacts | Specs, reports, diffs, and generated files |
| Spaces | Project desktop switcher |
| Settings | Theme, reset, shortcuts |

## Shortcuts

| Key | Action |
| --- | --- |
| `⌘K` / `Ctrl+K` | Command palette; type to ask main |
| `⌘J` / `Ctrl+J` | Open main agent |
| `⌘⇧M` / `Ctrl+Shift+M` | Mission Control |
| `⌥T` | Tile windows in the current space |
| `Alt+1/2/3` | Switch space |
| `Esc` | Close overlays |

## State

- Window geometry, minimized/closed state, and active space live in `localStorage`.
- Task/run data and selected items persist per space.
- Views are mounted once; switching spaces hides a layer instead of remounting.
- Runs keep their tab/scroll state while hidden.

## Files

- `index.html` — top bar, desktop layers, dock, overlays.
- `assets/app.css` — shell, window chrome, dock, launcher, palette, mission, app views.
- `assets/app.js` — window manager, spaces, apps, task/run data, persistence, agent.

## Next for a native shell

This is still a browser prototype. The final desktop shell can move the same
window/session model into Tauri or Electron, with native menus, tray, detachable
windows, and multi-monitor support.
