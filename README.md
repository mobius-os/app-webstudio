# Web Studio

A VSCode-shaped website builder for [Möbius](https://github.com/mobius-os). Describe your site in the chat panel; the embedded agent edits your HTML, CSS, and JS files directly. Hit Build and preview the assembled site in the in-app browser — all in one screen.

## Key features

- **Live file tree** — the app icon toggles a docked desktop rail or compact slide-in drawer with New file, New folder, Upload, and per-file drag-to-move, rename, and delete. Long-press (mobile) or right-click (desktop) opens the same context menu.
- **Source editor** — CodeMirror 6 with history, line-wrap, and tab-indent. Debounced autosave at 700 ms. Only the app's own metadata files (`files-index.json`, `main.json`, `chat_id.json`, `build/status.json`, `build/dispatch.json`) are read-only so the editor can never corrupt them; every file you create under `files/` — including `.json` — is editable source.
- **Build + preview** — a server-side `build.sh` assembles the whole site under `build/site/`; the app rebuilds on its own when an agent turn (or a pending autosave) leaves the source changed since the last build, so you never have to press Build to see what the agent just did; the preview renders the main HTML page in a sandboxed iframe via `srcdoc` with all assets inlined as blob URLs. On desktop, drag the source/preview divider (or focus it and use the arrow keys) to rebalance the workspace. The sandbox grants `allow-scripts allow-popups` only — the generated site can never reach the app's storage token or localStorage.
- **Page notes** — hit the pencil in the Preview and click any element to pin a short instruction to it ("make this heading bigger"). Notes show as numbered pins drawn inside the preview frame, persist per project in `comments.json`, and **Send** hands the whole batch to the agent as one turn. Each note carries the element's own markup so the agent finds it in source itself, rather than trusting a selector taken from the built page. Sending opens the chat so the turn is visible, confirms on screen, and then watches for the agent's edits and rebuilds — so a note becomes a rebuilt page with no further input. Sent pins clear, so a pin always means "not yet addressed".
- **Embedded agent chat** — powered by `window.mobius.chat`; the agent has `build.sh`, the Möbius storage API, and the embedded-app-agent skill. A draggable resizer splits the editor and the chat panel. The drag survives the pointer crossing the preview iframe (pointer capture).
- **Offline-resilient editing** — the Möbius storage runtime owns the durable cache and queued writes; Web Studio keeps only a bounded in-memory buffer for recently opened text files. Sync is silent while online; a plain "Offline" pill appears only when you lose connectivity.

## Install

### Via the App Store (recommended)

Open the **App Store** mini-app in Möbius, search for "Web Studio", and tap **Install**.

### Via paste-a-URL

In the App Store, choose **Install from URL** and paste:

```
https://raw.githubusercontent.com/mobius-os/app-webstudio/main/mobius.json
```

## Storage layout

All paths are under `/api/storage/apps/<id>/` (the app's own storage — no cross-app access).

Project-scoped paths for a non-default project are prefixed `projects/<id>/`
(e.g. `projects/portfolio/files/index.html`); the `default` project is
unprefixed. `<data>` below stands for the app-metadata files that hold typed
JSON (read/written envelope-free), distinct from user files under `files/`
which are editable text or binary — including a user's own `files/data.json`.

| Path | Type | Purpose |
|------|------|---------|
| `files/<path>` | text or binary | Website source files: `index.html`, `style.css`, `app.js`, images, fonts, and any `.json` you author — all editable source. |
| `projects.json` | JSON array | The project list (`[{id, name, createdAt}]`), stored at the app root (shared across projects). |
| `files-index.json` | JSON array | Canonical ordered list of every path under `files/`. UI and agent changes merge with conditional writes, and an absent index is reconstructed from `storage.list()` rather than from a guessed filename. |
| `main.json` | JSON `{path: string}` | The designated main HTML page. The Preview renders this page; Build assembles the whole site with this page as the entry. Defaults to `files/index.html`. |
| `build/target.txt` | text | The HTML entry path written by the app before kicking `build.sh`, so the script knows which page is the root. |
| `build/status.json` | JSON | Build verdict written by `build.sh`: `{status: "done"\|"error", entry: string, target: string, log?: string, built_at?: string}`. The app polls this at 2-second intervals until a verdict appears or a 2-minute timeout elapses. |
| `build/dispatch.json` | JSON `{target, at}` | App-wide build claim written at the app root. A second build sees a fresh claim for a different target and refuses rather than racing the shared root `build/target.txt`, so two tabs/devices can't silently build the wrong project. |
| `build/site/<path>` | static files | The assembled site mirror. The preview inlines these via blob URLs; the tree does not show them (build output is not source). |
| `comments.json` | JSON array | Page notes pinned in the Preview (`[{id, selector, label, html, page, note}]`). Written by the pin UI and cleared on send; app metadata, so the editor keeps it read-only. |
| `publish-url.txt` | text | Last published URL, cached so the drawer's publish row can show it on reload. |
| `chat_id.json` | JSON `{id: string}` | The UUID of the embedded-agent chat, so a reloaded app reconnects to the same conversation. Written by `window.mobius.chat` on first open. |

## Agent interaction model

The embedded agent (`window.mobius.chat`) runs in its own chat thread persisted in `chat_id.json`. On each turn:

1. The agent reads/writes files under `files/` using the Möbius storage API (Edit and Write tools through the embedded-app-agent skill).
2. It keeps `files-index.json` in sync whenever it creates or removes a path.
3. It can trigger `build.sh` via `POST /api/apps/<id>/run-job` to assemble the site.
4. The app polls `build/status.json` and flips the viewer to Preview when a `done` verdict lands.

The build itself is never left to step 3 alone. When a turn ends the app
fingerprints `files/` (each path with its size and `modified_at`) and compares
it against the fingerprint of the build currently backing the preview; if they
differ, the app kicks the build itself through the same dispatch claim the
Build button uses. An agent that already built is detected by its verdict and
not rebuilt; a turn that only answered a question changes no fingerprint and
builds nothing.

Text and binary files keep their native storage kinds instead of passing through
one universal document model. Live text subscriptions make agent edits appear in
an open editor; shared list documents (`files-index.json` and `projects.json`)
use compare-and-swap retries so another tab or agent cannot be erased by a late
whole-array write. This is collaboration-safe convergence, not multi-user cursor
presence or character-level coauthoring.

### Page notes

The preview is a `srcdoc` frame without `allow-same-origin`, so the parent can
neither read the site's DOM nor measure an element. Annotation therefore runs
entirely inside the frame: an injected script derives a selector for the
clicked element, draws the numbered pins, and talks to the app only by
`postMessage`. The app owns the note list and re-posts it whenever it changes.
Mode is toggled by message rather than by re-rendering `srcdoc`, so turning
annotation on never remounts the page or loses scroll position.

Because the built site is a verbatim copy of `files/`, a selector taken from
the built page addresses the same element in the source file — which is what
makes a pin actionable. **Send** posts the batch into the app's own embedded
chat (an app token may send to a chat it created), so the notes arrive as a
normal user turn in the panel the user is already looking at.

Vague prompts like "build me a portfolio site" or "add a dark-mode toggle" are enough. The agent handles file creation, HTML/CSS/JS edits, asset placement, and builds without additional instructions.

## Dev loop

Web Studio is a multi-file React mini-app: `index.jsx` is the entry and the
module tree is declared in `mobius.json`'s `source_files` (the installer fetches
each file and Rolldown bundles from the entry). To iterate locally:

```bash
npm install     # react — dev tooling only; the app ships via source_files
npm run smoke   # compile-smoke the whole module tree (no output = success)
npm test        # unit tests + the headless-browser mount test
```

`npm run smoke` only parses and links: it accepts a component that is
referenced but never imported, because that is a ReferenceError at RENDER time.
`tests/mount.test.mjs` closes that gap — it bundles the app the way Möbius
compiles it and mounts it in headless chromium (with IndexedDB denied, as in
the real opaque-origin frame), asserting the app actually paints and raises no
errors. It skips when the shared frontend `node_modules` or a chromium binary
is missing; set `CHROMIUM_PATH` to force it on.

The smoke check and tests use the shell's Rolldown install. They auto-discover a
live `/data/platform` checkout or a sibling `.mobius` checkout; CI can set
`MOBIUS_FRONTEND_NODE_MODULES` explicitly.

Install into a running Möbius instance via the App Store URL or
`POST /api/apps/install`.

## Version history

| Version | Changes |
|---------|---------|
| 0.14.0 | Page notes — pin short instructions to elements in the Preview and send the batch to the agent as one turn. The app rebuilds itself after an agent turn that changed `files/`, the preview reads freshly built bytes so a finished build is what you see, and a headless-browser mount test guards render-time faults. |
| 0.13.4 | Desktop file drawer can be toggled; source/preview split is draggable and keyboard-adjustable. |
| 0.12.4 | Reliability + observability pass. Switching files no longer lets a pending autosave overwrite the newly selected file; user-created `.json` files under `files/` are editable source (only app metadata stays read-only); builds serialize app-wide via a dispatch claim so concurrent builds can't silently time out; the offline pill is mounted (silent when healthy); renamed main pages ask for a rebuild instead of a phantom preview; builds prune `node_modules`; folder upload is reachable; the choose modal resolves consistently on dismiss. Adds app signals for Reflection and a portable `npm install && npm test`. Touch-target (44px), radius-scale, and theme-token cleanups. |
| 0.12.3 | Modularized: split `index.jsx` into a `source_files` module tree. |
| 0.12.0–0.12.2 | Data-loss + a11y fixes from the closing review; preview no longer black-flashes when toggling chat; drag/drop + folder-collision guards; inline set-main. |
| 0.11.0 | Inline project rename + new-project, no modals. |
| 0.5.0 | Preview no longer breaks the shell or dead-ends links. Site `<script src>` is inlined as text (a blob: src is blocked from the null-origin srcdoc, so the site's JS — and its links/interactions — never ran); the injected click handler now scrolls in-page `#anchor` clicks itself instead of letting them push phantom entries into the session history the shell back-stack relies on (which desynced the owner's drawer / back-gesture). Chat-pane resize floored at the composer pill (list collapses to zero, pill always visible) — same `clampChatRatio` as app-latex / app-editor. Top-bar logo is now an inline SVG (instant paint, zero network) instead of `<img src=/api/apps/<id>/icon>`. |
| 0.2.6 | Native-feel pass: seven balanced mobius-ui CSS fences, -webkit-tap-highlight-color + touch-action manipulation on all interactive chrome, user-select none on file tree / toolbar / context menu, :active feedback on buttons, hover behind @media (hover:hover) for tree rows. Improvements: setPointerCapture on chat-panel resize drag (survives iframe crossing), overscroll-behavior contain on build log + root + tree, aria-label="Agent chat" on chat section. |
| 0.2.5 | Icon quantization + drawer bare logo-toggle + swipe-to-close |
| 0.2.4 | Borderless tree icons + pressed state on ⋯ menu |
| 0.2.3 | App logo as file-drawer toggle; icon route fallback |
| 0.2.2 | Uniform file drawer; agent skill + thin prompt |
| 0.2.1 | Agent picker, icon toolbar, discoverable file actions |
| 0.2.0 | CodeMirror plain editor migration |

## License

MIT — see [LICENSE](LICENSE).
