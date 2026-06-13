# Web Studio

A VSCode-shaped website builder for [Möbius](https://github.com/mobius-os). Describe your site in the chat panel; the embedded agent edits your HTML, CSS, and JS files directly. Hit Build and preview the assembled site in the in-app browser — all in one screen.

## Key features

- **Live file tree** — slide-in left drawer with New file, New folder, Upload, and per-file drag-to-move, rename, and delete. Long-press (mobile) or right-click (desktop) opens the same context menu.
- **Source editor** — CodeMirror 6 with history, line-wrap, and tab-indent. Debounced autosave at 700 ms. Managed files (`.json`) shown read-only so the editor can never corrupt the app's own metadata.
- **Build + preview** — a server-side `build.sh` assembles the whole site under `build/site/`; the preview renders the main HTML page in a sandboxed iframe via `srcdoc` with all assets inlined as blob URLs. The sandbox grants `allow-scripts allow-popups` only — the generated site can never reach the app's storage token or localStorage.
- **Embedded agent chat** — powered by `window.mobius.chat`; the agent has `build.sh`, the Möbius storage API, and the embedded-app-agent skill. A draggable resizer splits the editor and the chat panel. The drag survives the pointer crossing the preview iframe (pointer capture).
- **Offline-resilient editing** — file index and last-edited file content are stored in localStorage. Reads are cache-first offline; writes queue and drain when back online (via `window.mobius.storage`). An inline sync pill surfaces pending writes.

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

| Path | Type | Purpose |
|------|------|---------|
| `files/<path>` | text or binary | Website source files: `index.html`, `style.css`, `app.js`, images, fonts, … |
| `files-index.json` | JSON array | Canonical list of every path under `files/`. The storage API has no listing endpoint, so the app maintains this index; the agent is instructed to keep it in sync when it creates or deletes files. |
| `main.json` | JSON `{path: string}` | The designated main HTML page. The Preview renders this page; Build assembles the whole site with this page as the entry. Defaults to `files/index.html`. |
| `build/target.txt` | text | The HTML entry path written by the app before kicking `build.sh`, so the script knows which page is the root. |
| `build/status.json` | JSON | Build verdict written by `build.sh`: `{status: "done"\|"error", entry: string, target: string, log?: string, built_at?: string}`. The app polls this at 2-second intervals until a verdict appears or a 2-minute timeout elapses. |
| `build/site/<path>` | static files | The assembled site mirror. The preview inlines these via blob URLs; the tree does not show them (build output is not source). |
| `chat_id.json` | JSON `{id: string}` | The UUID of the embedded-agent chat, so a reloaded app reconnects to the same conversation. Written by `window.mobius.chat` on first open. |

## Agent interaction model

The embedded agent (`window.mobius.chat`) runs in its own chat thread persisted in `chat_id.json`. On each turn:

1. The agent reads/writes files under `files/` using the Möbius storage API (Edit and Write tools through the embedded-app-agent skill).
2. It keeps `files-index.json` in sync whenever it creates or removes a path.
3. It can trigger `build.sh` via `POST /api/apps/<id>/run-job` to assemble the site.
4. The app polls `build/status.json` and flips the viewer to Preview when a `done` verdict lands.

Vague prompts like "build me a portfolio site" or "add a dark-mode toggle" are enough. The agent handles file creation, HTML/CSS/JS edits, asset placement, and builds without additional instructions.

## Dev loop

The app is a single-file React mini-app. To iterate locally:

```bash
# Compile smoke test (no output means success)
esbuild index.jsx \
  --bundle --format=esm --jsx=automatic --platform=browser \
  --external:react --external:react/jsx-runtime \
  --external:react-dom --external:react-dom/client \
  --external:"@codemirror/state" --external:"@codemirror/view" \
  --external:"@codemirror/commands" --external:"@codemirror/language" \
  --outfile=/tmp/webstudio-smoke.js
```

Expected output: ~107.6 KB, 0 errors. Install into a running Möbius instance via the App Store URL or `POST /api/apps/install`.

## Version history

| Version | Changes |
|---------|---------|
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
