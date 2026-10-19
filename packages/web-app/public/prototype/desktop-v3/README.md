# Octopus Desktop — v3 prototype

A fork of **desktop-v1** with the v1 multi-window presentation intact, plus a
lighter visual system and persistent scene switching.

## Open it

- Direct: open `index.html` in a browser.
- Through the dev server: `pnpm dev`, then <http://localhost:3000/prototype/desktop-v3/index.html>.
- v1 and v2 are kept for comparison.

## What changed from v1

- **Scenes no longer reload.** `index.html` hosts one iframe per scene. Rail
  navigation posts a message to the host, which shows the target iframe. Each
  scene keeps its windows, scroll, tabs, and drafts mounted.
- **Warm paper is the default.** The v1 bone/graphite themes remain available.
- **Larger type.** Body copy, window titles, tables, chat, boards, logs, and wiki
  articles have been raised so the desktop reads at normal distance.
- **Quieter chrome.** Flat top bar and rail, no canvas dot grid, softer windows,
  one accent, and the same v1 bones.
- **Design notes removed.** The meta `design.html` page and rail link are gone.
- **v1 interactions stay.** Drag, resize, snap, minimize, shelf, tile/cascade,
  Mission Control, command palette, and per-window tabs all work.

## Scene model

- Left rail = scene switch, not a new app.
- Each scene keeps its own authored window arrangement.
- Dock = windows in the current scene; closed windows can be reopened from the palette.
- Mission Control previews the current scene.
- Switching scenes does not remount or reload the iframe.

## Files

- `index.html` — iframe host; one frame per scene.
- `home.html`, `workspaces.html`, … — v1 scene pages, adapted only for embedded navigation.
- `assets/host.css`, `assets/host.js` — scene host, active scene, theme fan-out.
- `assets/app.css`, `assets/app.js` — v1 window engine plus v3 visual overrides and iframe navigation.
