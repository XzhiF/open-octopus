# Octopus Desktop v9 — Tasks owns the execution surface

Starting point: v8. No copied workbench shell. V9 keeps v8's floating-window model and removes the global execution navigation.

## Open it

- <http://localhost:4173/prototype/desktop-v9/tasks.html>
- `pnpm dev` → <http://localhost:3000/prototype/desktop-v9/tasks.html>

## What changed

### Removed from global navigation
- Left rail **Workspaces / Spaces** section removed.
- Apps **Runs** removed.
- Topbar Workspace chip removed.
- `Alt+1..3` workspace jump removed.

### Tasks now owns Task → Workspace → Execution

```text
Tasks board
  click a task
    -> Task Workspace window
         click a run
           -> Run window
```

- Every task card opens a **new Workspace-like window**.
- The Task Workspace window has:
  - task status, progress, run count, spend;
  - workspace branch / server / web / DB;
  - Runs list on the left;
  - workspace flow + terminal in the stage.
- Clicking any run row opens a **Run window** on top of the Task window.
- Run window contains metrics, execution graph, steps, events and attach terminal.
- All of this happens inside the **Tasks** page. No route change, no separate Workspaces/Runs app.
- Closing the Run window leaves the Task workspace open; closing the Task workspace leaves the board.
- Dynamic task/run windows use the same drag, resize, minimize, maximize, dock, mission-control and organize logic as static windows.
- Dynamic task/run windows are session-only: static v8 windows persist, task popups do not survive reload yet.

## What was preserved
- v8 visual language, type scale, light theme, eight-way resize, tray/dock, window persistence for static scenes.
- Tasks, Agent, Schedule, Wiki, Library, System.
- `workspaces.html` / `workspace.html` / `runs.html` remain as unlinked legacy files; they are not reachable from V9 navigation.

## Data
- `desktop` task: `feat-desktop-shell`, 4 runs (`e2f1`, `e2ef`, `e2e4`, `e2e1`).
- Other task cards map to one workspace and 0–1 run so every card can be opened and inspected.
- Run statuses: running / passed / failed / waiting.

## Files
- `assets/app.js` — v8 shell + dynamic `spawnWindow` + window registration.
- `assets/taskwins.js` — task workspace window, run window, card/run click wiring.
- `assets/taskwin.css` — new task/run window surfaces.
- `tasks.html` — board only; old static Task detail window removed.
