import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands'

// Web Studio renders its build into a SANDBOXED iframe via srcdoc with NO
// allow-same-origin token, so the generated site can never read this app's
// localStorage / token or reach the storage API. We rewrite the built page's
// relative asset refs into blob:/data: URLs (HtmlPreview below) so the single
// page renders self-contained without granting same-origin. The source editor
// shows raw text in CodeMirror (no markup interpretation — it edits HTML/CSS/JS
// source as plain text), so no DOMPurify is needed in the bundle.

// Allowed characters for any storage path the UI writes. NAME_RE mirrors the
// server's `_SAFE_RE` (`[\w.\-/]+`); isSafeRelPath adds browser-side semantic
// guards (`.` / `..`, empty segments, absolute paths) so user input can never
// escape the app's files/ tree before it reaches storage.
const NAME_RE = /^[\w.\-/]+$/
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export const projectPrefix = (id) => (id === 'default' ? '' : `projects/${id}/`)

function isSafeProjectId(id) {
  return typeof id === 'string' && PROJECT_ID_RE.test(id)
}

function prefixedPath(prefix, path) {
  return `${prefix || ''}${path}`
}

export function isSafeRelPath(path) {
  const value = typeof path === 'string' ? path.trim() : ''
  if (!value || value.startsWith('/') || value.includes('\\')) return false
  if (!NAME_RE.test(value)) return false
  const parts = value.split('/')
  // Reject a leading dash in any segment: build.sh treats a leading-dash target
  // as a CLI flag and refuses it, so allowing it here would create a file the
  // app shows + lets you set as main but can never build (opaque error).
  return parts.every((part) => part && part !== '.' && part !== '..' && !part.startsWith('-'))
}

export function isSafeStoragePath(path) {
  return typeof path === 'string'
    && path.startsWith('files/')
    && isSafeRelPath(path.slice('files/'.length))
}

const BINARY_FILE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'pdf', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'mp4', 'webm'])

function extensionFor(path) {
  return String(path || '').split('.').pop().toLowerCase()
}

function isBinaryProjectPath(path) {
  return BINARY_FILE_EXTS.has(extensionFor(path))
}

function isTextProjectPath(path) {
  return isSafeStoragePath(path)
    && !path.endsWith('/.keep')
    && !isBinaryProjectPath(path)
}

// `.json` paths under the project (files-index.json, main.json, chat_id.json,
// and any .json the user makes) are MANAGED files: every other reader loads
// them with the typed JSON getter, which throws assertReadKind if they were
// written as text/plain. The text editor's debounced autosave writes
// text/plain, so editing a .json as source would corrupt it for every other
// reader. We make .json paths read-only in the editor instead — shown as
// source, but never autosaved back as text.
function isManagedJsonPath(path) {
  return String(path || '').toLowerCase().endsWith('.json')
}

// Is `path` an HTML entry the user could build? The Web Studio equivalent of
// LaTeX's `.tex` predicate. Build always assembles the whole site, but the
// "main" file is the HTML page the preview renders, so the settable main is
// restricted to .html/.htm files.
export function isHtmlDoc(path) {
  if (!isSafeStoragePath(path)) return false
  return path.endsWith('.html') || path.endsWith('.htm')
}

// First file to open when nothing is selected yet. The main page wins over
// alphabetical order: showHtmlControls requires selectedPath === mainPath,
// so opening anything else (e.g. files/about/index.html, which sorts before
// files/index.html) would hide the Build/Preview controls on first load.
// Then any HTML page, any editable text file, any non-placeholder entry.
export function pickAutoSelectPath(files, mainPath) {
  if (mainPath && files.includes(mainPath)) return mainPath
  return files.find((p) => isHtmlDoc(p))
    || files.find((p) => isTextProjectPath(p))
    || files.find((p) => !p.endsWith('/.keep'))
    || null
}

// Resolve a successful build's entry path for a given main doc. The build
// writes the rendered site under build/site/, mirroring the files/ tree, so
// the entry for files/index.html is build/site/index.html. We honour the
// status verdict's own `entry` when it targets the doc we asked for; otherwise
// we fall back to the deterministic path so a restored build still resolves.
export function entryFromBuildStatusForDoc(status, doc) {
  if (!status || typeof status !== 'object') return null
  if (status.status !== 'done') return null
  if (!isHtmlDoc(doc)) return null
  if (status.target && status.target !== doc) return null
  if (typeof status.entry === 'string' && status.entry.startsWith('build/site/')) {
    return status.entry
  }
  return null
}

// Deterministic entry path for a main HTML doc (files/index.html ->
// build/site/index.html). Used to restore a preview when the status verdict
// predates the `entry` field, or to probe whether a prior build exists.
export function entryPathForHtmlDoc(doc) {
  if (!isHtmlDoc(doc)) return null
  return `build/site/${doc.slice('files/'.length)}`
}

function cleanIndexPaths(paths) {
  return [...new Set((paths || []).filter(isSafeStoragePath))].sort()
}

export function normalizeFileCacheSnapshot(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const index = cleanIndexPaths(parsed.index)
  const indexSet = new Set(index)
  const contents = {}
  const rawContents = (parsed.contents && typeof parsed.contents === 'object')
    ? parsed.contents : {}
  for (const [path, body] of Object.entries(rawContents)) {
    if (indexSet.has(path) && typeof body === 'string') contents[path] = body
  }
  const lastPath = (typeof parsed.lastPath === 'string' && indexSet.has(parsed.lastPath))
    ? parsed.lastPath : null
  return { index, contents, lastPath }
}

// ----------------------------------------------------------------------
// Web Studio mini-app for Möbius — a VSCode-shaped website builder.
//
// Layout (mobile-first; the top bar + chat split are kept structurally
// IDENTICAL to app-latex):
//   - Top bar, three zones: LEFT = the app logo (toggles the left file
//     drawer) + the open file's name; CENTER = the chat toggle; RIGHT = a
//     [Source | Preview] view toggle and a play-triangle Build button (both
//     for the HTML entry; each icon button carries an aria-label + title).
//   - Left drawer: slides in over a backdrop from the left edge — the
//     file tree + New file/folder/Upload + per-file context actions
//     (rename / delete / set-as-main). Tapping a file or the backdrop
//     closes it.
//   - Main area: the SOURCE editor (CodeMirror, plain-text mode) OR the built
//     site (a sandboxed iframe), toggled. Images render inline.
//   - Chat: toggled from the top bar. Opening it splits the body 50/50 —
//     content above, a slim draggable divider in the middle, the embedded
//     agent chat below (composer pinned to the panel bottom). The user
//     describes the site in prose; the sub-agent edits files in
//     /data/apps/<id>/files/ via the Edit and Write tools.
//
// Storage layout (under /api/storage/apps/<id>/, pure app storage —
// scoped to THIS app, no owner FS API):
//   files/<path>           the site source: index.html, style.css, app.js, …
//   files-index.json       the canonical list of paths under files/.
//                          We maintain it because the storage API has
//                          no listing endpoint for apps; without it we
//                          would have to brute-force-probe paths.
//   main.json              {path: "files/<entry>.html"} — the designated
//                          MAIN page. Build assembles the whole site, and
//                          the Preview renders this page.
//   build/target.txt       the path build.sh assembles + reports `entry` for.
//   build/status.json      the build verdict (done|error, entry, target, …).
//   build/site/<...>       the assembled static site (files/ copied verbatim).
//   chat_id.json           {id: "uuid"} — the chat the sub-agent runs in.
// ----------------------------------------------------------------------

// Storage shim — prefer the runtime's offline-aware
// window.mobius.storage when present, fall back to direct fetch()
// against /api/storage on older shells. The runtime's `set/remove`
// resolve to `{synced:true}` (online, server ack'd) or `{queued:true}`
// (offline / network fail, IndexedDB outbox drains on `online`);
// `pendingCount()` exposes outbox depth so the header pill can surface
// unsynced work.
function makeStorage(appId, token) {
  const ms = (typeof window !== 'undefined' && window.mobius && window.mobius.storage) || null
  const hasRuntime = !!ms
  async function get(path) {
    // Read with the TYPED getter matching how the path was written: .json
    // paths hold JSON (get); everything else (.html, build/target.txt) is raw
    // text (getText). Mixing them throws assertReadKind in the runtime, so the
    // read kind MUST mirror the write kind (setText/setJSON below).
    if (ms) {
      const isJson = path.endsWith('.json')
      if (isJson && typeof ms.get === 'function') return ms.get(path)
      if (!isJson && typeof ms.getText === 'function') return ms.getText(path)
    }
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`get ${path} → ${r.status}`)
    const ct = r.headers.get('content-type') || ''
    if (ct.includes('application/json')) return r.json()
    return r.text()
  }
  async function getFresh(path) {
    // Direct server read. The runtime getter is cache-first for offline
    // work, which is what we want during editing, but a server-side agent can
    // update the same file behind that mirror. This path asks the backend for
    // the canonical bytes so the editor and the file on disk converge online.
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`get ${path} → ${r.status}`)
    const ct = r.headers.get('content-type') || ''
    if (ct.includes('application/json')) return r.json()
    return r.text()
  }
  async function getText(path) {
    // Like get(), but always returns text (never parses JSON). Used by the
    // preview to fetch the built HTML/CSS/JS bytes verbatim — a build/site
    // .json asset must come back as its raw source, not a parsed object.
    if (ms && typeof ms.getText === 'function') return ms.getText(path)
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`getText ${path} → ${r.status}`)
    return r.text()
  }
  async function getBlob(path) {
    if (ms && typeof ms.getBlob === 'function') return ms.getBlob(path)
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) return null
    return r.blob()
  }
  async function setText(path, text) {
    // Write through the runtime's TYPED text writer — ms.set is the JSON writer
    // (sends application/json + JSON.stringify), which corrupts/400s a .html or
    // build/target.txt save. ms.setText sends raw UTF-8 (text/plain). An older
    // runtime without setText falls through to the direct fetch below, which
    // also sends text/plain — so both paths agree on the wire shape.
    if (ms && typeof ms.setText === 'function') return ms.setText(path, text)
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: text,
    })
    if (!r.ok) throw new Error(`set ${path} → ${r.status}`)
    return { synced: true }
  }
  async function setBlob(path, blob, options = {}) {
    if (ms && typeof ms.setBlob === 'function') return ms.setBlob(path, blob, options)
    const contentType = options.contentType || (blob && blob.type) || 'application/octet-stream'
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body: blob,
    })
    if (!r.ok) throw new Error(`set ${path} → ${r.status}`)
    return { synced: true }
  }
  async function setJSON(path, obj) {
    if (ms && typeof ms.set === 'function') return ms.set(path, obj)
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    })
    if (!r.ok) throw new Error(`set ${path} → ${r.status}`)
    return { synced: true }
  }
  async function remove(path) {
    if (ms && typeof ms.remove === 'function') return ms.remove(path)
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok && r.status !== 404) throw new Error(`remove ${path} → ${r.status}`)
    return { synced: true }
  }
  async function move(from, to) {
    const r = await fetch(`/api/storage/apps/${appId}/move`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    })
    if (!r.ok) {
      let detail = ''
      try { detail = (await r.json()).detail || '' } catch { /* non-JSON */ }
      const err = new Error(`move ${from} → ${to} → ${r.status}${detail ? `: ${detail}` : ''}`)
      err.status = r.status
      err.detail = detail
      throw err
    }
    return { synced: true }
  }
  async function removeFolder(path) {
    const r = await fetch(`/api/storage/apps/${appId}/folder/${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok && r.status !== 404) {
      let detail = ''
      try { detail = (await r.json()).detail || '' } catch { /* non-JSON */ }
      const err = new Error(`remove folder ${path} → ${r.status}${detail ? `: ${detail}` : ''}`)
      err.status = r.status
      err.detail = detail
      throw err
    }
    return { synced: true }
  }
  async function list(prefix = '') {
    const out = []
    let cursor = null
    do {
      const qs = new URLSearchParams({ limit: '500' })
      if (cursor) qs.set('cursor', cursor)
      const r = await fetch(`/api/storage/apps-list/${appId}/${prefix}?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) throw new Error(`list ${prefix} → ${r.status}`)
      const data = await r.json()
      out.push(...(Array.isArray(data.entries) ? data.entries : []))
      cursor = data.next_cursor || null
    } while (cursor)
    return out
  }
  async function pendingCount() {
    if (ms && typeof ms.pendingCount === 'function') {
      try { return await ms.pendingCount() } catch { return 0 }
    }
    return 0
  }
  function subscribeText(path, cb) {
    if (ms && typeof ms.subscribeText === 'function') return ms.subscribeText(path, cb)
    return () => {}
  }
  return {
    get, getFresh, getText, getBlob,
    setText, setBlob, setJSON, remove,
    move, removeFolder, list,
    subscribeText,
    pendingCount,
    hasRuntime,
  }
}

function scopedStorage(storage, prefix) {
  const p = prefix || ''
  return {
    get: (path) => storage.get(prefixedPath(p, path)),
    getFresh: (path) => storage.getFresh(prefixedPath(p, path)),
    getText: (path) => storage.getText(prefixedPath(p, path)),
    getBlob: (path) => storage.getBlob(prefixedPath(p, path)),
    setText: (path, text) => storage.setText(prefixedPath(p, path), text),
    setBlob: (path, blob, options) => storage.setBlob(prefixedPath(p, path), blob, options),
    setJSON: (path, obj) => storage.setJSON(prefixedPath(p, path), obj),
    remove: (path) => storage.remove(prefixedPath(p, path)),
    move: (from, to) => storage.move(prefixedPath(p, from), prefixedPath(p, to)),
    removeFolder: (path) => storage.removeFolder(prefixedPath(p, path)),
    list: (path = '') => storage.list(prefixedPath(p, path)),
    subscribeText: (path, cb) => storage.subscribeText(prefixedPath(p, path), cb),
    pendingCount: () => storage.pendingCount(),
    hasRuntime: storage.hasRuntime,
  }
}

// ----------------------------------------------------------------------
// Image preview. The storage API requires a bearer token, so we
// fetch the file as a blob and convert to an object URL — <img src>
// can't carry an Authorization header.
// ----------------------------------------------------------------------
function ImagePreview({ storage, path }) {
  const [url, setUrl] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let live = true
    let revoke = null
    setUrl(null); setErr(null)
    storage.getBlob(path).then((blob) => {
      if (!live || !blob) {
        if (live) setErr('Image could not be loaded.')
        return
      }
      const u = URL.createObjectURL(blob)
      revoke = u
      setUrl(u)
    }).catch((e) => {
      if (live) setErr(e.message || 'Image load failed.')
    })
    return () => {
      live = false
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [storage, path])
  if (err) return <div className="ws-preview-note">{err}</div>
  if (!url) return <div className="ws-preview-note">Loading image…</div>
  return <img className="ws-img-preview" src={url} alt={path} />
}

// ----------------------------------------------------------------------
// HTML preview — the in-app browser (replaces LaTeX's pdf.js canvas).
//
// After a successful build we render the built page inside a SANDBOXED
// iframe via `srcdoc`. The sandbox grants `allow-scripts allow-popups
// allow-popups-to-escape-sandbox` only — NOT allow-same-origin (so the
// generated site can't read this app's localStorage / token or hit /api),
// NOT allow-modals (untrusted generated HTML shouldn't be able to
// alert/confirm-spam). allow-popups-to-escape-sandbox exists for external
// links: without it a target=_blank tab would INHERIT the sandbox and the
// external site would load with no same-origin (broken cookies/storage).
//
// Because there's no same-origin and no server route for build/site/,
// a plain `<a href>`/`<link href>`/`<script src>` inside the srcdoc has
// no base to resolve against. So we INLINE the page's same-build assets:
// fetch each referenced file that lives under build/site/ via storage and
// rewrite the reference to a blob:/data: URL the iframe can load without
// any origin. CSS is inlined into a <style>; JS into a blob-URL <script>;
// images/fonts into blob URLs; url() refs inside inline styles rewritten.
//
// Links inside the preview:
//   - same-site links to another BUILT PAGE (about.html, sub/, /pricing.html,
//     and the site root itself — "/" or "../" — which serves index.html)
//     navigate WITHIN the preview: a tiny injected script preventDefaults the
//     click and postMessages the resolved build/site/ path up to this
//     component, which re-renders the preview at that page (srcdoc can't
//     resolve relative navigation natively — there is no base URL).
//   - external links (http/https or //) get target=_blank rel=noopener
//     injected so they open in a NEW TAB instead of navigating (and killing)
//     the srcdoc preview.
//   - every OTHER schemeless link — a non-page asset, a ref that escapes the
//     site, anything unresolvable — is neutralised (href removed, inert
//     click) rather than left to natively navigate the frame away. Only
//     #anchors and ALLOWLISTED schemes (mailto:, tel:) keep native behavior;
//     dangerous schemes (javascript:, data:, vbscript:, …) are neutralised.
// The full policy is anchorActionFor below.
//
// `version` (the build token) is in the deps so a rebuild that produces
// the SAME deterministic entry path still refetches + re-renders the
// fresh bytes (and resets any in-preview navigation back to the entry).
// ----------------------------------------------------------------------

// Resolve an asset reference (possibly relative, ./ or bare) against the
// directory of the page being previewed, returning a storage path under
// build/site/ — or null if it escapes the site, is absolute (http/data),
// or otherwise isn't an in-site relative ref we should inline.
export function resolveSiteAsset(ref, entryPath) {
  if (typeof ref !== 'string') return null
  const raw = ref.trim()
  if (!raw) return null
  // External, protocol-relative, in-page anchors, data/blob, and mailto/tel
  // are left untouched — only same-build RELATIVE refs get inlined.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null // has a scheme (http:, data:, mailto:, …)
  if (raw.startsWith('//')) return null                  // protocol-relative
  if (raw.startsWith('#')) return null                   // in-page anchor
  // Strip any query/hash so build/site/style.css?v=2 resolves to the file.
  const clean = raw.split('#')[0].split('?')[0]
  if (!clean) return null
  const baseDir = entryPath.slice(0, entryPath.lastIndexOf('/')) // "build/site" or "build/site/sub"
  // Root-relative ("/style.css") maps to the site root; otherwise resolve
  // against the page's directory. Then normalise away ./ and ../ segments.
  const startParts = clean.startsWith('/')
    ? ['build', 'site']
    : baseDir.split('/')
  const segs = clean.replace(/^\/+/, '').split('/')
  const stack = [...startParts]
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      // Never climb above build/site — that would read app metadata.
      if (stack.length > 2) stack.pop()
      continue
    }
    stack.push(seg)
  }
  const resolved = stack.join('/')
  // The site root itself — href="/" or a "../" chain landing on it — serves
  // its index page, exactly like a real web server. Without this mapping the
  // bare "build/site" string fails the prefix guard below and a home link
  // falls through as unresolvable.
  if (resolved === 'build/site') return 'build/site/index.html'
  if (!resolved.startsWith('build/site/')) return null
  return resolved
}

// Decide what the preview should do with an <a href> on the page being
// rendered. Pure (strings in, action out) so the rewrite policy is testable
// without a DOM. The invariant callers rely on: NO schemeless href is ever
// left live — the preview is a sandboxed srcdoc iframe, so a native relative
// navigation has no site to land on (blank pane in the sandbox; the shell
// origin in production).
//   { kind: 'external' }                 → http(s):// or //…: open a NEW TAB
//                                          (a plain click would navigate, and
//                                          kill, the srcdoc preview)
//   { kind: 'internal', target: <path> } → built page (directory-shaped refs
//                                          like about/ or /docs resolve to
//                                          their index page): in-preview
//                                          navigation via the injected script
//   { kind: 'keep' }                     → #anchor or an ALLOWLISTED scheme
//                                          (mailto:, tel:) whose native
//                                          behavior is already safe
//   { kind: 'neutralise' }               → everything else — same-site
//                                          non-page asset, ref escaping the
//                                          site, empty or query-only href, AND
//                                          any non-allowlisted scheme
//                                          (javascript:, data:, vbscript:,
//                                          blob:, file:, …) — drop the href so
//                                          the click is inert
//
// Scheme policy is allowlist, not denylist: only the schemes we have vetted as
// safe to navigate natively (mailto, tel) keep their href. http(s) and
// protocol-relative are handled as 'external' above. EVERY other scheme is
// neutralised — including the dangerous ones (javascript:, data:, vbscript:)
// that could execute in or escape the preview. The srcdoc iframe runs with
// `allow-scripts` (no allow-same-origin), so a live `javascript:` href would
// still execute inside the sandbox; stripping the href is defense in depth so
// the policy holds regardless of the sandbox flags or where the preview runs.
const KEEP_SCHEMES = new Set(['mailto', 'tel'])
export function anchorActionFor(href, pageEntry) {
  const raw = typeof href === 'string' ? href.trim() : ''
  if (/^(?:https?:)?\/\//i.test(raw)) return { kind: 'external' }
  const sitePath = resolveSiteAsset(raw, pageEntry)
  if (sitePath) {
    const lower = sitePath.toLowerCase()
    if (lower.endsWith('.html') || lower.endsWith('.htm')) return { kind: 'internal', target: sitePath }
    const leaf = sitePath.slice(sitePath.lastIndexOf('/') + 1)
    if (!leaf.includes('.')) return { kind: 'internal', target: `${sitePath}/index.html` }
    return { kind: 'neutralise' }
  }
  if (raw.startsWith('#')) return { kind: 'keep' }
  const schemeMatch = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)
  if (schemeMatch) {
    return KEEP_SCHEMES.has(schemeMatch[1].toLowerCase())
      ? { kind: 'keep' }
      : { kind: 'neutralise' }
  }
  return { kind: 'neutralise' }
}

const PREVIEW_TEXT_EXTS = new Set(['css', 'js', 'mjs', 'json', 'svg'])

// In-preview page navigation: the injected click handler postMessages the
// resolved build/site/ path of a same-site page link up to HtmlPreview. It ALSO
// owns in-page #anchor scrolling, because a native fragment navigation in this
// frame is a footgun, not a convenience:
//
// The preview is a sandboxed srcdoc iframe, but a sandboxed iframe still SHARES
// the browser's single joint session history with the top shell. A native
// `<a href="#book">` click pushes a REAL entry into that shared history. The
// Möbius shell's drawer/back-stack model assumes it exclusively owns session
// history (openDrawer pushState, back-gesture → history.back()), so each phantom
// entry the preview injects desyncs the shell — the owner's Android back gesture
// unwinds preview fragments instead of closing the drawer / leaving the app, and
// (observed on prod) the same nested-sandbox history mutation can force the whole
// app frame to reload into a "no init message" timeout. So we intercept bare
// #fragment clicks, scroll the target into view ourselves, and preventDefault —
// the visual jump still happens, but no history entry is pushed.
const WS_PREVIEW_NAV_TYPE = 'ws-preview-nav'
export const WS_PREVIEW_NAV_SCRIPT = `
document.addEventListener('click', function (event) {
  if (!event.target || !event.target.closest) return
  var internal = event.target.closest('a[data-ws-internal]')
  if (internal) {
    event.preventDefault()
    window.parent.postMessage({ type: '${WS_PREVIEW_NAV_TYPE}', path: internal.getAttribute('data-ws-internal') }, '*')
    return
  }
  // Bare #fragment link: scroll in-frame instead of letting the browser push a
  // history entry into the session history the shell back-stack relies on.
  var anchor = event.target.closest('a[href^="#"]')
  if (!anchor) return
  var hash = anchor.getAttribute('href') || ''
  if (hash === '#' || hash.length < 2) { event.preventDefault(); return }
  var id = decodeURIComponent(hash.slice(1))
  var target = null
  try { target = document.getElementById(id) } catch (e) { target = null }
  if (!target) {
    try { target = document.querySelector('a[name="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]') } catch (e) { target = null }
  }
  event.preventDefault()
  if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
}, true)
`

// Bounded, cancellation-aware retry around a single read. The preview's MAIN
// page fetch is its one hard single point of failure: every asset sub-fetch
// degrades gracefully (keeps the original ref on error), but if that read
// returns null or throws on a transient blip the whole frame bricks. Retrying
// a few times with a short growing backoff means one flaky read can't take
// the preview down, while a genuinely-absent page is still null after the
// attempts and falls through to the caller's error path. `isCancelled` is
// honoured between attempts so an unmount/version change stops the loop
// promptly instead of racing a stale read against the next render. Exported
// (with `sleep` injectable) so the retry/give-up contract is unit-testable
// without real timers.
export async function readWithRetry(read, {
  attempts = 3,
  baseDelayMs = 300,
  isCancelled = () => false,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let lastErr = null
  for (let i = 0; i < attempts; i += 1) {
    if (isCancelled()) return null
    try {
      const v = await read()
      if (v != null) return v
      lastErr = null // null = absent-or-transient; retry, then give up cleanly
    } catch (e) {
      lastErr = e
    }
    if (i < attempts - 1) await sleep(baseDelayMs * (i + 1))
  }
  if (lastErr) throw lastErr
  return null
}

function HtmlPreview({ storage, entryPath, version }) {
  const [srcDoc, setSrcDoc] = useState(null)
  const [err, setErr] = useState(null)
  const [loading, setLoading] = useState(true)
  // Bumped by the Retry button to re-run the render effect after a failed
  // load, so a flaky read doesn't permanently brick the preview frame.
  const [reloadTick, setReloadTick] = useState(0)
  const createdUrlsRef = useRef([])
  const frameRef = useRef(null)
  // The page currently shown — starts at the build's entry and changes when
  // the user follows a same-site page link inside the preview. A new build
  // (version) or a different entry resets it.
  const [pageEntry, setPageEntry] = useState(entryPath)
  useEffect(() => { setPageEntry(entryPath) }, [entryPath, version])

  // Accept navigation messages only from OUR iframe, and only to paths we
  // stamped at injection time (under build/site/, structurally safe).
  useEffect(() => {
    const onMessage = (event) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const data = event.data
      if (!data || data.type !== WS_PREVIEW_NAV_TYPE) return
      const next = typeof data.path === 'string' ? data.path : ''
      if (!next.startsWith('build/site/')) return
      if (!isSafeRelPath(next.slice('build/site/'.length))) return
      setPageEntry(next)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    let cancelled = false
    setErr(null); setLoading(true); setSrcDoc(null)
    // Revoke any blob URLs from the previous render before building new ones.
    for (const u of createdUrlsRef.current) URL.revokeObjectURL(u)
    createdUrlsRef.current = []

    const track = (url) => { createdUrlsRef.current.push(url); return url }

    // Fetch a same-build asset as a blob: URL (images/fonts/binary) or as
    // text (css/js) depending on extension. Memoised per path so a page that
    // references one stylesheet from multiple rules fetches it once.
    const assetCache = new Map()
    const blobUrlFor = async (sitePath) => {
      if (assetCache.has(sitePath)) return assetCache.get(sitePath)
      const p = (async () => {
        const blob = await storage.getBlob(sitePath)
        if (!blob) return null
        return track(URL.createObjectURL(blob))
      })()
      assetCache.set(sitePath, p)
      return p
    }
    const textFor = async (sitePath) => storage.getText(sitePath)

    // Rewrite url(...) references inside a CSS string to blob URLs so an
    // inlined stylesheet's background-images / @font-face still load.
    const rewriteCssUrls = async (css) => {
      const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g
      const refs = new Set()
      let m
      while ((m = URL_RE.exec(css)) !== null) refs.add(m[2].trim())
      // Resolve each unique ref to a blob URL first, then replace ONLY the
      // exact url(...) token. A plain substring replace (split/join) would
      // also corrupt a longer ref that merely CONTAINS a shorter one — e.g.
      // rewriting img/a.png would also hit img/a.png.webp.
      const map = new Map()
      for (const ref of refs) {
        const sitePath = resolveSiteAsset(ref, pageEntry)
        if (!sitePath) continue
        try {
          const url = await blobUrlFor(sitePath)
          if (url) map.set(ref, url)
        } catch { /* leave the original ref; it just won't load */ }
      }
      if (!map.size) return css
      return css.replace(URL_RE, (whole, q, ref) => {
        const url = map.get(ref.trim())
        return url ? `url(${q}${url}${q})` : whole
      })
    }

    ;(async () => {
      try {
        // readWithRetry (module level) holds the retry contract — the main
        // page is the one read whose failure bricks the whole frame.
        const html = await readWithRetry(
          () => storage.getText(pageEntry),
          { isCancelled: () => cancelled },
        )
        if (cancelled) return
        if (html == null) throw new Error('Built page could not be loaded. Try Build again.')

        // Parse in a detached document so we can walk + rewrite refs without
        // ever attaching (and thus executing) anything in THIS document.
        const doc = new DOMParser().parseFromString(html, 'text/html')

        // <link rel="stylesheet" href="..."> → inline <style> (with its own
        // url() refs rewritten). Same-build only; external CDN links stay.
        for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
          const sitePath = resolveSiteAsset(link.getAttribute('href'), pageEntry)
          if (!sitePath) continue
          try {
            const css = await textFor(sitePath)
            if (cancelled) return
            if (css == null) continue
            const style = doc.createElement('style')
            style.textContent = await rewriteCssUrls(css)
            link.replaceWith(style)
          } catch { /* keep the original link */ }
        }

        // <style> blocks already in the page: rewrite their url() refs.
        for (const style of Array.from(doc.querySelectorAll('style'))) {
          if (!style.textContent) continue
          try { style.textContent = await rewriteCssUrls(style.textContent) } catch { /* keep as-is */ }
        }

        // <script src="..."> → fetch the JS and inline it AS TEXT (drop the
        // src), exactly like <link rel=stylesheet> is inlined into a <style>
        // above. A blob: URL src is the obvious move but it is silently broken
        // here: the preview is a sandboxed srcdoc with NO allow-same-origin, so
        // its document origin is opaque/null and the browser FORBIDS loading a
        // blob: (or any) URL from a null-origin document ("Not allowed to load
        // local resource: blob:… @ about:srcdoc"). The site's JS — and every
        // link/interaction it wires up — then never runs in the preview. Inline
        // <script> text executes under allow-scripts with no origin needed, so
        // setting textContent and removing src restores the site's behavior.
        for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
          const sitePath = resolveSiteAsset(script.getAttribute('src'), pageEntry)
          if (!sitePath) continue
          try {
            const js = await textFor(sitePath)
            if (cancelled) return
            if (js == null) continue
            script.textContent = js
            script.removeAttribute('src')
          } catch { /* keep the original src */ }
        }

        // <img src>, <source src>, <video poster>, <audio src>, <use href> …
        // → blob URLs. Covers the common same-build media refs.
        const mediaSelectors = [
          ['img', 'src'], ['source', 'src'], ['source', 'srcset'],
          ['video', 'poster'], ['video', 'src'], ['audio', 'src'],
          ['image', 'href'], ['use', 'href'],
        ]
        for (const [sel, attr] of mediaSelectors) {
          for (const el of Array.from(doc.querySelectorAll(`${sel}[${attr}]`))) {
            const val = el.getAttribute(attr)
            // srcset is a comma-separated list; only single refs are handled
            // here (best-effort — a multi-candidate srcset is left untouched).
            if (attr === 'srcset' && val && val.includes(',')) continue
            const sitePath = resolveSiteAsset(val, pageEntry)
            if (!sitePath) continue
            try {
              const url = await blobUrlFor(sitePath)
              if (cancelled) return
              if (url) el.setAttribute(attr, url)
            } catch { /* keep the original ref */ }
          }
        }

        // <a href> handling — anchorActionFor (module level) holds the policy
        // and its contract; this loop just applies the action to the detached
        // DOM. Internal links keep their href so they still style as links;
        // the injected script preventDefaults + postMessages the stamped path.
        for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
          const href = (a.getAttribute('href') || '').trim()
          const action = anchorActionFor(href, pageEntry)
          if (action.kind === 'external') {
            a.setAttribute('target', '_blank')
            a.setAttribute('rel', 'noopener noreferrer')
          } else if (action.kind === 'internal') {
            a.setAttribute('data-ws-internal', action.target)
          } else if (action.kind === 'neutralise') {
            a.setAttribute('data-ws-asset', href)
            a.removeAttribute('href')
          }
        }
        // The click interceptor for data-ws-internal links (see above).
        const navScript = doc.createElement('script')
        navScript.textContent = WS_PREVIEW_NAV_SCRIPT
        ;(doc.body || doc.documentElement).appendChild(navScript)

        if (cancelled) return
        const serialized = `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
        setSrcDoc(serialized)
        setLoading(false)
      } catch (e) {
        if (!cancelled) {
          setErr((e && e.message) || 'Preview failed to render.')
          setLoading(false)
        }
      }
    })()

    return () => { cancelled = true }
  }, [storage, pageEntry, version, reloadTick])

  // Revoke blob URLs on unmount.
  useEffect(() => () => {
    for (const u of createdUrlsRef.current) URL.revokeObjectURL(u)
    createdUrlsRef.current = []
  }, [])

  if (err) {
    return (
      <div className="ws-preview-note">
        <p style={{ margin: '0 0 14px' }}>{err}</p>
        <button
          type="button"
          className="ws-preview-retry"
          onClick={() => { setErr(null); setLoading(true); setReloadTick((t) => t + 1) }}
        >
          Retry
        </button>
      </div>
    )
  }
  return (
    <div className="ws-preview">
      {loading && <div className="ws-preview-note">Rendering preview…</div>}
      {srcDoc != null && (
        <iframe
          ref={frameRef}
          className="ws-preview-frame"
          title="Site preview"
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          srcDoc={srcDoc}
        />
      )}
    </div>
  )
}

// ----------------------------------------------------------------------
// File tree. We maintain files-index.json as the canonical list of
// paths, because the storage API doesn't expose a per-app listing
// endpoint. The agent is told (via the system prompt) to keep the
// index up to date when it creates/deletes files; the UI also writes
// to it whenever the user adds or removes a file from inside the app.
// ----------------------------------------------------------------------

// Build a tree-shaped structure from the flat path list.
function buildTree(paths) {
  // Each node: { name, path, children: Map, isFile }
  const root = { name: '', path: '', children: new Map(), isFile: false }
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    parts.forEach((seg, i) => {
      const last = i === parts.length - 1
      if (!node.children.has(seg)) {
        node.children.set(seg, {
          name: seg,
          path: parts.slice(0, i + 1).join('/'),
          children: new Map(),
          isFile: last,
        })
      } else if (last) {
        node.children.get(seg).isFile = true
      }
      node = node.children.get(seg)
    })
  }
  return root
}

// File-type kind for the tree glyph. The glyph itself is a bare lucide-style
// SVG (see FileGlyph) — the kind only selects which inner mark it draws.
function fileKind(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (lower.endsWith('.css')) return 'css'
  if (lower.match(/\.(js|mjs|ts|jsx|tsx)$/)) return 'code'
  if (lower.endsWith('.json')) return 'json'
  if (lower.match(/\.(png|jpe?g|gif|webp|svg|ico)$/)) return 'image'
  return 'file'
}

// Bare lucide-style file glyph for the tree (fill none, currentColor stroke,
// round caps — the shared Möbius icon idiom). No bounding box / fill / boxed
// padding: it inherits the row's text color exactly like the shell's icons.
// Each kind draws the lucide "document" outline plus a small inner mark so the
// type stays legible without reverting to a boxed letter tile.
function FileGlyph({ name, size = 16 }) {
  const kind = fileKind(name)
  // Shared document outline (a page with a dog-eared corner) for non-image
  // kinds; the image kind draws a picture frame instead.
  const sharedProps = {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
    strokeLinejoin: 'round', 'aria-hidden': true,
  }
  if (kind === 'image') {
    return (
      <svg {...sharedProps}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <path d="m21 16-5-5L5 20" />
      </svg>
    )
  }
  const page = <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
  const fold = <path d="M14 3v5h5" />
  return (
    <svg {...sharedProps}>
      {page}
      {fold}
      {/* Inner mark distinguishes the file type while staying inside the page. */}
      {kind === 'code' && <path d="m10 13-2 2 2 2M14 13l2 2-2 2" />}
      {kind === 'json' && <path d="M11 12c-1 0-1.5.5-1.5 1.5S9 15 8 15c1 0 1.5.5 1.5 1.5S10 18 11 18M13 12c1 0 1.5.5 1.5 1.5S15 15 16 15c-1 0-1.5.5-1.5 1.5S14 18 13 18" />}
      {kind === 'html' && <path d="M9 13.5 7.5 15 9 16.5M15 13.5 16.5 15 15 16.5M13 12.5l-2 5" />}
      {kind === 'css' && <path d="M9 17c.5.6 1.4 1 2.3 1 1.2 0 2.2-.7 2.2-1.6 0-2-4.2-1.3-4.2-3.2 0-.9 1-1.5 2.1-1.5.8 0 1.6.3 2 .9" />}
      {kind === 'file' && <path d="M9 14h6M9 17h4" />}
    </svg>
  )
}

// Bare chevron for folder rows — a lucide chevron, no box. Rotates via CSS when
// the folder is expanded so the open/closed state matches the shell's idiom.
function ChevronIcon({ size = 14 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

// Toolbar glyphs. 24x24 stroked SVGs (the shared Möbius icon idiom: fill none,
// currentColor stroke, round caps) so they inherit the theme text color and the
// button's :disabled fade. aria-hidden — the buttons carry the accessible name
// via aria-label/title.
function EyeIcon({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
function CodeIcon({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d="m8 6-6 6 6 6" />
      <path d="m16 6 6 6-6 6" />
    </svg>
  )
}
// Play triangle for the Build action — same component as LaTeX's, so the two
// editor-shaped apps share one primary-action icon.
/* mobius-ui:PlayIcon v1 — keep in sync with app-latex */
function PlayIcon({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d="M6 4.5 19 12 6 19.5V4.5Z" />
    </svg>
  )
}
/* /mobius-ui:PlayIcon */

// Spinner shown in the Build button while a build runs (CSS animation on
// .ws-building-spin). Same component as LaTeX's.
/* mobius-ui:BuildingIndicator v1 — keep in sync with app-latex */
function BuildingIndicator({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden className="ws-building-spin">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  )
}
/* /mobius-ui:BuildingIndicator */
function KebabIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="5" r="0.6" />
      <circle cx="12" cy="12" r="0.6" />
      <circle cx="12" cy="19" r="0.6" />
    </svg>
  )
}
function ChatBubbleIcon({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}
function PublishIcon({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12" />
      <path d="m7 8 5-5 5 5" />
      <path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
    </svg>
  )
}
function UnpublishIcon({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d="M12 21V9" />
      <path d="m17 16-5 5-5-5" />
      <path d="M5 9V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4" />
    </svg>
  )
}
function CheckIcon({ size = 16 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d="m20 6-11 11-5-5" />
    </svg>
  )
}
function PencilIcon({ size = 16 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}
function PlusIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function NewFileIcon({ size = 17 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
      <path d="M14 3v6h6" />
      <path d="M12 12v6M9 15h6" />
    </svg>
  )
}
function NewFolderIcon({ size = 17 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.6.8l.9 1.2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </svg>
  )
}
function UploadIcon({ size = 17 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 15V4" />
      <path d="M8 8l4-4 4 4" />
      <path d="M5 16v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
    </svg>
  )
}
function TrashIcon({ size = 16 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}
function CopyIcon({ size = 16 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

// In-app context menu. Native context menus / window.prompt are unavailable
// in the mini-app sandbox (no allow-modals), and a native right-click menu
// would also offer "back/reload/inspect" that make no sense here. So we render
// our own absolutely-positioned menu at the cursor. It closes on any outside
// pointer-down, on Escape, and on scroll.
function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    const onDown = (e) => {
      // A press on a popover trigger (a row kebab) is owned by that trigger's
      // click, which toggles this menu. Closing here on the same pointerdown
      // would close-then-reopen, so the menu could never toggle shut.
      if (e.target && e.target.closest && e.target.closest('[data-popover-trigger]')) return
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])
  const left = Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 180)
  const top = Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : 9999) - (items.length * 44 + 8))
  return (
    <div
      ref={ref}
      className="ws-ctx-menu"
      style={{ left: `${Math.max(4, left)}px`, top: `${Math.max(4, top)}px` }}
      role="menu"
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className={`ws-ctx-item ${it.danger ? 'ws-ctx-item--danger' : ''}`}
          onClick={() => { onClose(); it.onSelect() }}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

// A long-press hook for touch: fires `onLongPress(clientX, clientY)` after
// LONG_PRESS_MS of a stationary touch, cancelling if the finger moves past a
// small slop or lifts early. This gives mobile users the affordance right-click
// gives desktop.
const LONG_PRESS_MS = 500
const LONG_PRESS_SLOP = 10
function useLongPress(onLongPress) {
  const timerRef = useRef(null)
  const startRef = useRef(null)
  const clear = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    startRef.current = null
  }, [])
  useEffect(() => clear, [clear])
  const onTouchStart = useCallback((e) => {
    const t = e.touches && e.touches[0]
    if (!t) return
    startRef.current = { x: t.clientX, y: t.clientY }
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (startRef.current) onLongPress(startRef.current.x, startRef.current.y)
    }, LONG_PRESS_MS)
  }, [onLongPress])
  const onTouchMove = useCallback((e) => {
    const t = e.touches && e.touches[0]
    if (!t || !startRef.current) return
    if (Math.abs(t.clientX - startRef.current.x) > LONG_PRESS_SLOP
      || Math.abs(t.clientY - startRef.current.y) > LONG_PRESS_SLOP) {
      clear()
    }
  }, [clear])
  return { onTouchStart, onTouchMove, onTouchEnd: clear, onTouchCancel: clear }
}

function FileNode({
  node, selectedPath, onSelect, depth,
  onContextMenu, onMoveInto, mainPath, onSetMain, openMenuPath, parentPath = '',
}) {
  const [expanded, setExpanded] = useState(true)
  const [dropActive, setDropActive] = useState(false)
  const isFolder = !(node.children.size === 0 && node.isFile)
  const longPress = useLongPress((cx, cy) => {
    onContextMenu({ x: cx, y: cy, path: node.path, isFolder })
  })
  // Open the per-item action menu (Set main / Rename / Delete) anchored at the
  // kebab button. Same menu the right-click / long-press gesture opens — the
  // visible ⋯ button just makes those actions discoverable on touch.
  const openMenuFromButton = useCallback((e, isFolderItem) => {
    e.preventDefault()
    e.stopPropagation()
    // Toggle: a second press on this row's kebab closes its menu. The
    // ContextMenu's outside-close ignores [data-popover-trigger], so it can't
    // close-then-reopen on the same press (the old toggle-never-fires bug).
    if (openMenuPath === node.path) { onContextMenu(null); return }
    const r = e.currentTarget.getBoundingClientRect()
    onContextMenu({ x: r.right, y: r.bottom, path: node.path, isFolder: isFolderItem })
  }, [openMenuPath, node.path, onContextMenu])
  if (node.children.size === 0 && node.isFile) {
    const selected = node.path === selectedPath
    const isMain = node.path === mainPath
    const isHtml = isHtmlDoc(node.path)
    // Discoverable "set as main page" affordance: a visible accent-dot button
    // on every HTML page that isn't already the main page, alongside the
    // existing context-menu path (which still works). It is a SIBLING of the
    // row <button> (next to the kebab), not nested inside it: focusable content
    // inside a <button> is invalid HTML and pollutes the tree's roving-tabindex
    // (the row buttons are tabIndex={-1}). We stop propagation so tapping it
    // sets main without also selecting/opening the file.
    const activateSetMain = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (onSetMain) onSetMain(node.path)
    }
    return (
      <div className="ws-tree-row">
        <button
          type="button"
          className={`ws-tree-file ${selected ? 'ws-tree-file--selected' : ''}`}
          style={{ paddingLeft: `${10 + depth * 16}px` }}
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={selected}
          tabIndex={-1}
          data-tree-path={node.path}
          data-parent-path={parentPath}
          data-tree-kind="file"
          onClick={() => onSelect(node.path)}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/mobius-path', node.path)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            onContextMenu({ x: e.clientX, y: e.clientY, path: node.path, isFolder: false })
          }}
          {...longPress}
        >
          <span className="ws-tree-icon"><FileGlyph name={node.name} /></span>
          <span className="ws-tree-name">{node.name}</span>
          {/* One compact accent dot marks the main page (the preview renders
              it) — no text chip. */}
          {isMain && (
            <span
              className="ws-tree-main-dot"
              role="img"
              aria-label="Main page (preview renders this)"
              title="Preview renders this page"
            />
          )}
        </button>
        {isHtml && !isMain && onSetMain && (
          <button
            type="button"
            className="ws-tree-set-main"
            aria-label="Set as main page"
            title="Set as main page (the preview will render this page)"
            onClick={activateSetMain}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') activateSetMain(e) }}
          >
            <span className="ws-tree-set-main-dot" />
          </button>
        )}
        <button
          type="button"
          className="ws-tree-menu-btn" data-popover-trigger=""
          data-state={openMenuPath === node.path ? 'open' : 'closed'}
          aria-label={`Actions for ${node.name}`}
          aria-haspopup="menu"
          aria-expanded={openMenuPath === node.path}
          title="File actions"
          onClick={(e) => openMenuFromButton(e, false)}
        >
          <KebabIcon />
        </button>
      </div>
    )
  }
  // Folder node — own row plus indented children. We filter `.keep` entries
  // before sorting: those exist only so empty folders survive a backend that
  // has no mkdir endpoint (handleCreateFolder writes `files/<name>/.keep`).
  const sortedChildren = [...node.children.values()]
    .filter((c) => !(c.isFile && c.name === '.keep'))
    .sort((a, b) => {
      const af = a.children.size > 0 && !a.isFile
      const bf = b.children.size > 0 && !b.isFile
      if (af !== bf) return af ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  const dropMove = (e, destDir) => {
    e.preventDefault()
    // The folder onDrop is a DOM descendant of the root container's onDrop, so a
    // drop onto a folder would otherwise bubble up and run the root move too —
    // targeting the already-moved source path and 404ing. Stop propagation here.
    e.stopPropagation()
    setDropActive(false)
    const from = e.dataTransfer.getData('text/mobius-path')
    if (!from) return
    const leaf = from.split('/').pop()
    const base = destDir || 'files'
    onMoveInto(from, `${base}/${leaf}`)
  }

  if (depth < 0) {
    return (
      <div
        className={`ws-tree-root ${dropActive ? 'ws-tree-drop-active' : ''}`}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropActive(true) }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(e) => dropMove(e, node.path)}
      >
        {sortedChildren.map((c) => (
          <FileNode
            key={c.path}
            node={c}
            selectedPath={selectedPath}
            onSelect={onSelect}
            depth={0}
            onContextMenu={onContextMenu}
            onMoveInto={onMoveInto}
            mainPath={mainPath}
            onSetMain={onSetMain}
            openMenuPath={openMenuPath}
            parentPath=""
          />
        ))}
      </div>
    )
  }
  return (
    <>
      <div className="ws-tree-row">
        <button
          type="button"
          className={`ws-tree-folder ${dropActive ? 'ws-tree-drop-active' : ''}`}
          style={{ paddingLeft: `${10 + depth * 16}px` }}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={expanded}
          tabIndex={-1}
          data-tree-path={node.path}
          data-parent-path={parentPath}
          data-tree-kind="folder"
          onClick={() => setExpanded((e) => !e)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' && !expanded) {
              e.preventDefault()
              setExpanded(true)
            } else if (e.key === 'ArrowLeft' && expanded) {
              e.preventDefault()
              setExpanded(false)
            }
          }}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropActive(true) }}
          onDragLeave={() => setDropActive(false)}
          onDrop={(e) => dropMove(e, node.path)}
          onContextMenu={(e) => {
            e.preventDefault()
            onContextMenu({ x: e.clientX, y: e.clientY, path: node.path, isFolder: true })
          }}
          {...longPress}
        >
          <span className={`ws-tree-icon ws-tree-chevron ${expanded ? 'ws-tree-chevron--open' : ''}`}>
            <ChevronIcon />
          </span>
          <span className="ws-tree-name">{node.name}/</span>
        </button>
        <button
          type="button"
          className="ws-tree-menu-btn" data-popover-trigger=""
          data-state={openMenuPath === node.path ? 'open' : 'closed'}
          aria-label={`Actions for ${node.name} folder`}
          aria-haspopup="menu"
          aria-expanded={openMenuPath === node.path}
          title="Folder actions"
          onClick={(e) => openMenuFromButton(e, true)}
        >
          <KebabIcon />
        </button>
      </div>
      {expanded && (
        <div role="group" className="ws-tree-group">
          {sortedChildren.map((c) => (
            <FileNode
              key={c.path}
              node={c}
              selectedPath={selectedPath}
              onSelect={onSelect}
              depth={depth + 1}
              onContextMenu={onContextMenu}
              onMoveInto={onMoveInto}
              mainPath={mainPath}
              onSetMain={onSetMain}
              openMenuPath={openMenuPath}
              parentPath={node.path}
            />
          ))}
        </div>
      )}
    </>
  )
}

function ProjectSelector({
  projects, projectsLoaded, activeProjectId,
  onSwitchProject, renamingId, onCommitRename, onCancelRename,
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const inputRef = useRef(null)
  // Set when Enter/Escape already resolved the edit, so the blur that fires as
  // the input unmounts does not commit a second (or, on Escape, a cancelled) value.
  const skipBlurRef = useRef(false)
  const active = projects.find((p) => p.id === activeProjectId) || projects[0] || DEFAULT_PROJECT

  useEffect(() => {
    if (renamingId !== active.id) return
    skipBlurRef.current = false
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(raf)
  }, [active.id, renamingId])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="ws-project-picker" ref={ref}>
      {renamingId === active.id ? (
        <input
          ref={inputRef}
          className="ws-project-rename-input"
          defaultValue={active.name}
          aria-label="Project name"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { skipBlurRef.current = true; onCommitRename(active.id, e.currentTarget.value) }
            else if (e.key === 'Escape') { skipBlurRef.current = true; onCancelRename() }
          }}
          onBlur={(e) => {
            if (skipBlurRef.current) { skipBlurRef.current = false; return }
            onCommitRename(active.id, e.currentTarget.value)
          }}
        />
      ) : (
        <button
          type="button"
          className="ws-project-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          title="Switch project"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="ws-project-trigger-name">{active.name}</span>
          <ChevronIcon size={13} />
        </button>
      )}
      {open && (
        <div className="ws-project-menu" role="menu">
          <div className="ws-project-list" role="group" aria-label="Projects">
            {projectsLoaded ? projects.map((project) => (
              <button
                key={project.id}
                type="button"
                role="menuitemradio"
                aria-checked={project.id === activeProjectId}
                className={`ws-project-item ${project.id === activeProjectId ? 'ws-project-item--active' : ''}`}
                onClick={() => {
                  setOpen(false)
                  if (project.id !== activeProjectId) onSwitchProject(project.id)
                }}
              >
                <span className="ws-project-item-name">{project.name}</span>
              </button>
            )) : (
              <div className="ws-project-loading">Loading projects...</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function PublishDrawerAction({
  publishedUrl, publishing, canPublish, onPublish, onUnpublish,
}) {
  return (
    <div className="ws-drawer-publish" aria-label="Publish">
      {publishedUrl ? (
        <>
          <div className="ws-drawer-publish-url">{publishedUrl}</div>
          <div className="ws-drawer-publish-actions">
            <button
              type="button"
              className="ws-drawer-publish-btn"
              onClick={() => navigator.clipboard?.writeText(publishedUrl).catch(() => {})}
              title="Copy URL"
              aria-label="Copy published URL"
            >
              <CopyIcon size={16} />
              Copy
            </button>
            <a
              className="ws-drawer-publish-btn ws-drawer-publish-link"
              href={publishedUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open
            </a>
          </div>
          <button
            type="button"
            className="ws-drawer-publish-btn ws-drawer-publish-btn--wide"
            onClick={onUnpublish}
            disabled={publishing}
          >
            <UnpublishIcon size={18} />
            {publishing ? 'Unpublishing...' : 'Unpublish'}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="ws-drawer-publish-btn ws-drawer-publish-btn--wide"
          onClick={onPublish}
          disabled={publishing || !canPublish}
          title={!canPublish ? 'Build first' : (publishing ? 'Publishing...' : 'Publish site')}
        >
          <PublishIcon size={18} />
          {publishing ? 'Publishing...' : 'Publish site'}
        </button>
      )}
    </div>
  )
}

// Left slide-in file drawer (VSCode explorer shape): a panel that transforms
// in from the left edge over a dimming backdrop, opened by the logo toggle.
// It is ALWAYS mounted (the `--open` class drives the transform).
//
// `canMutate` is false until the file index has been confirmed against the
// server (App owns the check). While false we disable add/delete so the user
// can't queue an index write derived from an unconfirmed list.
function FileNavPanel({
  appId, open, onClose, files, selectedPath, onSelect, canMutate,
  onCreateFile, onCreateFolder, onDeleteFile, onDeleteFolder,
  onUpload, onMove, onRename, mainPath, onSetMain, returnFocusRef,
  projects, projectsLoaded, activeProjectId,
  onSwitchProject, onNewProject, onRenameProject, onDeleteProject,
  renamingId, onCommitProjectRename, onCancelProjectRename,
  publishedUrl, publishing, buildStatus, canPublish, onPublish, onUnpublish,
}) {
  const root = useMemo(() => buildTree(files), [files])
  const treeRef = useRef(null)
  const prevOpenRef = useRef(open)
  const fileInputRef = useRef(null)
  const folderInputRef = useRef(null)
  const [ctx, setCtx] = useState(null)
  const closeCtx = useCallback(() => setCtx(null), [])
  useEffect(() => { if (!open) setCtx(null) }, [open])

  // Swipe-left-to-close, ported faithfully from the Möbius shell Drawer:
  // touchstart captures the origin (only when open + a single touch),
  // touchmove drags the panel 1:1 with the finger while the gesture is
  // dominantly horizontal-left, touchend either closes (≥70px past origin
  // AND horizontal-dominant) or snaps back. The CSS transition is disabled
  // mid-drag via `ws-file-drawer--dragging` so the panel tracks the finger
  // without easing; clearing the class lets the normal transform-transition
  // animate the snap/close. The scrim-click-to-close path is untouched.
  const drawerRef = useRef(null)
  const dragStart = useRef(null) // { x, y } or null

  const onDrawerTouchStart = useCallback((e) => {
    if (!open || e.touches.length !== 1) return
    dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
  }, [open])

  const onDrawerTouchMove = useCallback((e) => {
    if (!dragStart.current || e.touches.length !== 1) return
    const dx = e.touches[0].clientX - dragStart.current.x
    const dy = e.touches[0].clientY - dragStart.current.y
    if (dx < 0 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      const el = drawerRef.current
      if (!el) return
      el.classList.add('ws-file-drawer--dragging')
      el.style.transform = `translateX(${Math.max(dx, -el.offsetWidth)}px)`
    }
  }, [])

  const onDrawerTouchEnd = useCallback((e) => {
    if (!dragStart.current) return
    const t = e.changedTouches[0]
    const dx = t.clientX - dragStart.current.x
    const dy = t.clientY - dragStart.current.y
    const shouldClose = dx < -70 && Math.abs(dx) > Math.abs(dy) * 1.35
    const el = drawerRef.current
    if (el) {
      el.classList.remove('ws-file-drawer--dragging')
      if (shouldClose) {
        // Animate from the drag position to closed, then clear the inline
        // transform after the transition so the next open doesn't start from
        // an inline translateX(-100%) that conflicts with the --open class.
        el.style.transform = 'translateX(-100%)'
        const cleanup = () => {
          if (el) el.style.transform = ''
          el.removeEventListener('transitionend', cleanup)
        }
        el.addEventListener('transitionend', cleanup, { once: true })
      } else {
        // Snap back: clearing the inline transform lets the .ws-file-drawer
        // --open class's translateX(0) take over with the transition running
        // from the drag position.
        el.style.transform = ''
      }
    }
    dragStart.current = null
    if (shouldClose) onClose?.()
  }, [onClose])

  // touchcancel positions are unreliable across browsers; treat cancel as
  // "snap back, don't close" — never evaluate the close threshold on cancel.
  const onDrawerTouchCancel = useCallback(() => {
    const el = drawerRef.current
    if (el) {
      el.classList.remove('ws-file-drawer--dragging')
      el.style.transform = ''
    }
    dragStart.current = null
  }, [])

  const treeItems = useCallback(() => {
    if (!treeRef.current) return []
    return Array.from(treeRef.current.querySelectorAll('[role="treeitem"]'))
  }, [])

  const focusTreeItem = useCallback((item) => {
    if (item && typeof item.focus === 'function') item.focus()
  }, [])

  const focusSelectedOrFirst = useCallback(() => {
    const items = treeItems()
    if (items.length === 0) return
    const selected = selectedPath
      ? items.find((item) => item.getAttribute('data-tree-path') === selectedPath)
      : null
    focusTreeItem(selected || items[0])
  }, [focusTreeItem, selectedPath, treeItems])

  useEffect(() => {
    const wasOpen = prevOpenRef.current
    prevOpenRef.current = open
    if (open && !wasOpen) {
      const raf = requestAnimationFrame(focusSelectedOrFirst)
      return () => cancelAnimationFrame(raf)
    }
    if (!open && wasOpen) {
      returnFocusRef?.current?.focus?.()
    }
  }, [focusSelectedOrFirst, open, returnFocusRef])

  const handleTreeFocus = useCallback((event) => {
    if (event.target === treeRef.current) focusSelectedOrFirst()
  }, [focusSelectedOrFirst])

  const handleTreeKeyDown = useCallback((event) => {
    if (event.defaultPrevented) return
    const current = event.target.closest?.('[role="treeitem"]')
    if (!current || !treeRef.current?.contains(current)) return
    const items = treeItems()
    const index = items.indexOf(current)
    if (index < 0) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusTreeItem(items[Math.min(index + 1, items.length - 1)])
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusTreeItem(items[Math.max(index - 1, 0)])
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusTreeItem(items[0])
    } else if (event.key === 'End') {
      event.preventDefault()
      focusTreeItem(items[items.length - 1])
    } else if (event.key === 'ArrowRight') {
      if (current.getAttribute('aria-expanded') === 'true') {
        const level = Number(current.getAttribute('aria-level') || '0')
        const child = items.slice(index + 1).find((item) => (
          Number(item.getAttribute('aria-level') || '0') > level
        ))
        if (child) {
          event.preventDefault()
          focusTreeItem(child)
        }
      }
    } else if (event.key === 'ArrowLeft') {
      const ppath = current.getAttribute('data-parent-path')
      if (ppath) {
        const parent = items.find((item) => item.getAttribute('data-tree-path') === ppath)
        if (parent) {
          event.preventDefault()
          focusTreeItem(parent)
        }
      }
    }
  }, [focusTreeItem, treeItems])

  // Context actions. An HTML file additionally offers "Set as main page"
  // (unless it already is) so the user can pick which page the preview renders.
  const ctxItems = ctx ? [
    ...(!ctx.isFolder && isHtmlDoc(ctx.path) && ctx.path !== mainPath
      ? [{ label: 'Set as main page', onSelect: () => onSetMain(ctx.path) }]
      : []),
    { label: 'Rename', onSelect: () => onRename(ctx.path) },
    {
      label: 'Delete',
      danger: true,
      onSelect: () => (ctx.isFolder ? onDeleteFolder(ctx.path) : onDeleteFile(ctx.path)),
    },
  ] : []

  return (
    <>
      <div
        className={`ws-drawer-scrim ${open ? 'ws-drawer-scrim--open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        ref={drawerRef}
        className={`ws-file-drawer ${open ? 'ws-file-drawer--open' : ''}`}
        aria-label="File tree"
        aria-hidden={!open}
        onTouchStart={onDrawerTouchStart}
        onTouchMove={onDrawerTouchMove}
        onTouchEnd={onDrawerTouchEnd}
        onTouchCancel={onDrawerTouchCancel}
      >
        <div className="ws-project-row">
          <ProjectSelector
            projects={projects}
            projectsLoaded={projectsLoaded}
            activeProjectId={activeProjectId}
            onSwitchProject={onSwitchProject}
            renamingId={renamingId}
            onCommitRename={onCommitProjectRename}
            onCancelRename={onCancelProjectRename}
          />
          <div className="ws-project-row-actions">
            <button className="ws-icon-btn" onClick={onNewProject} disabled={!projectsLoaded} title="New project" aria-label="New project"><PlusIcon size={18} /></button>
            <button className="ws-icon-btn" onClick={() => onRenameProject(activeProjectId)} disabled={!projectsLoaded} title="Rename project" aria-label="Rename project"><PencilIcon size={15} /></button>
            <button className="ws-icon-btn ws-icon-btn--danger" onClick={() => onDeleteProject(activeProjectId)} disabled={!projectsLoaded || activeProjectId === DEFAULT_PROJECT.id || projects.length <= 1} title="Delete project" aria-label="Delete project"><TrashIcon size={15} /></button>
          </div>
        </div>
        <PublishDrawerAction
          publishedUrl={publishedUrl}
          publishing={publishing}
          canPublish={canPublish}
          onPublish={onPublish}
          onUnpublish={onUnpublish}
        />
        <div className="ws-drawer-actions">
          <span className="ws-files-label">Files</span>
          <div className="ws-files-actions">
            <button className="ws-icon-btn" onClick={onCreateFile} disabled={!canMutate} title="New file" aria-label="New file"><NewFileIcon size={17} /></button>
            <button className="ws-icon-btn" onClick={onCreateFolder} disabled={!canMutate} title="New folder" aria-label="New folder"><NewFolderIcon size={17} /></button>
            <button className="ws-icon-btn" onClick={() => fileInputRef.current && fileInputRef.current.click()} disabled={!canMutate} title="Upload" aria-label="Upload"><UploadIcon size={17} /></button>
          </div>
          {/* Hidden file/folder pickers. Materialise the FileList into a real
              array SYNCHRONOUSLY before resetting input.value: onUpload is async
              (it awaits before reading the list), and `e.target.value = ''`
              empties the live FileList the input still owns. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const fl = Array.from(e.target.files || [])
              e.target.value = ''
              onUpload(fl, { asFolder: false })
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            webkitdirectory=""
            directory=""
            style={{ display: 'none' }}
            onChange={(e) => {
              const fl = Array.from(e.target.files || [])
              e.target.value = ''
              onUpload(fl, { asFolder: true })
            }}
          />
        </div>
        {!canMutate && (
          <div className="ws-drawer-syncing" role="status">
            Loading your files… add, upload, and delete unlock once they sync.
          </div>
        )}
        <div
          ref={treeRef}
          className="ws-drawer-tree"
          role="tree"
          aria-label="Project files"
          tabIndex={0}
          onFocus={handleTreeFocus}
          onKeyDown={handleTreeKeyDown}
        >
          {files.length === 0 ? (
            canMutate ? (
              <div className="ws-drawer-empty">
                Upload a file, or open the project chat to tell the agent what to build.
              </div>
            ) : null
          ) : (
            <FileNode
              node={(root.children.size === 1 && root.children.has('files')) ? root.children.get('files') : root}
              selectedPath={selectedPath}
              onSelect={(p) => { onSelect(p); onClose() }}
              depth={-1}
              onContextMenu={setCtx}
              onMoveInto={onMove}
              mainPath={mainPath}
              onSetMain={onSetMain}
              openMenuPath={ctx ? ctx.path : null}
            />
          )}
        </div>
        {ctx && (
          <ContextMenu x={ctx.x} y={ctx.y} items={ctxItems} onClose={closeCtx} />
        )}
      </aside>
    </>
  )
}

// ----------------------------------------------------------------------
// Embedded shell chat. The runtime mounts the real ChatView into an
// iframe, so this app does not duplicate SSE handling, composer state,
// attachments, provider controls, queueing, or polling.
// ----------------------------------------------------------------------
function bootstrapPrompt() {
  return [
    'You help the user build their website in this app.',
    'Use the embedded-app-agent skill, which carries the full methodology;',
    'rely on the injected app_context for this app’s id, file paths, and',
    'build commands.',
    '',
    'This is a silent setup brief — do NOT reply to it. Wait for the user’s',
    'first message and act on that.',
  ].join('\n')
}

function ChatPanel({
  appId, token, storage,
  projectId, persistKey,
  onFilesMaybeChanged,
  quickActions, getContext,
}) {
  const mountRef = useRef(null)
  const [error, setError] = useState(null)
  // Keep the latest onFilesMaybeChanged in a ref so the mount effect below does
  // NOT depend on it. That callback's identity changes on every file selection;
  // if it were a mount-effect dep, selecting a file would tear down + remount
  // the chat iframe — destroying a streaming turn mid-flight.
  const onFilesRef = useRef(onFilesMaybeChanged)
  useEffect(() => { onFilesRef.current = onFilesMaybeChanged }, [onFilesMaybeChanged])
  const quickActionsRef = useRef(quickActions)
  useEffect(() => { quickActionsRef.current = quickActions }, [quickActions])
  const getContextRef = useRef(getContext)
  useEffect(() => { getContextRef.current = getContext }, [getContext])
  const systemPrompt = useMemo(() => bootstrapPrompt(), [])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !window.mobius || typeof window.mobius.chat !== 'function') {
      setError('Embedded chat is not available in this shell.')
      return undefined
    }
    let disposed = false
    let handle = null
    setError(null)

    window.mobius.chat({
      mount,
      projectId: projectId === 'default' ? undefined : projectId,
      persist: persistKey,
      title: 'Web Studio',
      systemPrompt,
      picker: true,
      quickActions: quickActionsRef.current,
      getContext: () => {
        const fn = getContextRef.current
        return fn ? fn() : null
      },
      onTurnDone: () => { if (onFilesRef.current) onFilesRef.current() },
      onError: ({ error }) => { setError(typeof error === 'string' ? error : 'Embedded chat reported an error.') },
    }).then((nextHandle) => {
      if (disposed) {
        nextHandle.destroy()
        return
      }
      handle = nextHandle
    }).catch((e) => {
      if (!disposed) setError(e.message || 'Could not mount embedded chat.')
    })

    return () => {
      disposed = true
      if (handle) handle.destroy()
    }
  }, [storage, systemPrompt, projectId, persistKey])

  return (
    <section className="ws-chat-panel" aria-label="Agent chat">
      {error && <div className="ws-chat-error">{error}</div>}
      <div className="ws-chat-embed" ref={mountRef} />
    </section>
  )
}

// ----------------------------------------------------------------------
// Online/offline detection. The runtime's `window.mobius.online` is a
// getter over `navigator.onLine` — same source, no separate change event —
// so we track `navigator.onLine` directly and react to the browser's own
// 'online'/'offline' events.
// ----------------------------------------------------------------------
function useOnline() {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const sync = () => setOnline(navigator.onLine !== false)
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])
  return online
}

// ----------------------------------------------------------------------
// In-app modal. Möbius mini-apps run in an iframe with the `allow-modals`
// sandbox token deliberately excluded, so window.alert/.confirm/.prompt
// silently no-op and return false. We render our own modal instead.
// `useModal` returns an imperative {alert, confirm, prompt} surface that
// resolves with a Promise, plus the React node to render.
// ----------------------------------------------------------------------
function useModal() {
  const [state, setState] = useState(null)
  const navRef = useRef(null)
  const resolveRef = useRef(null)

  const finish = useCallback((value, fromShell = false) => {
    if (!fromShell) {
      try { navRef.current?.close?.() } catch {}
    }
    navRef.current = null
    setState(null)
    const resolve = resolveRef.current
    resolveRef.current = null
    if (resolve) resolve(value)
  }, [])

  const openModal = useCallback((factory, backValue) => new Promise((resolve) => {
    if (resolveRef.current) finish(backValue)
    resolveRef.current = resolve
    const show = () => setState(factory((value) => finish(value)))
    if (window.mobius?.nav?.open) {
      const handle = window.mobius.nav.open('webstudio-modal', () => finish(backValue, true))
      navRef.current = handle
      Promise.resolve(handle.ready).finally(() => {
        if (navRef.current === handle) show()
      })
    } else {
      show()
    }
  }), [finish])

  const alert = useCallback((body, opts = {}) => openModal((resolve) => ({
    kind: 'alert',
    title: opts.title || 'Heads up',
    body,
    resolve: () => resolve(undefined),
  }), undefined), [openModal])

  const confirm = useCallback((body, opts = {}) => openModal((resolve) => ({
    kind: 'confirm',
    title: opts.title || 'Confirm',
    body,
    danger: !!opts.danger,
    resolve: (ok) => resolve(!!ok),
  }), false), [openModal])

  const prompt = useCallback((body, opts = {}) => openModal((resolve) => ({
    kind: 'prompt',
    title: opts.title || 'Enter a value',
    body,
    placeholder: opts.placeholder || '',
    defaultValue: opts.defaultValue || '',
    resolve,
  }), null), [openModal])

  const choose = useCallback((body, opts = {}) => openModal((resolve) => ({
    kind: 'choose',
    title: opts.title || 'Choose',
    body,
    actions: Array.isArray(opts.actions) ? opts.actions : [],
    resolve,
  }), null), [openModal])

  useEffect(() => () => {
    try { navRef.current?.close?.() } catch {}
    navRef.current = null
    resolveRef.current = null
  }, [])

  const node = state ? (
    <ModalView state={state} />
  ) : null

  return { node, alert, confirm, prompt, choose }
}

// Each open modal needs a stable, unique id to wire aria-labelledby from the
// dialog container to its title node. A module counter (not useId, which the
// pinned React build here doesn't export) keeps the id stable across renders.
let wsModalTitleSeq = 0

function ModalView({ state }) {
  const [value, setValue] = useState(state.kind === 'prompt' ? (state.defaultValue || '') : '')
  const inputRef = useRef(null)
  const dialogRef = useRef(null)
  // Capture the opener once, at mount, before focus moves into the dialog —
  // this is the element focus returns to on close. A ref (not state) because it
  // must survive every render without being a dependency.
  const openerRef = useRef(null)
  const titleId = useMemo(() => `ws-modal-title-${wsModalTitleSeq++}`, [])

  function cancel() {
    if (state.kind === 'alert') state.resolve()
    else state.resolve(state.kind === 'prompt' ? null : false)
  }

  // A custom dialog has to carry its own focus contract — role="dialog" alone
  // does not move focus in on open, trap Tab, close on Escape, or restore the
  // opener on close. We own all four here.
  useEffect(() => {
    openerRef.current = document.activeElement
    if (state.kind === 'prompt' && inputRef.current) {
      // Autofocus + select-all so the user can replace any prefilled value
      // with a single keypress.
      inputRef.current.focus()
      inputRef.current.select()
    } else {
      // Land focus inside the dialog so keyboard/AT users aren't stranded on
      // the inert content behind the scrim.
      dialogRef.current?.querySelector(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )?.focus()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        cancel()
        return
      }
      if (e.key !== 'Tab') return
      // Trap Tab/Shift+Tab to the dialog's focusable set so focus can't wander
      // to the inert editor behind the scrim. Computed per-keydown because the
      // prompt input and action labels change which nodes are focusable.
      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const opener = openerRef.current
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus()
      }
    }
  }, [state])
  function onSubmit(e) {
    e.preventDefault()
    if (state.kind === 'prompt') state.resolve(value)
    else if (state.kind === 'confirm') state.resolve(true)
    else if (state.kind === 'choose') state.resolve(null)
    else state.resolve()
  }
  return (
    <div className="ws-modal-scrim" onClick={cancel}>
      <div className="ws-modal" ref={dialogRef} onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <form onSubmit={onSubmit}>
          <div className="ws-modal-title" id={titleId}>{state.title}</div>
          <div className="ws-modal-body">{state.body}</div>
          {state.kind === 'prompt' && (
            <input
              ref={inputRef}
              className="ws-modal-input"
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={state.placeholder}
            />
          )}
          {state.kind === 'choose' && (
            <div className="ws-modal-options">
              {(state.actions || []).map((action) => (
                <button
                  key={String(action.value ?? action.label)}
                  type="button"
                  className={`ws-modal-option ${action.danger ? 'ws-modal-option--danger' : ''}`}
                  disabled={!!action.disabled}
                  onClick={() => state.resolve(action.value)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
          <div className="ws-modal-actions">
            {(state.kind === 'confirm' || state.kind === 'prompt' || state.kind === 'choose') && (
              <button
                type="button"
                className="ws-modal-btn ws-modal-btn--secondary"
                onClick={() => state.resolve(state.kind === 'confirm' ? false : null)}
              >
                Cancel
              </button>
            )}
            {state.kind !== 'choose' && (
              <button
                type="submit"
                className={`ws-modal-btn ${state.danger ? 'ws-modal-btn--danger' : 'ws-modal-btn--primary'}`}
              >
                {state.kind === 'confirm' ? (state.danger ? 'Delete' : 'OK') : 'OK'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------
// localStorage snapshot of the file index + recently-viewed file contents
// so an offline reload paints SOMETHING. Same shape as the LaTeX/news
// read-cache: small, per-app, deliberately not a write store.
// ----------------------------------------------------------------------
const FILE_CONTENT_CACHE_LIMIT = 20
const FILE_CACHE_VERSION = 1
const CHAT_OPEN_VERSION = 1
const CHAT_RATIO_VERSION = 1
const DEFAULT_PROJECT = { id: 'default', name: 'Project 1' }
const APP_VERSION = '0.12.2'

// The chat pane must never collapse smaller than the embedded composer's input
// pill — the owner spec is "down to the top of the input pill but not more and
// not less". The embed runs the real ChatView in an opaque iframe and publishes
// no composer-height var, so we floor the pane at the standard Möbius composer
// pill height (~64px) plus the divider (10px). The message list above the pill
// can collapse to zero; the pill itself always stays fully visible and usable.
// The same floor caps the OTHER end so the editor/preview never fully eats the
// chat. Same constants + helper as app-latex / app-editor.
const CHAT_PILL_MIN_PX = 64
const CHAT_DIVIDER_PX = 10
const CHAT_PANE_MIN_PX = CHAT_PILL_MIN_PX + CHAT_DIVIDER_PX

// Clamp a desired chat-pane height (px) into [pill, total - pill] and return it
// as a 0..1 ratio of the body. When the body is shorter than two pills, fall
// back to a 50/50 split so neither pane vanishes. Pure — unit-testable.
export function clampChatRatio(desiredPx, total, minPx) {
  if (!(total > 0)) return 0.5
  const floor = minPx
  const ceil = total - minPx
  // Body too short to honor both floors: split evenly rather than clip a pill.
  if (ceil <= floor) return 0.5
  const px = Math.max(floor, Math.min(ceil, desiredPx))
  return px / total
}

function activeProjectKey(appId) {
  return `webstudio:${appId}:activeProject`
}

function readActiveProject(appId) {
  if (typeof localStorage === 'undefined') return 'default'
  try {
    const stored = localStorage.getItem(activeProjectKey(appId))
    return isSafeProjectId(stored) ? stored : 'default'
  } catch {
    return 'default'
  }
}

function writeActiveProject(appId, id) {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(activeProjectKey(appId), id) } catch {}
}

function fileCacheKey(appId, projectId = 'default') {
  if (projectId === 'default') return `webstudio:${appId}:files-cache:v${FILE_CACHE_VERSION}`
  return `webstudio:${appId}:project:${projectId}:files-cache:v${FILE_CACHE_VERSION}`
}

function chatOpenKey(appId) {
  return `webstudio:${appId}:chat-open:v${CHAT_OPEN_VERSION}`
}

function chatRatioKey(appId) {
  return `webstudio:${appId}:chat-ratio:v${CHAT_RATIO_VERSION}`
}

function readChatOpen(appId) {
  if (typeof localStorage === 'undefined') return false
  try {
    const raw = localStorage.getItem(chatOpenKey(appId))
    if (raw === null) return false
    return JSON.parse(raw) === true
  } catch { return false }
}

function readChatRatio(appId) {
  if (typeof localStorage === 'undefined') return 0.5
  const raw = Number(localStorage.getItem(chatRatioKey(appId)))
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) return 0.5
  return raw
}

function readFileCache(appId, projectId = 'default') {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(fileCacheKey(appId, projectId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return normalizeFileCacheSnapshot(parsed)
  } catch {
    return null
  }
}

function writeFileCache(appId, projectId, index, contents, lastPath) {
  if (typeof localStorage === 'undefined') return
  try {
    const safeIndex = cleanIndexPaths(index)
    const trimmed = {}
    const indexSet = new Set(safeIndex)
    const entries = Object.entries(contents)
      .filter(([p, v]) => indexSet.has(p) && typeof v === 'string')
      .slice(-FILE_CONTENT_CACHE_LIMIT)
    for (const [p, v] of entries) trimmed[p] = v
    localStorage.setItem(
      fileCacheKey(appId, projectId),
      JSON.stringify({
        index: safeIndex,
        contents: trimmed,
        lastPath: (lastPath && indexSet.has(lastPath)) ? lastPath : null,
      }),
    )
  } catch {
    // Quota / disabled / serialization — leave the previous snapshot in place.
  }
}

function removeFileCache(appId, projectId) {
  if (typeof localStorage === 'undefined') return
  try { localStorage.removeItem(fileCacheKey(appId, projectId)) } catch {}
}

function normalizeProjects(raw) {
  if (!Array.isArray(raw)) return null
  const seen = new Set()
  const projects = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = item.id === 'default' ? 'default' : (isSafeProjectId(item.id) ? item.id : null)
    if (!id || seen.has(id)) continue
    const name = String(item.name || '').trim() || (id === 'default' ? 'Project 1' : id)
    const createdAt = Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
    seen.add(id)
    projects.push({ id, name, createdAt })
  }
  if (!seen.has('default')) {
    projects.unshift({ id: DEFAULT_PROJECT.id, name: DEFAULT_PROJECT.name, createdAt: Date.now() })
  }
  return projects
}

function projectSlug(name, existingIds) {
  const base = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    || 'project'
  let id = base
  while (!isSafeProjectId(id) || existingIds.has(id)) {
    const suffix = Math.random().toString(36).slice(2, 8)
    id = `${base.slice(0, Math.max(1, 63 - suffix.length))}-${suffix}`.slice(0, 64)
  }
  return id
}

async function deleteStorageTree(storage, prefix) {
  if (!prefix) throw new Error('deleteStorageTree: refusing empty prefix (would wipe app root)')
  const entries = await storage.list(prefix)
  for (const entry of entries) {
    if (entry.type === 'directory') await deleteStorageTree(storage, entry.path)
    else if (entry.type === 'file') await storage.remove(entry.path)
  }
  await storage.removeFolder(prefix.replace(/\/+$/, '')).catch(() => {})
}

// ----------------------------------------------------------------------
// Sync pill. Three observable states, in priority order:
//   pending > 0 + offline  → "Offline · N pending"
//   pending > 0 + online   → "Saving · N pending"
//   offline + pending == 0 → "Offline"
//   online + pending == 0  → null (idle steady state)
// hasRuntime=false (older shell) hides the pill rather than fabricate a queue.
// ----------------------------------------------------------------------
// Standard: show nothing when online+idle. Only surface Offline (with optional
// pending count) — that's the one state the user needs to know about.
function SyncPill({ online, pending, hasRuntime }) {
  if (!hasRuntime) return null
  if (online && pending === 0) return null
  const label = !online
    ? (pending > 0 ? `Offline · ${pending} pending` : 'Offline')
    : null
  if (!label) return null
  return (
    <div
      className="ws-sync-pill ws-sync-pill--offline"
      role="status"
      aria-live="polite"
      title="Changes save locally and sync when you're back online."
    >
      <span className="ws-sync-pill-dot" aria-hidden="true" />
      {label}
    </div>
  )
}

// ----------------------------------------------------------------------
// CodeMirror source editor — a parallel copy of the plain editor in the Editor
// app (app-editor/index.jsx), kept VERBATIM so both apps stay consistent. Web
// Studio edits HTML/CSS/JS source, so only the plain-text path is used (no
// markdown live-preview, no KaTeX, no syntax highlighting): `markdown` is
// always false and `buildPlainExtensions` is the only stack.
//
// A plain-text theme for source — monospace, no markdown highlighting, no live
// preview. The 2px var(--accent) caret matches the rest of the Möbius chrome.
const cmThemePlain = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)', lineHeight: '1.6', fontSize: '13.5px' },
  '.cm-content': { padding: '14px 16px 30vh', caretColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)' },
})

function buildPlainExtensions(onDocChange) {
  return [
    history(),
    EditorView.lineWrapping,
    keymap.of([indentWithTab, ...historyKeymap, ...defaultKeymap]),
    cmThemePlain,
    EditorView.updateListener.of((u) => { if (u.docChanged) onDocChange(u.state.doc.toString()) }),
  ]
}

// ----------------------------------------------------------------------
// CodeMirror React wrapper. Mounts an EditorView whose extension stack is
// chosen by `markdown` (live-preview vs plain monospace). `value` seeds the
// doc; an EXTERNAL change (open a different file, or the agent edited the file
// and a SWR revalidation re-read it) replaces the whole doc — but only when the
// user isn't the one who just typed it. We track the last value emitted by
// local typing in `lastEmitted` so a parent re-render that echoes our own
// onChange back as `value` does NOT reset the cursor (this is what fixes Web
// Studio's old cursor-jump on each SWR poll). The view is rebuilt only when
// `markdown`/`docKey` change (different file or syntax mode), because the
// extension stack differs. `readOnly` is NOT a rebuild trigger: a transient
// readOnly flip (meta briefly null on agent reload) would tear down the view
// and reset the caret to position 0. Instead read-only is reconfigured live
// through a Compartment, leaving the view (and cursor) intact.
//
// Web Studio passes markdown={false} always — buildMarkdownExtensions is not
// imported here, so the markdown branch is unreachable and intentionally absent.
// ----------------------------------------------------------------------
function CodeEditor({ value, markdown: isMd, readOnly, docKey, onChange }) {
  const host = useRef(null)
  const view = useRef(null)
  const onChangeRef = useRef(onChange)
  const lastEmitted = useRef(value)
  const roCompartment = useRef(null)
  if (roCompartment.current === null) roCompartment.current = new Compartment()
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  // Rebuild the view when the file (docKey) or the syntax mode (markdown)
  // changes. Read-only lives in a compartment (reconfigured below), so a
  // readOnly flip does NOT rebuild. Editing the same file just dispatches doc
  // changes (effect further below).
  useEffect(() => {
    const emit = (text) => {
      lastEmitted.current = text
      if (onChangeRef.current) onChangeRef.current(text)
    }
    const base = buildPlainExtensions(emit)
    const extensions = [
      ...base,
      roCompartment.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    ]
    const state = EditorState.create({ doc: value || '', extensions })
    const v = new EditorView({ state, parent: host.current })
    view.current = v
    lastEmitted.current = value || ''
    return () => { v.destroy(); view.current = null }
    // value/readOnly are intentionally omitted: a docKey change carries the new
    // file's value (reacting to value would rebuild on every keystroke), and
    // readOnly is reconfigured via the compartment effect below, not a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, isMd])

  // Read-only toggled for the SAME view (meta resolved/cleared on reload) —
  // reconfigure the compartment in place. No view rebuild, so the cursor stays.
  useEffect(() => {
    const v = view.current
    if (!v) return
    v.dispatch({
      effects: roCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    })
  }, [readOnly])

  // External value change for the SAME file (agent edit re-read, or a
  // revalidation) — replace the doc, but skip our own echo so typing isn't
  // interrupted and the cursor doesn't jump.
  useEffect(() => {
    const v = view.current
    if (!v) return
    if (value == null) return
    if (value === lastEmitted.current) return
    const cur = v.state.doc.toString()
    if (value === cur) return
    v.dispatch({ changes: { from: 0, to: cur.length, insert: value } })
    lastEmitted.current = value
  }, [value])

  return <div ref={host} className="ws-cm-host" />
}

// ----------------------------------------------------------------------
// Build controller. Owns the source→site assemble state machine and the
// poll loop. The actual assemble runs server-side (build.sh, triggered by
// run-job); the app's job is to set the target, kick the run, then poll
// build/status.json until the script writes a verdict.
//
// State machine:
//   idle → building → done   (status.json says {status:'done', entry,...})
//                   → error  (status.json says {status:'error', log} OR
//                             run-job refused OR the cap elapsed)
//
// status.json 404s the entire time the build is running (the script only
// writes it at the end), so a 404 during polling is "still building".
// ----------------------------------------------------------------------
const BUILD_POLL_MS = 2000
const BUILD_TIMEOUT_MS = 120000
const SOURCE_AUTOSAVE_MS = 700
const SOURCE_SYNC_MS = 3500
const PROJECT_SYNC_MS = 5000

function useBuild({ appId, token, storage, rootStorage, prefix, online }) {
  const [buildStatus, setBuildStatus] = useState('idle') // idle|building|done|error
  const [buildLog, setBuildLog] = useState('')
  // Which page the current/last build is FOR. The hook tracks one build at a
  // time; this lets the viewer scope "Building…" / "Build failed" to the doc
  // that's actually compiling.
  const [buildDoc, setBuildDoc] = useState(null)
  // doc path → { entry, ver }. `ver` is a monotonic per-build token (see
  // finishDone) so the viewer refetches even when the entry path is unchanged.
  const [entryByDoc, setEntryByDoc] = useState({})
  const pollRef = useRef(null)
  const deadlineRef = useRef(0)
  const buildSeqRef = useRef(0)
  const buildGenerationRef = useRef(0)
  const buildingRef = useRef(false)

  const clearPoll = useCallback(() => {
    buildGenerationRef.current += 1
    if (pollRef.current) {
      clearTimeout(pollRef.current)
      pollRef.current = null
    }
    deadlineRef.current = 0
    // An orphaned in-flight build's poll will never reach finishDone/Error
    // (its generation is now stale), so its buildingRef would stay stuck true
    // and block all future builds. Release it here.
    buildingRef.current = false
  }, [])

  useEffect(() => clearPoll, [clearPoll])

  useEffect(() => {
    clearPoll()
    buildingRef.current = false
    setBuildStatus('idle')
    setBuildLog('')
    setBuildDoc(null)
    setEntryByDoc({})
  }, [prefix, clearPoll])

  const finishDone = useCallback((doc, entry) => {
    clearPoll()
    buildingRef.current = false
    setBuildStatus('done')
    setBuildLog('')
    if (doc && entry) {
      // Stamp a fresh token on every successful build. The entry path is
      // deterministic per doc, so a rebuild yields the identical string;
      // the token gives each build a new value identity so HtmlPreview
      // refetches the fresh bytes.
      const ver = (buildSeqRef.current += 1)
      setEntryByDoc((prev) => ({ ...prev, [doc]: { entry, ver } }))
    }
  }, [clearPoll])

  const finishError = useCallback((log) => {
    clearPoll()
    buildingRef.current = false
    setBuildStatus('error')
    setBuildLog(log || 'Build failed.')
  }, [clearPoll])

  // One poll tick: read build/status.json. 404/null → still building (or the
  // cap elapsed → error). A verdict object → done/error.
  const poll = useCallback(async (doc, onDone, generation) => {
    if (generation !== buildGenerationRef.current) return
    if (Date.now() > deadlineRef.current) {
      finishError('Build timed out (over 2 minutes). Try again, or check the '
        + 'files are valid.')
      return
    }
    let status = null
    try {
      status = await storage.get('build/status.json')
    } catch (e) {
      status = null
    }
    if (generation !== buildGenerationRef.current) return
    if (status && typeof status === 'object' && status.status) {
      // The verdict echoes the target it was built FROM. build/target.txt +
      // build/status.json are one shared pair per app, so a build kicked from
      // another tab/device for a DIFFERENT doc can land its verdict here. If
      // it isn't the doc we're waiting on, ignore it and keep polling.
      if (status.target && status.target !== doc) {
        pollRef.current = setTimeout(() => poll(doc, onDone, generation), BUILD_POLL_MS)
        return
      }
      if (status.status === 'done') {
        const entry = entryFromBuildStatusForDoc(status, doc) || entryPathForHtmlDoc(doc)
        finishDone(doc, entry)
        if (typeof onDone === 'function' && entry) onDone(doc, entry)
        return
      }
      finishError(status.log || 'Build failed.')
      return
    }
    pollRef.current = setTimeout(() => poll(doc, onDone, generation), BUILD_POLL_MS)
  }, [storage, finishDone, finishError])

  // Kick a build for `doc` (a "files/<entry>.html" path). onDone fires once the
  // site is assembled. Guards against concurrent builds + offline.
  const build = useCallback(async (doc, onDone) => {
    if (buildingRef.current) return
    if (!isHtmlDoc(doc)) return
    if (!online) {
      finishError('You are offline. Building needs a connection — reconnect and try again.')
      return
    }
    clearPoll()
    buildingRef.current = true
    const generation = buildGenerationRef.current
    setBuildDoc(doc)
    setBuildStatus('building')
    setBuildLog('')
    try {
      // 0. Clear any verdict from a PRIOR build so the first poll sees 404
      // (still building) until the new run lands a fresh verdict.
      await storage.remove('build/status.json')
      // 1. Tell the build script which page is the entry.
      await storage.setText('build/target.txt', doc)
      // 1b. /run-job invokes build.sh with only appId, so the script reads a
      // root dispatch target that can point at either the legacy root project
      // or a projects/<id>/ subtree. The actual per-project target above is
      // still the durable storage key used by the app.
      await rootStorage.setText('build/target.txt', `${prefix || ''}${doc}`)
      // 2. Kick the server-side job. 202 = accepted; anything else is fatal.
      const r = await fetch(`/api/apps/${appId}/run-job`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (r.status !== 202) {
        let detail = ''
        try { detail = (await r.json()).detail || '' } catch { /* non-JSON body */ }
        finishError(
          `Could not start the build (server returned ${r.status}${detail ? `: ${detail}` : ''}).`,
        )
        return
      }
      // 3. Poll status.json until the script writes its verdict.
      deadlineRef.current = Date.now() + BUILD_TIMEOUT_MS
      pollRef.current = setTimeout(() => poll(doc, onDone, generation), BUILD_POLL_MS)
    } catch (e) {
      finishError((e && e.message) ? e.message : 'Build failed to start.')
    }
  }, [appId, token, storage, rootStorage, prefix, online, clearPoll, finishError, poll])

  const rememberEntry = useCallback((doc, entry) => {
    if (buildingRef.current) return
    if (!doc || !entry) return
    setBuildDoc(doc)
    finishDone(doc, entry)
  }, [finishDone])

  return {
    buildStatus, buildLog, buildDoc, entryByDoc, build, rememberEntry, clearPoll,
    forgetDoc: useCallback((doc) => {
      setEntryByDoc((prev) => {
        if (!(doc in prev)) return prev
        const next = { ...prev }
        delete next[doc]
        return next
      })
    }, []),
    rewriteDocs: useCallback((rewrite) => {
      setEntryByDoc((prev) => {
        const next = {}
        for (const [doc, rec] of Object.entries(prev)) {
          // The doc key follows the rename; the built entry lives under
          // build/site/ keyed by the source-relative path, so it also moves.
          const movedEntry = `build/site/${rewrite(doc).slice('files/'.length)}`
          next[rewrite(doc)] = { ...rec, entry: movedEntry }
        }
        return next
      })
    }, []),
    forgetUnder: useCallback((prefix) => {
      setEntryByDoc((prev) => {
        let changed = false
        const next = {}
        for (const [doc, rec] of Object.entries(prev)) {
          if (doc === prefix || doc.startsWith(`${prefix}/`)) { changed = true; continue }
          next[doc] = rec
        }
        return changed ? next : prev
      })
    }, []),
  }
}

// ----------------------------------------------------------------------
// Top-level app.
// ----------------------------------------------------------------------
export default function App({ appId, token }) {
  const rootStorage = useMemo(() => makeStorage(appId, token), [appId, token])
  const [activeProjectId, setActiveProjectId] = useState(() => readActiveProject(appId))
  const activePrefix = useMemo(() => projectPrefix(activeProjectId), [activeProjectId])
  const storage = useMemo(() => scopedStorage(rootStorage, activePrefix), [rootStorage, activePrefix])
  const online = useOnline()
  const rawModal = useModal()
  const bodyRef = useRef(null)
  const cached = useMemo(() => readFileCache(appId, activeProjectId), [appId, activeProjectId])
  const [projects, setProjects] = useState([])
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [files, setFiles] = useState(() => cached?.index || [])
  const filesRef = useRef(files)
  const [fileCache, setFileCache] = useState(() => cached?.contents || {})
  const [indexLoaded, setIndexLoaded] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const navHandleRef = useRef(null)
  const navOpenRef = useRef(false)
  useEffect(() => { navOpenRef.current = navOpen }, [navOpen])
  const openNavRef = useRef(null)
  // Modals ride the shell's single-surface nav, which closes the drawer when a
  // modal opens. Wrap the modal API once so any prompt/confirm/alert/choose
  // re-opens the drawer afterward if it was open — e.g. cancelling a rename
  // returns to the drawer instead of leaving it closed.
  const modal = useMemo(() => {
    const wrap = (name) => (...args) => {
      const wasOpen = navOpenRef.current
      return Promise.resolve(rawModal[name](...args)).finally(() => {
        if (wasOpen && openNavRef.current) openNavRef.current()
      })
    }
    return { node: rawModal.node, alert: wrap('alert'), confirm: wrap('confirm'), prompt: wrap('prompt'), choose: wrap('choose') }
  }, [rawModal])
  const navToggleRef = useRef(null)
  const [selectedPath, setSelectedPath] = useState(() => cached?.lastPath || null)
  const selectedPathRef = useRef(selectedPath)
  useEffect(() => { selectedPathRef.current = selectedPath }, [selectedPath])
  const [fileContent, setFileContent] = useState('')
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState(null)
  const [fileDirty, setFileDirty] = useState(false)
  const [fileSaving, setFileSaving] = useState(false)
  const fileContentRef = useRef(fileContent)
  const fileDirtyRef = useRef(fileDirty)
  const fileSavingRef = useRef(fileSaving)
  // The in-flight autosave write, so flushDirtyEdits can AWAIT it (not poll a flag).
  const savePromiseRef = useRef(null)
  useEffect(() => { fileContentRef.current = fileContent }, [fileContent])
  useEffect(() => { fileDirtyRef.current = fileDirty }, [fileDirty])
  useEffect(() => { fileSavingRef.current = fileSaving }, [fileSaving])
  const [pending, setPending] = useState(0)
  const [chatOpen, setChatOpen] = useState(() => readChatOpen(appId))
  const [chatRatio, setChatRatio] = useState(() => readChatRatio(appId))
  const [publishedUrl, setPublishedUrl] = useState(null)
  const [publishing, setPublishing] = useState(false)
  const publishingRef = useRef(false)
  // Bumped on every publish/unpublish; the restore effect captures it and skips
  // its async setState if a newer publish/unpublish landed meanwhile (#7).
  const publishEpochRef = useRef(0)
  useEffect(() => { publishingRef.current = publishing }, [publishing])
  // Viewer mode, toggled by the [Source | Preview] segmented control. 'source'
  // shows the editable CodeMirror source; 'preview' shows the MAIN page's built site.
  const [viewMode, setViewMode] = useState('source')
  // The designated MAIN page — the HTML the Preview renders. Persisted in
  // main.json and defaulted (below) to the first .html (preferring
  // files/index.html). null until the index loads + a default is resolved.
  const [mainPath, setMainPath] = useState(null)
  const [mainReady, setMainReady] = useState(false)
  const mainPathRef = useRef(null)
  useEffect(() => { mainPathRef.current = mainPath }, [mainPath])
  const mainResolvedRef = useRef(false)
  const build = useBuild({ appId, token, storage, rootStorage, prefix: activePrefix, online })
  const clearBuildPoll = build.clearPoll
  const seenBuildStatusRef = useRef('')
  const hydratedProjectRef = useRef(activeProjectId)
  const readFreshProjects = useCallback(async () => {
    try {
      const stored = await rootStorage.getFresh('projects.json')
      const fresh = normalizeProjects(stored)
      if (fresh && fresh.length > 0) return fresh
    } catch {
      // Fall through to the in-memory list, then the seeded default.
    }
    const fallback = normalizeProjects(projects)
    if (fallback && fallback.length > 0) return fallback
    return [{ id: DEFAULT_PROJECT.id, name: DEFAULT_PROJECT.name, createdAt: Date.now() }]
  }, [projects, rootStorage])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(chatOpenKey(appId), JSON.stringify(chatOpen)) } catch {}
  }, [appId, chatOpen])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(chatRatioKey(appId), String(chatRatio)) } catch {}
  }, [appId, chatRatio])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stored = await rootStorage.get('projects.json')
        let next = normalizeProjects(stored)
        if (!next || next.length === 0) {
          next = [{ id: DEFAULT_PROJECT.id, name: DEFAULT_PROJECT.name, createdAt: Date.now() }]
        }
        if (cancelled) return
        setProjects(next)
        setProjectsLoaded(true)
        if (!next.some((p) => p.id === activeProjectId)) {
          setActiveProjectId('default')
          writeActiveProject(appId, 'default')
        }
        if (!stored || !Array.isArray(stored) || next.length !== stored.length) {
          rootStorage.setJSON('projects.json', next).catch(() => {})
        }
      } catch {
        if (!cancelled) {
          const fallback = [{ id: DEFAULT_PROJECT.id, name: DEFAULT_PROJECT.name, createdAt: Date.now() }]
          setProjects(fallback)
          setProjectsLoaded(true)
        }
      }
    })()
    return () => { cancelled = true }
  }, [appId, activeProjectId, rootStorage])

  useEffect(() => {
    clearBuildPoll()
    const switchingProject = hydratedProjectRef.current !== activeProjectId
    hydratedProjectRef.current = activeProjectId
    const snapshot = switchingProject ? null : readFileCache(appId, activeProjectId)
    const nextFiles = snapshot?.index || []
    filesRef.current = nextFiles
    selectedPathRef.current = snapshot?.lastPath || null
    mainResolvedRef.current = false
    seenBuildStatusRef.current = ''
    mainPathRef.current = null
    fileContentRef.current = ''
    fileDirtyRef.current = false
    fileSavingRef.current = false
    setFiles(nextFiles)
    setFileCache(snapshot?.contents || {})
    setIndexLoaded(false)
    setSelectedPath(snapshot?.lastPath || null)
    setFileContent('')
    setFileLoading(false)
    setFileError(null)
    setFileDirty(false)
    setFileSaving(false)
    setMainPath(null)
    setMainReady(false)
    setViewMode('source')
    setPublishedUrl(null)
    try { navHandleRef.current?.close?.() } catch {}
    navHandleRef.current = null
    setNavOpen(false)
  }, [appId, activeProjectId, clearBuildPoll])

  useEffect(() => {
    let cancelled = false
    const epoch = publishEpochRef.current
    const projectParam = activeProjectId === 'default' ? '' : activeProjectId
    ;(async () => {
      try {
        const r = await fetch(`/api/apps/${appId}/publish?project_id=${encodeURIComponent(projectParam)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!cancelled && r.ok) {
          const data = await r.json()
          if (cancelled || epoch !== publishEpochRef.current) return
          const url = data.url || data.published_url || data.publishedUrl || null
          setPublishedUrl(url ? new URL(url, window.location.origin).href : null)
          return
        }
      } catch {
        // Fall back to app storage below.
      }
      try {
        const toPublishedUrl = (value) => {
          const clean = String(value || '').trim()
          if (!clean) return null
          if (/^https?:\/\//i.test(clean) || clean.startsWith('/')) {
            return new URL(clean, window.location.origin).href
          }
          return new URL(`/apps/${appId}/published/${clean}`, window.location.origin).href
        }
        let stored = null
        for (const path of ['publish-url.txt', 'published-url.txt', 'publish-token.txt']) {
          stored = await storage.getText(path)
          if (stored) break
        }
        if (cancelled || epoch !== publishEpochRef.current) return
        setPublishedUrl(toPublishedUrl(stored))
      } catch {
        if (!cancelled && epoch === publishEpochRef.current) setPublishedUrl(null)
      }
    })()
    return () => { cancelled = true }
  }, [activeProjectId, appId, storage, token])

  const toggleChat = useCallback(() => {
    setChatOpen((open) => {
      // Turning on always spawns a 50/50 split — the divider in the middle —
      // regardless of where a previous drag left it (owner spec).
      if (!open) setChatRatio(0.5)
      return !open
    })
  }, [])

  const beginChatResize = useCallback((event) => {
    event.preventDefault()
    const body = bodyRef.current
    if (!body) return
    const total = body.getBoundingClientRect().height
    if (!total) return

    const startY = event.clientY
    const startRatioPx = total * chatRatio
    const divider = event.currentTarget
    const pointerId = event.pointerId

    // Capture the pointer so the drag survives crossing the preview iframe.
    divider.setPointerCapture?.(pointerId)

    const onMove = (moveEvent) => {
      // Px-bounded, not fractional: dragging all the way down collapses the
      // chat to exactly the composer pill (CHAT_PANE_MIN_PX) and no smaller;
      // dragging all the way up leaves at least one pill of editor/preview.
      const desiredPx = startRatioPx + startY - moveEvent.clientY
      setChatRatio(clampChatRatio(desiredPx, total, CHAT_PANE_MIN_PX))
    }

    // One teardown for every way the drag can end. pointerup is the normal
    // case, but an interrupted drag (incoming notification, system gesture
    // cancel, focus steal) fires pointercancel / lostpointercapture instead;
    // without handling those the move listener and the pointer capture leak.
    const endDrag = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      divider.removeEventListener('lostpointercapture', endDrag)
      try { divider.releasePointerCapture?.(pointerId) } catch {}
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    divider.addEventListener('lostpointercapture', endDrag)
  }, [chatRatio])

  const handleResizeKey = useCallback((event) => {
    const total = bodyRef.current?.getBoundingClientRect().height || 0
    if (!total) return
    // Same px floor as the drag path: Home collapses the chat to exactly the
    // composer pill, End leaves one pill of editor/preview; Arrows step by ~6%
    // but can never cross either floor (clampChatRatio enforces both ends).
    const step = total * 0.06
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setChatRatio((r) => clampChatRatio(r * total + step, total, CHAT_PANE_MIN_PX))
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setChatRatio((r) => clampChatRatio(r * total - step, total, CHAT_PANE_MIN_PX))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setChatRatio(clampChatRatio(0, total, CHAT_PANE_MIN_PX))
    } else if (event.key === 'End') {
      event.preventDefault()
      setChatRatio(clampChatRatio(total, total, CHAT_PANE_MIN_PX))
    }
  }, [])

  useEffect(() => {
    writeFileCache(appId, activeProjectId, files, fileCache, selectedPath)
  }, [appId, activeProjectId, files, fileCache, selectedPath])

  useEffect(() => { filesRef.current = files }, [files])

  const refreshPending = useCallback(async () => {
    try {
      const n = await storage.pendingCount()
      setPending(n)
    } catch {
      // Leave the previous count alone on transient errors.
    }
  }, [storage])

  useEffect(() => {
    refreshPending()
    const id = setInterval(refreshPending, 10000)
    return () => clearInterval(id)
  }, [refreshPending])
  useEffect(() => {
    refreshPending()
  }, [online, refreshPending])

  const closeNav = useCallback(() => {
    try { navHandleRef.current?.close?.() } catch {}
    navHandleRef.current = null
    setNavOpen(false)
  }, [])

  const openNav = useCallback(async () => {
    if (navOpenRef.current) return
    navOpenRef.current = true
    if (window.mobius?.nav?.open) {
      const handle = window.mobius.nav.open('webstudio-drawer', () => {
        navHandleRef.current = null
        setNavOpen(false)
      })
      navHandleRef.current = handle
      await handle.ready?.catch(() => false)
      if (navHandleRef.current !== handle) return
    }
    setNavOpen(true)
  }, [])
  useEffect(() => { openNavRef.current = openNav }, [openNav])

  const toggleNav = useCallback(() => {
    if (navOpen) closeNav()
    else openNav()
  }, [closeNav, navOpen, openNav])

  useEffect(() => () => {
    try { navHandleRef.current?.close?.() } catch {}
    navHandleRef.current = null
  }, [])

  // Pull the canonical file list out of files-index.json. Falls back to
  // ["files/index.html"] when the index doesn't exist. When offline,
  // storage.get returns null — we keep the localStorage snapshot.
  const refreshFiles = useCallback(async () => {
    try {
      const idx = await (online ? storage.getFresh('files-index.json') : storage.get('files-index.json'))
      if (Array.isArray(idx)) {
        const cleaned = cleanIndexPaths(idx)
        filesRef.current = cleaned
        setFiles(cleaned)
        setIndexLoaded(true)
        if (selectedPath && !cleaned.includes(selectedPath)) {
          setSelectedPath(null)
          setFileContent('')
          setFileCache((prev) => {
            if (!(selectedPath in prev)) return prev
            const next = { ...prev }
            delete next[selectedPath]
            return next
          })
        }
      } else if (idx === null && !online) {
        return
      } else {
        if (!online) return
        const probe = await (online ? storage.getFresh('files/index.html') : storage.get('files/index.html'))
        const seed = probe ? ['files/index.html'] : []
        await storage.setJSON('files-index.json', seed)
        filesRef.current = seed
        setFiles(seed)
        setIndexLoaded(true)
      }
    } catch (e) {
      // Don't blank the UI on a transient read failure — keep the prior list.
    }
  }, [storage, selectedPath, online])

  useEffect(() => {
    refreshFiles()
  }, [activeProjectId, refreshFiles])

  // Pick a sensible default main page: files/index.html if present, else the
  // first .html alphabetically, else null.
  const defaultMain = useCallback((list) => {
    if (list.includes('files/index.html')) return 'files/index.html'
    return list.find((p) => isHtmlDoc(p)) || null
  }, [])

  useEffect(() => {
    if (!indexLoaded || mainResolvedRef.current) return
    let cancelled = false
    ;(async () => {
      let stored = null
      try {
        const m = await (online ? storage.getFresh('main.json') : storage.get('main.json'))
        if (m && typeof m === 'object' && typeof m.path === 'string') stored = m.path
      } catch { /* offline / transient — fall through to default */ }
      // A connectivity flip mid-flight re-runs this effect. We mark resolved
      // only AFTER a non-cancelled completion (not at effect entry), so an
      // interrupted first pass doesn't permanently strip mainPath — and thus
      // the Build/Preview controls — by leaving mainReady false forever.
      if (cancelled) return
      mainResolvedRef.current = true
      const list = filesRef.current
      if (stored && list.includes(stored)) {
        setMainPath(stored)
      } else {
        const fallback = defaultMain(list)
        setMainPath(fallback)
        if (fallback && online) {
          storage.setJSON('main.json', { path: fallback }).catch(() => {})
        }
      }
      setMainReady(true)
    })()
    return () => { cancelled = true }
  }, [indexLoaded, storage, online, defaultMain])

  // Auto-select the first file once we have one — deferred until main.json
  // has resolved so pickAutoSelectPath can prefer the main page. files/
  // lands before main.json, so an undeferred pick would grab whatever HTML
  // file sorts first and hide the Build/Preview controls on first load.
  useEffect(() => {
    if (selectedPath || !mainReady || files.length === 0) return
    const firstReal = pickAutoSelectPath(files, mainPath)
    if (firstReal) setSelectedPath(firstReal)
  }, [files, selectedPath, mainPath, mainReady])

  // Keep the main page valid as the file list changes.
  useEffect(() => {
    if (!mainReady) return
    if (mainPath && !files.includes(mainPath)) {
      const fallback = defaultMain(files)
      setMainPath(fallback)
      if (online) {
        if (fallback) storage.setJSON('main.json', { path: fallback }).catch(() => {})
        else storage.remove('main.json').catch(() => {})
      }
    } else if (!mainPath && files.some((p) => isHtmlDoc(p))) {
      const fallback = defaultMain(files)
      setMainPath(fallback)
      if (fallback && online) storage.setJSON('main.json', { path: fallback }).catch(() => {})
    }
  }, [files, mainPath, mainReady, online, storage, defaultMain])

  // Restore the previous successful build on app entry. A built site is durable
  // storage, but entryByDoc is React state and starts empty on every mount.
  useEffect(() => {
    if (!mainReady || !indexLoaded || !mainPath) return undefined
    if (build.buildStatus === 'building' || build.entryByDoc[mainPath]) return undefined
    let cancelled = false
    ;(async () => {
      let entryPath = null
      try {
        const status = await (online ? storage.getFresh('build/status.json') : storage.get('build/status.json'))
        if (cancelled) return
        entryPath = entryFromBuildStatusForDoc(status, mainPath)
      } catch {
        // Fall through to probing the deterministic entry path.
      }

      if (!entryPath) {
        const candidate = entryPathForHtmlDoc(mainPath)
        if (candidate) {
          try {
            const built = await storage.getText(candidate)
            if (cancelled) return
            if (typeof built === 'string') entryPath = candidate
          } catch {
            // Missing built page: leave the view in "No preview yet".
          }
        }
      }

      if (!cancelled && entryPath) build.rememberEntry(mainPath, entryPath)
    })()
    return () => { cancelled = true }
  }, [
    mainReady,
    indexLoaded,
    mainPath,
    files,
    storage,
    build.buildStatus,
    build.entryByDoc,
    build.rememberEntry,
    online,
  ])

  const syncProjectFromStorage = useCallback(async () => {
    if (!online) return
    await refreshFiles()
    const list = filesRef.current

    try {
      const stored = await storage.getFresh('main.json')
      if (stored && typeof stored === 'object' && typeof stored.path === 'string') {
        if (stored.path !== mainPathRef.current && list.includes(stored.path)) {
          setMainPath(stored.path)
        }
      }
    } catch {
      // Best-effort convergence; the next loop/focus retries.
    }

    try {
      const status = await storage.getFresh('build/status.json')
      const doc = (status && typeof status.target === 'string')
        ? status.target
        : mainPathRef.current
      const entry = entryFromBuildStatusForDoc(status, doc)
      if (doc && entry) {
        const buildKey = `${doc}|${entry}|${status?.built_at || status?.log || ''}`
        if (seenBuildStatusRef.current !== buildKey) {
          seenBuildStatusRef.current = buildKey
          build.rememberEntry(doc, entry)
        }
      }
    } catch {
      // Best-effort; a missing status file just means no successful build yet.
    }
  }, [
    online,
    refreshFiles,
    storage,
    build.rememberEntry,
  ])

  useEffect(() => {
    if (!online) return undefined
    syncProjectFromStorage()
    const interval = setInterval(syncProjectFromStorage, PROJECT_SYNC_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') syncProjectFromStorage()
    }
    window.addEventListener('focus', syncProjectFromStorage)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', syncProjectFromStorage)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [online, syncProjectFromStorage])

  // Set an .html file as the main page (from the drawer context menu).
  const handleSetMain = useCallback(async (path) => {
    if (!isHtmlDoc(path)) return
    setMainPath(path)
    try {
      await storage.setJSON('main.json', { path })
      refreshPending()
    } catch (e) {
      await modal.alert(e.message || String(e), { title: 'Could not set main page' })
    }
  }, [storage, refreshPending, modal])

  // Load the selected file's content. Cache-first for first paint, then
  // stale-while-revalidate while online.
  useEffect(() => {
    if (!selectedPath) {
      setFileContent('')
      setFileError(null)
      setFileLoading(false)
      setFileDirty(false)
      return
    }
    if (isBinaryProjectPath(selectedPath)) {
      setFileContent('')
      setFileLoading(false)
      setFileError(null)
      setFileDirty(false)
      return
    }
    let cancelled = false
    const path = selectedPath

    const applyBody = (body) => {
      if (cancelled || selectedPathRef.current !== path) return
      if (fileDirtyRef.current || fileSavingRef.current) return
      setFileContent(body)
      setFileError(null)
      setFileDirty(false)
      setFileCache((prev) => (prev[path] === body ? prev : { ...prev, [path]: body }))
    }

    const applyMissing = () => {
      if (cancelled || selectedPathRef.current !== path) return
      if (fileDirtyRef.current || fileSavingRef.current) return
      setFileContent('')
      setFileError('File not found — was it deleted?')
      setFileDirty(false)
      setFileCache((prev) => {
        if (!(path in prev)) return prev
        const next = { ...prev }
        delete next[path]
        return next
      })
    }

    // subscribeText is a TEXT-kind read; a managed .json path holds JSON and
    // must be read with the JSON getter (assertReadKind throws on a wrong-kind
    // subscribe). For .json we skip the live subscription and rely on the
    // readLatest() poll below, which uses storage.get + JSON.stringify.
    const unsubscribe = isManagedJsonPath(path)
      ? () => {}
      : storage.subscribeText(path, (body) => {
        if (typeof body === 'string') applyBody(body)
        else if (body == null) applyMissing()
      })

    const cachedBody = fileCache[selectedPath]
    let painted = typeof cachedBody === 'string'
    if (typeof cachedBody === 'string') {
      setFileContent(cachedBody)
      setFileError(null)
      setFileLoading(false)
      setFileDirty(false)
    }

    if (!online && typeof cachedBody !== 'string') {
      setFileContent('')
      setFileError('Not available offline. Open this file once online to cache it.')
      setFileLoading(false)
      setFileDirty(false)
    }

    const readLatest = () => {
      if (!online) return
      if (fileDirtyRef.current || fileSavingRef.current) return
      if (!painted) setFileLoading(true)
      setFileError(null)
      storage.get(path).then((data) => {
        if (cancelled) return
        if (data == null) applyMissing()
        else if (typeof data === 'string') applyBody(data)
        else applyBody(JSON.stringify(data, null, 2))
        painted = true
        setFileLoading(false)
      }).catch((e) => {
        if (!cancelled) {
          setFileError(e.message || 'Could not load file.')
          setFileLoading(false)
          setFileDirty(false)
        }
      })
    }

    readLatest()
    const interval = online
      ? setInterval(() => { readLatest() }, SOURCE_SYNC_MS)
      : null
    const onVisible = () => {
      if (document.visibilityState === 'visible') readLatest()
    }
    window.addEventListener('focus', readLatest)
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      if (interval) clearInterval(interval)
      window.removeEventListener('focus', readLatest)
      document.removeEventListener('visibilitychange', onVisible)
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, storage, online])

  useEffect(() => {
    if (!navOpen) return
    refreshFiles()
  }, [navOpen, refreshFiles])

  const onFilesMaybeChanged = useCallback(async () => {
    await syncProjectFromStorage()
    const path = selectedPathRef.current
    if (path && online && isTextProjectPath(path)) {
      storage.get(path).catch(() => {})
    }
  }, [syncProjectFromStorage, storage, online])

  const ensureIndexWritable = useCallback(async () => {
    if (indexLoaded) return true
    await modal.alert(
      'Your file list hasn’t loaded yet. Reconnect (or wait for it to '
        + 'sync) before adding or deleting files, so this doesn’t '
        + 'overwrite work that’s already saved.',
      { title: 'File list not ready' },
    )
    return false
  }, [indexLoaded, modal])

  const handleCreateFile = useCallback(async () => {
    if (!(await ensureIndexWritable())) return
    const name = await modal.prompt(
      'File path — e.g. about.html or css/site.css',
      { title: 'New file', placeholder: 'about.html' },
    )
    if (!name) return
    const clean = name.replace(/^\/+/, '').trim()
    if (!isSafeRelPath(clean)) {
      await modal.alert('Use letters, digits, . - _ / only.', { title: 'Invalid name' })
      return
    }
    const path = `files/${clean}`
    if (filesRef.current.includes(path)) {
      await modal.alert(`“${path}” already exists.`, { title: 'Name taken' })
      return
    }
    // A path can't be both a file and a folder. If a folder already uses this
    // name (some file lives under `${path}/`), say so clearly instead of letting
    // the backend reject the write with an opaque error.
    if (filesRef.current.some((p) => p.startsWith(`${path}/`))) {
      await modal.alert(`A folder named “${clean.split('/').pop()}” already exists here — a file and a folder can’t share a name.`, { title: 'Name taken' })
      return
    }
    // Reject when an INTERMEDIATE segment is itself an existing FILE: with a file
    // at "files/css", creating "css/site.css" would write it BEHIND the file
    // node (orphaned). Walk every ancestor prefix (excluding the leaf, already
    // checked above) and refuse if it's an exact file entry.
    const segs = path.split('/')
    const fileSet = new Set(filesRef.current)
    for (let i = 2; i < segs.length; i++) {
      const ancestor = segs.slice(0, i).join('/')
      if (fileSet.has(ancestor)) {
        await modal.alert(`A file named “${segs[i - 1]}” already exists here — a file and a folder can’t share a name.`, { title: 'Name taken' })
        return
      }
    }
    try {
      await storage.setText(path, '')
      // Merge into the SERVER's current index, not the in-memory snapshot: a
      // concurrent create/delete (another device, or this app's own rapid
      // second mutation before filesRef syncs) could otherwise be clobbered by
      // a whole-array PUT derived from a stale list.
      const fresh = await storage.getFresh('files-index.json')
      const base = Array.isArray(fresh) ? fresh : filesRef.current
      const next = [...new Set([...base, path])].sort()
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      setFileCache((prev) => ({ ...prev, [path]: '' }))
      setSelectedPath(path)
      closeNav()
      refreshPending()
    } catch (e) {
      await modal.alert(e.message || String(e), { title: 'Could not create file' })
    }
  }, [storage, modal, closeNav, refreshPending, ensureIndexWritable])

  const handleCreateFolder = useCallback(async () => {
    if (!(await ensureIndexWritable())) return
    const name = await modal.prompt(
      'Folder name — e.g. css or img/icons',
      { title: 'New folder', placeholder: 'css' },
    )
    if (!name) return
    const clean = name.replace(/^\/+/, '').replace(/\/+$/, '').trim()
    if (!isSafeRelPath(clean)) {
      await modal.alert('Use letters, digits, . - _ / only.', { title: 'Invalid name' })
      return
    }
    const dir = `files/${clean}`
    // A path can't be both a file and a folder. Mirror handleCreateFile's guard:
    // if a file already uses this name, refuse instead of letting the backend
    // reject the .keep write with an opaque error.
    if (filesRef.current.includes(dir)) {
      await modal.alert(`A file named “${clean.split('/').pop()}” already exists here — a file and a folder can’t share a name.`, { title: 'Name taken' })
      return
    }
    // If the folder already exists (its .keep, or any file under it), say so.
    if (filesRef.current.some((p) => p === `${dir}/.keep` || p.startsWith(`${dir}/`))) {
      await modal.alert(`A folder named “${clean.split('/').pop()}” already exists here.`, { title: 'Name taken' })
      return
    }
    // Reject when an INTERMEDIATE segment is itself an existing FILE: with a file
    // at "files/css", creating folder "css/icons" would write "files/css/icons/
    // .keep" BEHIND the file node (orphaned). Walk every ancestor prefix
    // (excluding `dir` itself, already checked) and refuse if it's a file entry.
    const dirSegs = dir.split('/')
    const dirFileSet = new Set(filesRef.current)
    for (let i = 2; i < dirSegs.length; i++) {
      const ancestor = dirSegs.slice(0, i).join('/')
      if (dirFileSet.has(ancestor)) {
        await modal.alert(`A file named “${dirSegs[i - 1]}” already exists here — a file and a folder can’t share a name.`, { title: 'Name taken' })
        return
      }
    }
    const path = `${dir}/.keep`
    try {
      await storage.setText(path, '')
      // Merge into the server's current index, not the stale in-memory list.
      const fresh = await storage.getFresh('files-index.json')
      const base = Array.isArray(fresh) ? fresh : filesRef.current
      const next = [...new Set([...base, path])].sort()
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      refreshPending()
    } catch (e) {
      await modal.alert(e.message || String(e), { title: 'Could not create folder' })
    }
  }, [storage, modal, refreshPending, ensureIndexWritable])

  const handleDeleteFile = useCallback(async (path) => {
    if (!(await ensureIndexWritable())) return
    if (!isSafeStoragePath(path)) {
      await modal.alert('That file path is not valid.', { title: 'Invalid path' })
      return
    }
    const ok = await modal.confirm(
      `Delete “${path}”? This cannot be undone.`,
      { title: 'Delete file', danger: true },
    )
    if (!ok) return
    try {
      await storage.remove(path)
      // Remove from the server's current index, not the stale in-memory list, so
      // a concurrent mutation isn't clobbered by a whole-array PUT.
      const fresh = await storage.getFresh('files-index.json')
      const base = Array.isArray(fresh) ? fresh : filesRef.current
      const next = base.filter((p) => p !== path)
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      setFileCache((prev) => {
        if (!(path in prev)) return prev
        const ncache = { ...prev }
        delete ncache[path]
        return ncache
      })
      build.forgetDoc(path)
      if (selectedPath === path) {
        const nextReal = next.find((p) => !p.endsWith('/.keep'))
        setSelectedPath(nextReal || null)
      }
      refreshPending()
    } catch (e) {
      await modal.alert(e.message || String(e), { title: 'Could not delete' })
    }
  }, [selectedPath, storage, modal, refreshPending, ensureIndexWritable, build])

  // ---- Upload (files + whole folders) ------------------------------------
  const uploadFiles = useCallback(async (fileList, { asFolder } = {}) => {
    if (!(await ensureIndexWritable())) return
    const items = Array.from(fileList || [])
    if (items.length === 0) return
    const added = []
    const failed = []
    // An upload writes to files/<rel> directly; without a guard it silently
    // overwrites an existing same-named file (New file refuses a collision, so
    // Upload was the only blind clobber). Detect collisions up front and ask
    // once before overwriting; on decline, skip the colliding paths.
    const existing = new Set(filesRef.current)
    const collisions = items
      .map((f) => `files/${((asFolder && f.webkitRelativePath) || f.name || '').replace(/^\/+/, '').trim()}`)
      .filter((p) => existing.has(p))
    let overwrite = true
    if (collisions.length) {
      const sample = collisions.slice(0, 6).map((p) => p.replace(/^files\//, ''))
      overwrite = await modal.confirm(
        `${collisions.length} file(s) already exist and will be replaced: `
          + `${sample.join(', ')}${collisions.length > 6 ? '…' : ''}. Overwrite them?`,
        { title: 'Replace existing files?', danger: true },
      )
    }
    const collisionSet = new Set(collisions)
    for (const f of items) {
      const rel = ((asFolder && f.webkitRelativePath) || f.name || '')
        .replace(/^\/+/, '')
        .trim()
      if (!isSafeRelPath(rel)) {
        failed.push(f.name || rel || '(unnamed)')
        continue
      }
      const path = `files/${rel}`
      // Skip a colliding path when the user chose not to overwrite.
      if (!overwrite && collisionSet.has(path)) continue
      try {
        // Classify text vs binary by the SAME predicate the editor + preview
        // use (isBinaryProjectPath / BINARY_FILE_EXTS). A divergent regex here
        // stored .svg as text yet ImagePreview read it back via getBlob — a
        // wrong-kind read that left SVG uploads unrenderable.
        const isText = isTextProjectPath(path)
        if (isText) {
          const text = await f.text()
          await storage.setText(path, text)
          setFileCache((prev) => ({ ...prev, [path]: text }))
        } else {
          await storage.setBlob(path, f, { contentType: f.type || 'application/octet-stream' })
        }
        added.push(path)
      } catch (e) {
        failed.push(rel)
      }
    }
    if (added.length) {
      try {
        // Merge the uploaded paths into the server's current index, not the
        // stale in-memory list, so a concurrent mutation isn't clobbered.
        const fresh = await storage.getFresh('files-index.json')
        const base = Array.isArray(fresh) ? fresh : filesRef.current
        const next = [...new Set([...base, ...added])].sort()
        await storage.setJSON('files-index.json', next)
        setFiles(next)
      } catch (e) {
        await modal.alert(e.message || String(e), { title: 'Upload saved but index update failed' })
      }
      refreshPending()
    }
    if (failed.length) {
      await modal.alert(
        `Couldn't upload ${failed.length} item(s): ${failed.slice(0, 6).join(', ')}`
          + (failed.length > 6 ? '…' : ''),
        { title: 'Some uploads failed' },
      )
    }
  }, [storage, modal, refreshPending, ensureIndexWritable])

  // ---- Move / rename (drag-to-move + context-menu rename) ----------------
  const movePath = useCallback(async (from, to) => {
    if (from === to) return
    if (!(await ensureIndexWritable())) return
    if (!isSafeStoragePath(from) || !isSafeStoragePath(to)) {
      await modal.alert('Use letters, digits, . - _ / only.', { title: 'Invalid name' })
      return
    }
    if (to === from || to.startsWith(`${from}/`)) {
      await modal.alert('Cannot move an item into itself.', { title: 'Invalid move' })
      return
    }
    try {
      await storage.move(from, to)
      const rewrite = (p) => {
        if (p === from) return to
        if (p.startsWith(`${from}/`)) return to + p.slice(from.length)
        return p
      }
      // Apply the rename to the server's current index, not the stale in-memory
      // list, so a concurrent mutation isn't clobbered by a whole-array PUT.
      const fresh = await storage.getFresh('files-index.json')
      const base = Array.isArray(fresh) ? fresh : filesRef.current
      const next = [...new Set(base.map(rewrite))].sort()
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      setFileCache((prev) => {
        const out = {}
        for (const [p, v] of Object.entries(prev)) out[rewrite(p)] = v
        return out
      })
      setSelectedPath((cur) => (cur ? rewrite(cur) : cur))
      build.rewriteDocs(rewrite)
      if (mainPathRef.current) {
        const nextMain = rewrite(mainPathRef.current)
        if (nextMain !== mainPathRef.current) {
          setMainPath(nextMain)
          storage.setJSON('main.json', { path: nextMain }).catch(() => {})
        }
      }
      refreshPending()
    } catch (e) {
      if (e.status === 409) {
        await modal.alert('Something already exists at the destination.', { title: 'Move failed' })
      } else {
        await modal.alert(e.message || String(e), { title: 'Move failed' })
      }
    }
  }, [storage, modal, refreshPending, ensureIndexWritable, build])

  const handleRename = useCallback(async (path) => {
    const parts = path.split('/')
    const leaf = parts[parts.length - 1]
    const parent = parts.slice(0, -1).join('/')
    const nextLeaf = await modal.prompt(
      'New name',
      { title: 'Rename', placeholder: leaf, defaultValue: leaf },
    )
    if (!nextLeaf) return
    const clean = nextLeaf.replace(/^\/+/, '').replace(/\/+$/, '').trim()
    if (!clean || clean === leaf) return
    if (clean.includes('/')) {
      await modal.alert('A name can’t contain “/”. Drag the item to move it.', { title: 'Invalid name' })
      return
    }
    const to = parent ? `${parent}/${clean}` : clean
    await movePath(path, to)
  }, [modal, movePath])

  // ---- Folder delete (recursive) -----------------------------------------
  const handleDeleteFolder = useCallback(async (folderPath) => {
    if (!(await ensureIndexWritable())) return
    if (!isSafeStoragePath(folderPath)) {
      await modal.alert('That folder path is not valid.', { title: 'Invalid path' })
      return
    }
    const ok = await modal.confirm(
      `Delete the folder “${folderPath}” and everything inside it? This cannot be undone.`,
      { title: 'Delete folder', danger: true },
    )
    if (!ok) return
    try {
      await storage.removeFolder(folderPath)
      const under = (p) => p === folderPath || p.startsWith(`${folderPath}/`)
      // Remove from the server's current index, not the stale in-memory list, so
      // a concurrent mutation isn't clobbered by a whole-array PUT.
      const fresh = await storage.getFresh('files-index.json')
      const base = Array.isArray(fresh) ? fresh : filesRef.current
      const next = base.filter((p) => !under(p))
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      setFileCache((prev) => {
        const out = {}
        for (const [p, v] of Object.entries(prev)) if (!under(p)) out[p] = v
        return out
      })
      setSelectedPath((cur) => {
        if (cur && under(cur)) return next.find((p) => !p.endsWith('/.keep')) || null
        return cur
      })
      build.forgetUnder(folderPath)
      refreshPending()
    } catch (e) {
      await modal.alert(e.message || String(e), { title: 'Delete failed' })
    }
  }, [storage, modal, refreshPending, ensureIndexWritable, build])

  const selectedExt = selectedPath ? extensionFor(selectedPath) : ''
  const selectedIsBinary = selectedPath ? isBinaryProjectPath(selectedPath) : false
  const canEditSelected = !!selectedPath && !selectedIsBinary && !fileLoading && !fileError
  const selectedIsHtml = selectedPath ? isHtmlDoc(selectedPath) : false
  // Whether there is a buildable main page. The [Source | Preview] toggle and
  // the Build button track the MAIN page (the preview always renders it),
  // not the currently-open file.
  const hasMain = !!mainPath
  // The site entry built from the MAIN page this session, if any: a
  // { entry, ver } record (ver is the build token).
  const entryForMain = (mainPath && build.entryByDoc[mainPath]) || null
  const mainBuilding = build.buildStatus === 'building' && build.buildDoc === mainPath
  const mainBuildError = build.buildStatus === 'error' && build.buildDoc === mainPath

  // Reset the viewer to source whenever the user switches files.
  useEffect(() => {
    setViewMode('source')
  }, [selectedPath])

  // When the MAIN page's build finishes, flip the viewer to Preview.
  const onBuildDone = useCallback(async (doc) => {
    if (doc === mainPathRef.current) setViewMode('preview')
    // The built site lives under build/site/, NOT files/, so it is deliberately
    // NOT added to the file tree — the tree shows source, the Preview shows the
    // assembled output. (LaTeX added the .pdf to the tree; a website's build is
    // a whole directory mirror, so surfacing it as tree nodes would be noise.)
  }, [])

  const handleEditorChange = useCallback((value) => {
    setFileContent(value)
    setFileDirty(true)
    if (selectedPath) {
      setFileCache((prev) => ({ ...prev, [selectedPath]: value }))
    }
  }, [selectedPath])

  useEffect(() => {
    if (!selectedPath || selectedIsBinary || isManagedJsonPath(selectedPath) || !fileDirty) return undefined
    const path = selectedPath
    const body = fileContent
    const timer = setTimeout(() => {
      if (selectedPathRef.current !== path) return
      setFileSaving(true)
      // Publish the in-flight write so flushDirtyEdits can await it before a
      // project switch/create resets the buffer — otherwise keystrokes typed
      // during this 700ms-debounced write are lost (the flush would resolve
      // against a stale snapshot).
      const p = storage.setText(path, body).then(() => {
        if (selectedPathRef.current !== path) return
        setFileCache((prev) => ({ ...prev, [path]: body }))
        if (fileContentRef.current === body) setFileDirty(false)
        refreshPending()
      }).catch((e) => {
        if (selectedPathRef.current === path) {
          setFileError(e.message || 'Could not save file.')
        }
      }).finally(() => {
        if (selectedPathRef.current === path) setFileSaving(false)
        if (savePromiseRef.current === p) savePromiseRef.current = null
      })
      savePromiseRef.current = p
    }, SOURCE_AUTOSAVE_MS)
    return () => clearTimeout(timer)
  }, [
    selectedPath,
    selectedIsBinary,
    fileDirty,
    fileContent,
    storage,
    refreshPending,
  ])

  const handleSaveFile = useCallback(async () => {
    if (!selectedPath || selectedIsBinary || isManagedJsonPath(selectedPath) || fileSaving) {
      return savePromiseRef.current
    }
    setFileSaving(true)
    setFileError(null)
    const p = (async () => {
      try {
        await storage.setText(selectedPath, fileContent)
        setFileDirty(false)
        setFileCache((prev) => ({ ...prev, [selectedPath]: fileContent }))
        refreshPending()
      } catch (e) {
        setFileError(e.message || 'Could not save file.')
      } finally {
        setFileSaving(false)
        savePromiseRef.current = null
      }
    })()
    savePromiseRef.current = p
    return p
  }, [selectedPath, selectedIsBinary, fileSaving, storage, fileContent, refreshPending])

  // Persist the editor's LATEST text before a reset (project switch/create)
  // throws away the dirty buffer. A debounced autosave may have a write in
  // flight; BOTH it and handleSaveFile publish their write to savePromiseRef,
  // so we await that, THEN write fileContentRef.current DIRECTLY. We do not
  // route through handleSaveFile here: it no-ops while fileSaving and captures a
  // possibly-stale fileContent closure, whereas the in-flight autosave only
  // persisted its 700ms-old snapshot — anything typed since lives in
  // fileContentRef.current and must be saved before resetFileUi wipes it.
  const flushDirtyEdits = useCallback(async () => {
    if (!canEditSelected) return
    const path = selectedPathRef.current
    if (!path || selectedIsBinary || isManagedJsonPath(path)) return
    if (savePromiseRef.current) { try { await savePromiseRef.current } catch { /* error surfaced by the in-flight write */ } }
    if (fileDirtyRef.current) {
      await storage.setText(path, fileContentRef.current)
      setFileCache((prev) => ({ ...prev, [path]: fileContentRef.current }))
      setFileDirty(false)
    }
  }, [canEditSelected, selectedIsBinary, storage])

  const resetFileUi = useCallback(() => {
    clearBuildPoll()
    filesRef.current = []
    selectedPathRef.current = null
    mainResolvedRef.current = false
    seenBuildStatusRef.current = ''
    mainPathRef.current = null
    fileContentRef.current = ''
    fileDirtyRef.current = false
    fileSavingRef.current = false
    setFiles([])
    setFileCache({})
    setIndexLoaded(false)
    setSelectedPath(null)
    setFileContent('')
    setFileLoading(false)
    setFileError(null)
    setFileDirty(false)
    setFileSaving(false)
    setMainPath(null)
    setMainReady(false)
    setViewMode('source')
    setPublishedUrl(null)
    try { navHandleRef.current?.close?.() } catch {}
    navHandleRef.current = null
    setNavOpen(false)
  }, [clearBuildPoll])

  const switchProject = useCallback(async (id) => {
    if (publishingRef.current) return
    if (!isSafeProjectId(id) || id === activeProjectId) return
    // Flush dirty edits (awaiting any in-flight autosave) before resetFileUi
    // discards the buffer — otherwise keystrokes typed during an in-flight
    // autosave are lost.
    await flushDirtyEdits()
    resetFileUi()
    writeActiveProject(appId, id)
    setActiveProjectId(id)
  }, [activeProjectId, appId, flushDirtyEdits, resetFileUi])

  const startRenameProject = useCallback((id) => setRenamingId(id), [])
  const cancelRenameProject = useCallback(() => setRenamingId(null), [])

  const commitRenameProject = useCallback(async (targetId, rawName) => {
    const clean = String(rawName || '').trim()
    try {
      const fresh = await readFreshProjects()
      const current = fresh.find((p) => p.id === targetId)
      if (!current || !clean || clean === current.name) return
      const next = fresh.map((p) => (p.id === targetId ? { ...p, name: clean } : p))
      await rootStorage.setJSON('projects.json', next)
      setProjects(next)
    } catch (e) {
      await modal.alert(e.message || String(e), { title: 'Could not rename project' })
    } finally {
      setRenamingId(null)
    }
  }, [modal, readFreshProjects, rootStorage])

  const createAndRenameProject = useCallback(async () => {
    if (!projectsLoaded) {
      await modal.alert('Projects are still loading.', { title: 'Projects' })
      return
    }
    if (publishingRef.current) {
      await modal.alert('Finish publishing before creating a project.', { title: 'Publishing' })
      return
    }
    const name = `Project ${projects.length + 1}`
    try {
      const fresh = await readFreshProjects()
      const id = projectSlug(name, new Set(fresh.map((p) => p.id)))
      const next = [...fresh, { id, name, createdAt: Date.now() }]
      await rootStorage.setJSON('projects.json', next)
      setProjects(next)
      await switchProject(id)
      // switchProject early-returns (without making `id` active) if the user
      // tapped Publish during the await window. Only open the inline rename if
      // the switch actually took effect — otherwise we'd open a rename on a
      // non-active project. The project still exists and is recoverable.
      if (!publishingRef.current) {
        setRenamingId(id)
        openNavRef.current?.()
      }
    } catch (e) {
      await modal.alert(e.message || String(e), { title: 'Could not create project' })
    }
  }, [modal, projects.length, projectsLoaded, readFreshProjects, rootStorage, switchProject])

  const handleDeleteProject = useCallback(async (targetId) => {
    if (!projectsLoaded) {
      await modal.alert('Projects are still loading.', { title: 'Projects' })
      return
    }
    try {
      const fresh = await readFreshProjects()
      const target = fresh.find((p) => p.id === targetId)
      if (!target) {
        await modal.alert('That project no longer exists.', { title: 'Cannot delete project' })
        return
      }
      if (targetId === 'default' || fresh.length <= 1) {
        await modal.alert('The default project and the last remaining project cannot be deleted.', { title: 'Cannot delete project' })
        return
      }
      const ok = await modal.confirm(
        `Delete “${target.name}” and all of its files, builds, and chat history? This cannot be undone.`,
        { title: 'Delete Project', danger: true },
      )
      if (!ok) return
      const latest = await readFreshProjects()
      const current = latest.find((p) => p.id === targetId)
      if (!current) {
        await modal.alert('That project no longer exists.', { title: 'Cannot delete project' })
        return
      }
      if (targetId === 'default' || latest.length <= 1) {
        await modal.alert('The default project and the last remaining project cannot be deleted.', { title: 'Cannot delete project' })
        return
      }
      const fallback = latest.find((p) => p.id !== targetId)?.id || 'default'
      const next = latest.filter((p) => p.id !== targetId)
      try {
        await fetch(`/api/apps/${appId}/publish?project_id=${encodeURIComponent(targetId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        })
      } catch {
        // Best-effort cleanup only.
      }
      await deleteStorageTree(rootStorage, projectPrefix(targetId))
      await rootStorage.setJSON('projects.json', next)
      setProjects(next)
      removeFileCache(appId, targetId)
      if (targetId === activeProjectId) {
        resetFileUi()
        writeActiveProject(appId, fallback)
        setActiveProjectId(fallback)
      }
    } catch (e) {
      await modal.alert(e.message || String(e), { title: 'Could not delete project' })
    }
  }, [
    activeProjectId,
    appId,
    modal,
    projectsLoaded,
    readFreshProjects,
    resetFileUi,
    rootStorage,
    token,
  ])

  const showPublishedModal = useCallback(async (fullUrl) => {
    await modal.alert(
      <div>
        <div className="ws-publish-url">{fullUrl}</div>
        <div className="ws-publish-actions">
          <button
            type="button"
            className="ws-modal-btn ws-modal-btn--secondary"
            onClick={() => navigator.clipboard?.writeText(fullUrl).catch(() => {})}
          >
            Copy
          </button>
          <a className="ws-modal-btn ws-modal-btn--primary ws-publish-link" href={fullUrl} target="_blank" rel="noopener noreferrer">
            Open
          </a>
        </div>
      </div>,
      { title: 'Published' },
    )
  }, [modal])

  const handlePublish = useCallback(async () => {
    if (publishingRef.current) return
    const builtEntry = mainPath ? build.entryByDoc[mainPath]?.entry : null
    if (build.buildStatus !== 'done' || !builtEntry) {
      await modal.alert('No built site found — please Build first', { title: 'Publish failed' })
      return
    }
    publishingRef.current = true
    setPublishing(true)
    try {
      const r = await fetch(`/api/apps/${appId}/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: activeProjectId === 'default' ? null : activeProjectId }),
      })
      if (r.ok) {
        const data = await r.json()
        const fullUrl = new URL(data.url, window.location.origin).href
        setPublishedUrl(fullUrl)
        publishEpochRef.current += 1
        try { await storage.setText('publish-url.txt', fullUrl) } catch { /* best-effort persist */ }
        // No blocking modal — opening one rides the shell nav stack and closes
        // the drawer. The drawer's publish row now shows the URL + Copy/Open/
        // Unpublish inline, so the drawer stays open with the result visible.
        return
      }
      if (r.status === 400) {
        await modal.alert('No built site found — please Build first', { title: 'Publish failed' })
        return
      }
      let detail = ''
      try {
        const data = await r.json()
        detail = data.detail || data.error || ''
      } catch { /* non-JSON */ }
      await modal.alert(detail || `Publish failed (${r.status}).`, { title: 'Publish failed' })
    } catch (e) {
      await modal.alert(e.message || String(e), { title: 'Publish failed' })
    } finally {
      publishingRef.current = false
      setPublishing(false)
    }
  }, [activeProjectId, appId, build.buildStatus, build.entryByDoc, mainPath, modal, storage, token])

  const handleUnpublish = useCallback(async () => {
    if (publishingRef.current) return
    publishingRef.current = true
    setPublishing(true)
    try {
      const projectParam = activeProjectId === 'default' ? '' : activeProjectId
      const r = await fetch(`/api/apps/${appId}/publish?project_id=${encodeURIComponent(projectParam)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (r.ok) {
        setPublishedUrl(null)
        publishEpochRef.current += 1
        try { await storage.remove('publish-url.txt') } catch { /* best-effort clear */ }
        return
      }
      let detail = ''
      try {
        const data = await r.json()
        detail = data.detail || data.error || ''
      } catch { /* non-JSON */ }
      await modal.alert(detail || `Unpublish failed (${r.status}).`, { title: 'Unpublish failed' })
    } catch (e) {
      await modal.alert(e.message || String(e), { title: 'Unpublish failed' })
    } finally {
      publishingRef.current = false
      setPublishing(false)
    }
  }, [activeProjectId, appId, modal, storage, token])

  const handleBuild = useCallback(() => {
    // Build always assembles the site for the MAIN page (the preview renders
    // it). useBuild writes build/target.txt = mainPath so build.sh knows which
    // page is the entry.
    if (!mainPath || build.buildStatus === 'building') return
    // Save the currently-open file's unsaved edits first so the build picks up
    // on-screen changes.
    const kick = () => build.build(mainPath, onBuildDone)
    if (fileDirty && !fileSaving && canEditSelected) {
      handleSaveFile().then(kick, kick)
    } else {
      kick()
    }
  }, [mainPath, fileDirty, fileSaving, canEditSelected, build, onBuildDone, handleSaveFile])

  // The Preview view: the MAIN page's built site (with running / failed states).
  function renderPreviewView() {
    if (!mainPath) {
      return (
        <div className="ws-preview-note">
          No main page set yet. Open the file drawer, tap an .html file’s ⋯
          menu, and choose “Set as main page”, then Build.
        </div>
      )
    }
    if (mainBuilding) {
      return (
        <div className="ws-preview-note ws-build-note">
          Building <b>{mainPath.replace(/^files\//, '')}</b>…
        </div>
      )
    }
    if (mainBuildError) {
      return (
        <div className="ws-build-error">
          <div className="ws-build-error-title">Build failed</div>
          <pre className="ws-build-log">{build.buildLog}</pre>
        </div>
      )
    }
    if (entryForMain) {
      return <HtmlPreview storage={storage} entryPath={entryForMain.entry} version={entryForMain.ver} />
    }
    return (
      <div className="ws-preview-note ws-build-note">
        No preview yet. Tap <b>Build</b> to assemble + render <b>{mainPath.replace(/^files\//, '')}</b>.
      </div>
    )
  }

  // The main content area — source editor OR a viewer, toggled.
  function renderMain() {
    if (!selectedPath) {
      return (
        <div className="ws-preview-empty">
          <div className="ws-preview-empty-title">Web Studio</div>
          <div className="ws-preview-empty-body">
            Open the file drawer to pick a file.
          </div>
        </div>
      )
    }
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(selectedExt)) {
      return <ImagePreview storage={storage} path={selectedPath} />
    }
    // Preview mode shows the MAIN page's built site, so it is only rendered
    // when the OPEN file IS the main page — matching showHtmlControls, so the
    // preview never paints a different page than the one on screen.
    if (selectedPath === mainPath && viewMode === 'preview') {
      return renderPreviewView()
    }
    if (fileLoading) return <div className="ws-preview-note">Loading source…</div>
    if (fileError) return <div className="ws-preview-note">{fileError}</div>
    // Managed .json files are shown read-only.
    if (isManagedJsonPath(selectedPath)) {
      return (
        <div className="ws-editor-readonly">
          <div className="ws-readonly-note">
            Managed file — edit via the app, not the source.
          </div>
          <CodeEditor
            value={fileContent}
            markdown={false}
            readOnly
            docKey={selectedPath}
            onChange={handleEditorChange}
          />
        </div>
      )
    }
    return (
      <CodeEditor
        value={fileContent}
        markdown={false}
        readOnly={false}
        docKey={selectedPath}
        onChange={handleEditorChange}
      />
    )
  }

  // The Preview view + Build always operate on the MAIN page. We therefore
  // only offer the [Source | Preview] toggle and Build when the OPEN file IS
  // the main page — otherwise "Show preview" on a non-main .html would render
  // a DIFFERENT page than the one on screen (the misleading affordance the
  // reviewer flagged). For a non-main .html the user picks "Set as main page"
  // from the drawer first. (selectedPath === mainPath implies html + hasMain,
  // since mainPath is only ever set to an isHtmlDoc path.)
  const showHtmlControls = !!mainPath && selectedPath === mainPath
  const openName = selectedPath ? selectedPath.replace(/^files\//, '') : null

  const quickActions = useMemo(() => {
    const actions = []
    if (build.buildStatus === 'error') {
      actions.push({ label: 'Fix the build', prompt: 'Fix the build errors.' })
    }
    actions.push({ label: 'Improve the design', prompt: 'Improve the visual design of the site.' })
    actions.push({ label: 'Add a page', prompt: 'Add a new page to the site.' })
    return actions
  }, [build.buildStatus])

  const getContext = useCallback(() => {
    return Promise.resolve({
      openFile: selectedPath || null,
      viewMode: viewMode || null,
      buildStatus: build.buildStatus || null,
      mainFile: mainPath || null,
      projectId: activeProjectId,
    })
  }, [selectedPath, viewMode, build.buildStatus, mainPath, activeProjectId])

  return (
    <div className="ws-root">
      <style>{CSS}</style>
      {/* Two-zone top bar: left = drawer toggle + project/open filename,
          right = Build + [Source/Preview toggle]. The grid is 1fr | auto so the left zone
          flexes/truncates and the right zone sizes to its controls.
          Identical structure in app-latex (unprefixed classes). */}
      <header className="ws-top-bar">
        <div className="ws-top-zone ws-top-zone--left">
          {/* The app's own glossy icon is the drawer toggle, mirroring the
              Möbius shell header where the logo (not a hamburger) opens the
              drawer. The real icon image — the backend serves a downscaled
              copy at ?size=128 (cached 1h), kept crisp at the 34px render
              without the old full-res PNG cost; the accent-dot fallback shows
              when an install has no custom icon (the route 404s). */}
          <button
            ref={navToggleRef}
            className="ws-nav-toggle"
            onClick={toggleNav}
            aria-label={navOpen ? 'Close file drawer' : 'Open file drawer'}
            aria-expanded={navOpen}
          >
            <img
              src={`/api/apps/${appId}/icon?size=128`}
              alt=""
              width={34}
              height={34}
              className="ws-brand-icon"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
                const f = e.currentTarget.nextElementSibling
                if (f) f.style.display = 'flex'
              }}
            />
            <span className="ws-brand-fallback" style={{ display: 'none' }} aria-hidden="true" />
          </button>
          <div className="ws-top-title">
            {openName
              ? <span className="ws-top-path" title={selectedPath}>{openName}</span>
              : <span className="ws-top-path ws-top-path--muted">No file open</span>}
          </div>
        </div>
        <div className="ws-top-zone ws-top-zone--right">
          {showHtmlControls && (
            <>
              <button
                className="ws-toolbar-btn ws-toolbar-btn--primary"
                onClick={handleBuild}
                disabled={build.buildStatus === 'building'}
                aria-label={build.buildStatus === 'building' ? 'Building…' : 'Build'}
                title={build.buildStatus === 'building'
                  ? 'Building…'
                  : `Build ${mainPath.replace(/^files\//, '')}`}
              >
                {build.buildStatus === 'building'
                  ? <BuildingIndicator size={20} />
                  : <PlayIcon size={20} />}
              </button>
              {/* Icon-only [Source | Preview] toggle. role=group + aria-pressed exposes
                  the active segment to assistive tech; title + aria-label name the action. */}
              <div className="ws-seg-toggle" role="group" aria-label="View">
                <button
                  type="button"
                  className={`ws-seg-btn ${viewMode !== 'preview' ? 'ws-seg-btn--active' : ''}`}
                  aria-pressed={viewMode !== 'preview'}
                  aria-label="Source"
                  title="Source"
                  onClick={() => setViewMode('source')}
                >
                  <CodeIcon size={20} />
                </button>
                <button
                  type="button"
                  className={`ws-seg-btn ${viewMode === 'preview' ? 'ws-seg-btn--active' : ''}`}
                  aria-pressed={viewMode === 'preview'}
                  aria-label="Preview"
                  title="Preview"
                  onClick={() => setViewMode('preview')}
                >
                  <EyeIcon size={20} />
                </button>
              </div>
            </>
          )}
          {/* Chat toggle — the embedded agent chat is core, always available
              (not project-specific, so it stays in the bar, not the drawer). */}
          <button
            type="button"
            className="ws-toolbar-btn ws-chat-toggle-btn"
            aria-label={chatOpen ? 'Close chat' : 'Open chat'}
            aria-pressed={chatOpen}
            title={chatOpen ? 'Close chat' : 'Open chat'}
            onClick={toggleChat}
          >
            <ChatBubbleIcon size={20} />
          </button>
        </div>
      </header>

      <div
        ref={bodyRef}
        className={chatOpen ? 'ws-body ws-body--chat-open' : 'ws-body'}
        style={chatOpen ? { '--ws-chat-ratio': chatRatio } : undefined}
      >
        <FileNavPanel
          appId={appId}
          open={navOpen}
          onClose={closeNav}
          files={files}
          selectedPath={selectedPath}
          onSelect={setSelectedPath}
          canMutate={indexLoaded}
          onCreateFile={handleCreateFile}
          onCreateFolder={handleCreateFolder}
          onDeleteFile={handleDeleteFile}
          onDeleteFolder={handleDeleteFolder}
          onUpload={uploadFiles}
          onMove={movePath}
          onRename={handleRename}
          mainPath={mainPath}
          onSetMain={handleSetMain}
          returnFocusRef={navToggleRef}
          projects={projects}
          projectsLoaded={projectsLoaded}
          activeProjectId={activeProjectId}
          onSwitchProject={switchProject}
          onNewProject={createAndRenameProject}
          onRenameProject={startRenameProject}
          onDeleteProject={handleDeleteProject}
          renamingId={renamingId}
          onCommitProjectRename={commitRenameProject}
          onCancelProjectRename={cancelRenameProject}
          publishedUrl={publishedUrl}
          publishing={publishing}
          buildStatus={build.buildStatus}
          canPublish={build.buildStatus === 'done' && !!(mainPath && build.entryByDoc[mainPath]?.entry)}
          onPublish={handlePublish}
          onUnpublish={handleUnpublish}
        />
        {/* ws-content (its sandboxed preview iframe + CodeMirror) MUST render
            unconditionally at this stable position — never inside a conditional
            or ternary branch. Remounting it reloads the sandboxed iframe (black
            flash) and resets the editor (lost scroll/undo/cursor). The chat
            divider + panel are conditional SIBLINGS *after* it; never wrap this. */}
        <main className="ws-content">{renderMain()}</main>
        {chatOpen && (
          <>
            <div
              className="ws-chat-divider"
              role="separator"
              aria-label="Resize chat and editor areas"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(chatRatio * 100)}
              tabIndex={0}
              onPointerDown={beginChatResize}
              onKeyDown={handleResizeKey}
            >
              <span className="ws-chat-divider-bar" aria-hidden="true" />
            </div>
            <ChatPanel
              key={activeProjectId}
              appId={appId}
              token={token}
              storage={storage}
              projectId={activeProjectId}
              persistKey={`${activePrefix}chat_id.json`}
              onFilesMaybeChanged={onFilesMaybeChanged}
              quickActions={quickActions}
              getContext={getContext}
            />
          </>
        )}
      </div>
      {modal.node}
    </div>
  )
}

// ----------------------------------------------------------------------
// Styles. Inline so the app is single-file (per spec) and the CSS vars
// resolve against whatever theme the Möbius shell is painting. All colors
// come from theme tokens; no hard-coded brand colors. Shape copied from
// app-latex with a `ws-` prefix (keep in sync where divergence isn't needed).
// ----------------------------------------------------------------------
const CSS = `
/* mobius-ui:Root v1 — keep in sync; library candidate. Diverge below the marker only. */
.ws-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  /* Overlay scrims + shadows as local tokens so the raw rgba(0,0,0,…) values
     live in one place (and read against the dark theme rather than being
     scattered literals). */
  --ws-scrim: rgba(0, 0, 0, 0.45);
  --ws-scrim-soft: rgba(0, 0, 0, 0.35);
  --ws-shadow: rgba(0, 0, 0, 0.3);
  background: var(--bg, #111614);
  color: var(--text, #eef7f1);
  font-family: var(--font, Inter, ui-sans-serif, system-ui, sans-serif);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
  overscroll-behavior: contain;
}
/* /mobius-ui:Root */

/* mobius-ui:Focus v1 -- shared keyboard focus ring (WCAG 2.4.7); never bare outline:none */
:where(button,a,input,textarea,select,summary,[role="button"],[tabindex]:not([tabindex="-1"])):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* /mobius-ui:Focus */

/* mobius-ui:Toolbar v1 — keep in sync with app-latex (unprefixed) */
/* Two-zone bar: minmax(0,1fr) | auto lets the left zone (drawer toggle +
   filename) flex + truncate while the right zone sizes to its action cluster
   ([Build][view toggle]). */
.ws-top-bar {
  position: relative;
  z-index: 11;
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  /* Top-pinned bar: clear the iPhone notch / Dynamic Island and pad the sides
     past the rounded-corner / gesture insets on a full-screen PWA. */
  padding: max(6px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) 6px max(10px, env(safe-area-inset-left));
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  user-select: none;
}
.ws-top-zone {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.ws-top-zone--left { justify-content: flex-start; }
.ws-top-zone--right { justify-content: flex-end; }
.ws-nav-toggle {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  min-height: 44px;
  padding: 0;
  border-radius: 8px;
  /* Bare like the shell's .shell__brand logo-toggle: no border, no
     background box, no focus ring. The always-visible bounding box that
     used to sit here (border + background) was the owner-reported
     highlight that lingered after closing the drawer. */
  border: none;
  background: none;
  color: var(--text);
  font-size: 16px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  -webkit-user-select: none;
  user-select: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
/* Suppress only the UA mouse-focus outline (the owner-reported lingering box
   after closing the drawer); keyboard focus still gets the shared :focus-visible
   ring so a tabbing user sees where they are. */
.ws-nav-toggle:focus:not(:focus-visible) { outline: none; }
.ws-nav-toggle:active { opacity: 0.7; }
/* Drawer-toggle box-highlight (feature 142): neutral wash on hover/focus,
   accent wash while the file drawer is open, on the rounded 8px button. */
@media (hover: hover) {
  .ws-nav-toggle:hover { background: var(--surface2, var(--bg-alt, var(--surface))); }
}
.ws-nav-toggle:focus-visible { background: var(--surface2, var(--bg-alt, var(--surface))); }
/* The real app icon as the brand mark inside the drawer toggle. Sized to the
   34px Möbius brand mark so every mini-app header icon matches the shell. */
.ws-brand-icon {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  object-fit: cover;
  flex-shrink: 0;
  display: block;
}
/* Accent-dot fallback shown when the install has no custom icon (route 404s). */
.ws-brand-fallback {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent, var(--text));
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.ws-top-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ws-project-label {
  flex: 0 1 auto;
  max-width: 140px;
  color: var(--text);
  font: 650 12px/1.2 var(--font);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ws-top-path {
  font-family: var(--font);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ws-top-path--muted { color: var(--muted); font-weight: 400; }
/* Icon-only toolbar buttons: square 44x44 tap targets (same recipe as
   app-latex's .toolbar-btn). */
.ws-toolbar-btn {
  width: 44px;
  height: 44px;
  min-height: 44px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ws-toolbar-btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-fg);
}
.ws-toolbar-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.ws-toolbar-btn:active { background: var(--surface2, var(--surface)); }
.ws-toolbar-btn--primary:active { background: color-mix(in srgb, var(--accent) 80%, #000); }
@media (hover: hover) {
  .ws-toolbar-btn:hover:not(:disabled) { background: var(--surface2, var(--surface)); }
  .ws-toolbar-btn--primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 85%, #000); }
}
.ws-chat-toggle-btn[aria-pressed="true"] {
  background: color-mix(in srgb, var(--accent) 18%, var(--surface));
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}
/* Build-button spinner (BuildingIndicator) — same recipe as app-latex. */
@keyframes ws-building-spin { to { transform: rotate(360deg); } }
.ws-building-spin {
  animation: ws-building-spin 1.1s linear infinite;
  transform-origin: center;
}

/* ---- source/preview view toggle: ONE segmented pill (same recipe as
   app-latex's .seg-toggle). The WRAPPER carries the border + rounded
   outline + inset track; the two segments are borderless and the active
   one fills with a neutral raised surface (like an iOS segmented control),
   reserving the accent tint for the Build button. ---- */
.ws-seg-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg);
}
.ws-seg-btn {
  width: 44px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* Borderless segments inside the pill wrapper; the wrapper owns the
     outer border. Slightly tighter radius than the wrapper so the active
     fill nests cleanly inside the 2px track. */
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ws-seg-btn--active {
  background: var(--surface2, var(--surface));
  color: var(--text);
}
.ws-seg-btn:active { background: var(--surface2, var(--surface)); }
@media (hover: hover) {
  .ws-seg-btn:hover:not(.ws-seg-btn--active) { background: var(--surface); color: var(--text); }
}
/* /mobius-ui:Toolbar */

/* ---- body: content area + bounded chat, stacked ----
   position: relative so the absolutely-positioned file drawer + its backdrop
   resolve against THIS box — i.e. they overlay only the area below the top
   bar, leaving the logo drawer toggle always tappable. */
.ws-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  overflow: hidden;
}
.ws-content {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}
/* ---- source editor ----
   The CodeMirror EditorView mounts inside .ws-cm-host. The host is a flex child
   that fills the content area and clips its own overflow; CodeMirror's internal
   .cm-scroller does the scrolling (cmThemePlain sets the monospace font + the
   2px accent caret), so the host itself needs no padding or font. */
.ws-cm-host {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  overflow: hidden;
  background: var(--bg);
}

/* Managed .json files render read-only with an inline notice above the
   source — editing them as text/plain would corrupt them for typed-JSON
   readers, so the editor never autosaves them. */
.ws-editor-readonly {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.ws-readonly-note {
  flex: 0 0 auto;
  padding: 8px 16px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--muted);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.ws-editor-readonly .ws-cm-host { cursor: default; }

/* ---- empty / notes ---- */
.ws-preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  color: var(--muted);
  gap: 8px;
  padding: 24px;
}
.ws-preview-empty-title { font-size: 26px; font-weight: 700; color: var(--text); letter-spacing: 0; }
.ws-preview-empty-body { font-size: 14px; line-height: 1.5; max-width: 320px; }

.ws-preview-note {
  color: var(--muted);
  font-size: 13px;
  padding: 24px 18px;
  text-align: center;
  line-height: 1.55;
}
.ws-preview-note b { color: var(--text); }
.ws-preview-retry {
  min-height: 44px;
  padding: 10px 22px;
  border-radius: 10px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--accent-fg);
  font-family: var(--font);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.ws-preview-retry:active { transform: scale(0.97); }
.ws-build-note { padding: 32px 18px; }

/* ---- build failure ---- */
.ws-build-error {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
}
.ws-build-error-title {
  font-weight: 700;
  color: var(--danger, var(--accent));
  font-size: 14px;
}
.ws-build-log {
  max-height: 60vh;
  overflow: auto;
  overscroll-behavior: contain;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---- image preview ---- */
.ws-img-preview {
  display: block;
  max-width: 100%;
  margin: 18px auto;
  border-radius: 6px;
}

/* ---- html preview (in-app browser) ----
   The built site renders inside a sandboxed iframe via srcdoc. The iframe
   itself keeps a white backdrop (most generated pages assume a light page),
   but the area BEHIND it stays the calm dark --surface2 so there is no hard
   white slab between builds; the iframe fades in over it (see below). */
.ws-preview {
  position: relative;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--surface2, var(--surface));
}
.ws-preview .ws-preview-note {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface2, var(--surface));
}
/* Gentle fade so the white page eases in over the dark chrome instead of
   popping on every Build/refresh (the reduced-motion guard neutralizes it). */
@keyframes ws-preview-in { from { opacity: 0; } to { opacity: 1; } }
.ws-preview-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
  animation: ws-preview-in 0.18s ease both;
}

/* mobius-ui:FileTree v1 — keep in sync; library candidate. Diverge below the marker only. */
/* ---- file drawer ---- */
.ws-drawer-scrim {
  position: absolute;
  inset: 0;
  background: var(--ws-scrim-soft);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
  z-index: 10;
}
.ws-drawer-scrim--open { opacity: 1; pointer-events: auto; }
.ws-file-drawer {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 78%;
  max-width: 320px;
  background: var(--surface);
  color: var(--text);
  border-right: 1px solid var(--border);
  transform: translateX(-100%);
  transition: transform 0.22s ease;
  z-index: 11;
  display: flex;
  flex-direction: column;
}
.ws-file-drawer--open { transform: translateX(0); }
/* While the finger drags, kill the transform-transition so the panel tracks
   the finger 1:1; removing the class lets the snap/close animate normally. */
.ws-file-drawer--dragging { transition: none; }
.ws-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 52px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  user-select: none;
}
.ws-drawer-head-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ws-drawer-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  line-height: 1.2;
}
.ws-project-picker {
  position: relative;
  flex: 0 1 auto;
  min-width: 0;
}
.ws-project-trigger {
  max-width: 170px;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font: 650 12px/1.2 var(--font);
  cursor: pointer;
}
.ws-project-trigger svg {
  flex: 0 0 auto;
  transform: rotate(90deg);
  color: var(--muted);
}
.ws-project-trigger-name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ws-project-trigger[aria-expanded="true"] {
  color: var(--accent);
  background: var(--accent-dim, color-mix(in srgb, var(--accent) 12%, transparent));
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}
.ws-project-trigger[aria-expanded="true"] svg {
  color: var(--accent);
}
.ws-project-rename-input {
  max-width: 170px;
  min-height: 36px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font: 650 12px/1.2 var(--font);
  outline: none;
}
.ws-project-rename-input:focus {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.ws-project-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 65;
  width: min(264px, 82vw);
  max-height: min(420px, 70vh);
  overflow: auto;
  padding: 5px;
  border: 1px solid var(--border-light, var(--border));
  border-radius: 12px;
  background: var(--bg);
  box-shadow: 0 8px 28px var(--ws-scrim-soft);
}
.ws-project-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ws-project-item,
.ws-project-action {
  width: 100%;
  min-height: 40px;
  padding: 7px 9px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--text);
  text-align: left;
  font: 550 13px/1.2 var(--font);
  cursor: pointer;
}
.ws-project-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-decoration: none;
}
.ws-project-item-name {
  display: block;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.3;
}
.ws-project-item--active {
  background: var(--accent-dim);
  color: var(--accent);
}
.ws-project-action--danger { color: var(--danger); }
.ws-project-action:disabled {
  opacity: 0.45;
  cursor: default;
}
.ws-project-item:active,
.ws-project-action:active:not(:disabled) {
  background: var(--surface2, var(--surface));
}
.ws-project-loading {
  min-height: 40px;
  display: flex;
  align-items: center;
  padding: 7px 9px;
  color: var(--muted);
  font-size: 13px;
}
.ws-drawer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2px;
  padding: 4px 6px 4px 12px;
  border-bottom: 1px solid var(--border);
}
.ws-files-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--muted);
}
.ws-files-actions { display: flex; gap: 2px; }
.ws-drawer-publish {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.ws-drawer-publish-actions {
  display: flex;
  gap: 6px;
}
.ws-drawer-publish-btn {
  flex: 1 1 0;
  min-width: 0;
  min-height: 40px;
  padding: 7px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font: 600 12px/1.2 var(--font);
  text-decoration: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ws-drawer-publish-btn--wide {
  width: 100%;
}
.ws-drawer-publish-btn:active:not(:disabled) {
  background: var(--surface2, var(--surface));
}
.ws-drawer-publish-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.ws-drawer-publish-link {
  justify-content: center;
}
.ws-drawer-publish-url {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--muted);
  font: 12px/1.45 var(--mono);
  overflow-wrap: anywhere;
}
.ws-drawer-btn {
  flex: 1 1 0;
  min-height: 44px;
  padding: 7px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ws-drawer-btn:active { background: var(--surface2, var(--surface)); }
.ws-drawer-btn:disabled { opacity: 0.45; cursor: default; }
.ws-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; padding: 0;
  border-radius: 7px; border: 1px solid transparent;
  background: transparent; color: var(--muted);
  cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation;
}
.ws-icon-btn:hover { background: var(--surface2, var(--surface)); color: var(--text); }
.ws-icon-btn:active:not(:disabled) { background: var(--surface3, var(--surface2)); transform: scale(0.94); }
.ws-icon-btn:disabled { opacity: 0.3; cursor: default; }
.ws-icon-btn--danger:hover { color: var(--danger, #f87171); }
.ws-project-row {
  display: flex; align-items: center; gap: 4px;
  padding: 7px 8px 7px 10px;
  border-bottom: 1px solid var(--border);
}
.ws-project-row .ws-project-picker { flex: 1 1 auto; min-width: 0; }
.ws-project-row .ws-project-trigger { width: 100%; max-width: none; justify-content: space-between; }
.ws-project-row .ws-project-rename-input { width: 100%; max-width: none; }
.ws-project-row-actions { display: flex; gap: 0; flex: 0 0 auto; }
.ws-drawer-syncing {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}
.ws-drawer-tree {
  flex: 1 1 auto;
  overflow-y: auto;
  /* Side gutter so the rounded rows float as pills inset from the panel
     edge, matching the Möbius shell drawer (.drawer__body's 8px side
     padding) rather than sitting full-bleed against the border. */
  padding: 8px 6px;
  overscroll-behavior: contain;
  user-select: none;
}
.ws-drawer-empty {
  padding: 16px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
}
/* Each tree row pairs the (flex-growing) file/folder button with a trailing
   ⋯ menu button. The row is the hover unit so the menu button reveals with the
   row on a pointer device; on touch it is always visible (see below). */
.ws-tree-row {
  display: flex;
  align-items: stretch;
  width: 100%;
  gap: 2px;
}
.ws-tree-file, .ws-tree-folder {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 44px;
  padding: 7px 12px;
  /* Rounded pill like the shell drawer's .drawer__item (10px) — the row
     floats inside the .ws-drawer-tree side gutter rather than full-bleed. */
  border-radius: 10px;
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
  font-family: var(--font);
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
/* Mouse-focus only: keyboard focus keeps the custom inset-accent ring below. */
.ws-tree-file:focus:not(:focus-visible),
.ws-tree-folder:focus:not(:focus-visible) { outline: none; }
/* Per-file ⋯ actions button. Faint until the row is hovered/focused so it does
   not compete with the filename; on touch (no hover) it stays visible so the
   actions are discoverable without a long-press. */
.ws-tree-menu-btn {
  flex: 0 0 auto;
  width: 40px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  /* Rounded hit area like the shell drawer's .drawer__more kebab (8px)
     so its hover/open/press washes read as a rounded chip, not square. */
  border-radius: 8px;
  background: none;
  color: var(--muted);
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.12s, color 0.12s, background 0.12s, transform 0.08s;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ws-tree-row:hover .ws-tree-menu-btn,
.ws-tree-menu-btn:focus-visible { opacity: 1; }
/* Hover is a NEUTRAL grey wash (same family as the press), not an accent
   tint — accent is reserved for the open state below. */
.ws-tree-menu-btn:hover {
  color: var(--text);
  background: var(--surface);
}
/* Pressed — NEUTRAL feedback. The press must not re-assert the open-state
   accent; it acknowledges the tap with a grey wash + scale (touch has no
   hover, and tap-highlight is suppressed), matching the shell kebab. */
.ws-tree-menu-btn:active {
  color: var(--text);
  background: var(--surface);
  transform: scale(0.92);
}
.ws-tree-menu-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* Open trigger — accent is reserved for the open menu only. While this row's
   action menu is open the kebab stays lit and accent-tinted (and fully
   opaque), the same treatment the shell drawer's kebab gets via
   data-state="open". Because background is in the transition, the wash fades
   in lockstep with the color instead of snapping (the #6 flash fix). */
.ws-tree-menu-btn[data-state="open"] {
  opacity: 1;
  color: var(--accent);
  background: var(--accent-dim, color-mix(in srgb, var(--accent) 12%, transparent));
}
@media (hover: none) {
  .ws-tree-menu-btn { opacity: 1; }
}
@media (hover: hover) {
  /* Hover is a NEUTRAL surface wash — same as the shell drawer's
     .drawer__item:hover (var(--surface)). Accent is reserved for the
     selected/active row, not for hover. */
  .ws-tree-file:hover, .ws-tree-folder:hover {
    background: var(--surface);
  }
}
/* Keyboard focus ring — matches the shell drawer's .drawer__item
   :focus-visible (2px accent outline, 2px offset). Replaces the old
   inset accent bar, which we dropped along with the square selection. */
.ws-tree-file:focus-visible, .ws-tree-folder:focus-visible {
  background: var(--surface);
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.ws-tree-file:active, .ws-tree-folder:active {
  background: var(--surface2, var(--bg));
}
/* Selected row: a rounded accent wash, matching the shell drawer's
   .drawer__item--active (var(--accent-dim) fill + accent text). No
   square fill and no left inset bar — the shell uses the wash alone. */
.ws-tree-file--selected {
  background: var(--accent-dim);
  color: var(--accent);
}
.ws-tree-file--selected .ws-tree-icon { color: var(--accent); }
/* Compact accent dot marking the main page row (no text chip). */
.ws-tree-main-dot {
  margin-left: auto;
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
/* Discoverable "set as main page" affordance: a muted accent dot on the right
   of every non-main HTML row, brightening on hover/focus. It's the visible
   twin of the context-menu's "Set as main page" item. A real <button> sibling
   of the row (next to the kebab), so it resets the UA button chrome the same
   way .ws-tree-menu-btn does. */
.ws-tree-set-main {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 7px;
  background: none;
  color: var(--muted);
  opacity: 0.55;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ws-tree-set-main:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.ws-tree-set-main-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--muted);
}
.ws-tree-set-main:hover,
.ws-tree-set-main:focus-visible {
  opacity: 1;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.ws-tree-set-main:hover .ws-tree-set-main-dot,
.ws-tree-set-main:focus-visible .ws-tree-set-main-dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.ws-tree-file[draggable="true"] { cursor: grab; }
/* Drop-target highlight while a drag hovers a folder or the root. */
.ws-tree-drop-active {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.ws-tree-root {
  min-height: 40px;
}
.ws-tree-group {
  display: block;
}
/* /mobius-ui:FileTree */

/* mobius-ui:ContextMenu v1 — keep in sync; library candidate. Diverge below the marker only. */
/* In-app context menu (right-click / long-press). position: fixed so its
   left/top (set from the pointer's viewport coords) land exactly under the
   finger regardless of which positioned ancestor it renders inside. */
.ws-ctx-menu {
  position: fixed;
  z-index: 60;
  min-width: 160px;
  padding: 4px;
  background: var(--bg);
  /* Match the shell drawer's .drawer__menu popover: softer outer radius
     (12px) over a hairline --border-light edge. */
  border: 1px solid var(--border-light);
  border-radius: 12px;
  box-shadow: 0 8px 28px var(--ws-scrim-soft);
  display: flex;
  flex-direction: column;
  gap: 2px;
  user-select: none;
}
.ws-ctx-item {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 8px 10px;
  text-align: left;
  border: none;
  /* Inner items match the shell drawer's .drawer__menu-item radius (8px)
     so a hovered item rhymes with the row's rounded selection. */
  border-radius: 8px;
  background: none;
  color: var(--text);
  font: 550 13px/1.2 var(--font);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ws-ctx-item:active { background: var(--surface2, var(--surface)); }
.ws-ctx-item--danger { color: var(--danger); }
/* /mobius-ui:ContextMenu */
/* Bare file/folder glyph — a lucide SVG with no bounding box, fill, or boxed
   padding (matches the shell's icons). It inherits the row's text color so it
   tints to --accent on the selected row exactly like the shell. */
.ws-tree-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  color: var(--muted);
  flex: 0 0 auto;
}
.ws-tree-icon svg { display: block; }
/* Folder chevron points right when collapsed, rotates down when expanded. */
.ws-tree-chevron {
  transition: transform 0.12s ease;
}
.ws-tree-chevron--open {
  transform: rotate(90deg);
}
.ws-tree-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/* mobius-ui:ChatEmbed v1 — keep in sync with app-latex (unprefixed) */
/* ---- chat panel (bottom half of the 50/50 split) ----
   The embedded shell chat runs inside an iframe (window.mobius.chat). The
   panel takes EXACTLY the height --ws-chat-ratio allots it (no internal
   min/max fighting the divider) and is a flex column; the embed fills it
   (flex:1 + min-height:0) and the iframe fills the embed, so the chat's
   composer is pinned to the bottom of the panel. */
.ws-chat-panel {
  flex: 0 0 auto;
  height: calc(var(--ws-chat-ratio, 0.5) * 100%);
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  overflow: hidden;
  overscroll-behavior: contain;
  /* Bottom-pinned sheet: lift the embedded chat composer above the iPhone
     home-indicator / Android gesture bar on a full-screen PWA. */
  padding-bottom: env(safe-area-inset-bottom);
}
/* The draggable divider ("glider") between content and chat: a SLIM 10px
   visual bar; the ::before overlay extends the pointer hit area to ~26px
   without adding visual weight. z-index keeps the overlay above the
   adjacent panes so the extra hit area actually receives the pointer. */
.ws-chat-divider {
  flex: 0 0 10px;
  height: 10px; /* explicit: keep in sync with app-latex (grid ignores flex-basis) */
  box-sizing: border-box;
  position: relative;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ns-resize;
  background: var(--surface);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  touch-action: none;
  user-select: none;
}
.ws-chat-divider::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -8px;
  bottom: -8px;
}
.ws-chat-divider:hover,
.ws-chat-divider:focus-visible {
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
}
.ws-chat-divider:focus-visible { outline-offset: -2px; }
.ws-chat-divider-bar {
  width: 44px;
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 65%, transparent);
  pointer-events: none;
}
.ws-chat-embed {
  flex: 1 1 auto;
  min-height: 0;          /* the flexbox overflow fix — lets the iframe scroll internally */
  overflow: hidden;
  background: var(--bg);
}
.ws-chat-embed iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
.ws-chat-error {
  flex: 0 0 auto;
  margin: 8px 14px 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--text);
  font-size: 12px;
}
/* /mobius-ui:ChatEmbed */

/* mobius-ui:Sheet v1 — keep in sync; library candidate. Diverge below the marker only. */
/* ---- modal ---- */
.ws-modal-scrim {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ws-scrim);
  z-index: 50;
  padding: 16px;
}
.ws-modal {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 32px var(--ws-shadow);
  width: 100%;
  max-width: 360px;
  padding: 18px 20px;
}
.ws-modal-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 8px;
}
.ws-modal-body {
  font-size: 14px;
  line-height: 1.5;
  color: var(--text);
  margin-bottom: 14px;
}
.ws-modal-input {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 9px 11px;
  font-size: 16px;
  font-family: var(--font);
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 14px;
  box-sizing: border-box;
}
/* Mouse/programmatic focus keeps just the accent border below; keyboard focus
   additionally gets the shared :focus-visible ring. */
.ws-modal-input:focus:not(:focus-visible) { outline: none; }
.ws-modal-input:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.ws-modal-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.ws-modal-option {
  min-height: 44px;
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font: 600 13px/1.2 var(--font);
  text-align: left;
  cursor: pointer;
}
.ws-modal-option:disabled {
  opacity: 0.45;
  cursor: default;
}
.ws-modal-option--danger { color: var(--danger); }
.ws-publish-url {
  padding: 10px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: 12px/1.45 var(--mono);
  overflow-wrap: anywhere;
}
.ws-publish-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.ws-publish-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
}
.ws-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.ws-modal-btn {
  min-height: 44px;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--font);
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ws-modal-btn:active { opacity: 0.8; }
.ws-modal-btn--primary {
  background: var(--accent);
  color: var(--accent-fg);
  border-color: var(--accent);
}
.ws-modal-btn--danger {
  background: var(--danger);
  color: var(--accent-fg);
  border-color: var(--danger);
}
.ws-modal-btn--secondary { background: var(--surface); }
/* /mobius-ui:Sheet */

/* mobius-ui:SyncPill v1 — keep in sync; library candidate. Diverge below the marker only. */
/* ---- sync pill ----
   Hidden in the steady state (online + 0 pending); only appears when there's
   something to say. Same shape as the latex + atlas apps so the platform
   feels coherent. */
.ws-sync-pill {
  position: absolute;
  /* Floating default (un-floated to static in the header below): keep the pill
     clear of the iPhone home-indicator / Android gesture bar. */
  right: max(12px, env(safe-area-inset-right));
  bottom: max(12px, env(safe-area-inset-bottom));
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  z-index: 40;
  box-shadow: 0 2px 8px var(--ws-shadow);
  pointer-events: auto;
}
.ws-sync-pill-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
}
.ws-sync-pill--pending .ws-sync-pill-dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
}
.ws-sync-pill--offline {
  border-color: var(--accent);
  color: var(--accent);
}
.ws-sync-pill--offline .ws-sync-pill-dot {
  background: var(--accent);
}

/* The SyncPill component defaults to a floating bottom-right pill. Here it
   lives inline in the header, so un-float it. */
.ws-top-zone--right .ws-sync-pill {
  position: static;
  right: auto;
  bottom: auto;
  z-index: auto;
  box-shadow: none;
  white-space: nowrap;
}
/* /mobius-ui:SyncPill */

/* mobius-ui:ReducedMotion v1 -- honor the OS reduce-motion setting */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
/* /mobius-ui:ReducedMotion */
`
