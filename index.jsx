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
// Layout (mobile-first):
//   - Top bar: ☰ (toggle the left file drawer) · the open file's name
//     (+ a "main" badge if it's the page Build renders) · a segmented
//     [Source | Preview] toggle and a primary Build button (both for the
//     HTML entry).
//   - Left drawer: slides in over a backdrop from the left edge — the
//     file tree + New file/folder/Upload + per-file context actions
//     (rename / delete / set-as-main). Tapping a file or the backdrop
//     closes it.
//   - Main area: the SOURCE editor (CodeMirror, plain-text mode) OR the built
//     site (a sandboxed iframe), toggled. Images render inline.
//   - Chat: a bottom panel with a bounded height so the embedded agent
//     conversation + composer stay fully visible and scrollable. The
//     user describes the site in prose; the sub-agent edits files in
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
    subscribeText,
    pendingCount,
    hasRuntime,
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
// iframe via `srcdoc`. The sandbox grants `allow-scripts allow-popups`
// only — NOT allow-same-origin (so the generated site can't read this
// app's localStorage / token or hit /api), NOT allow-modals (untrusted
// generated HTML shouldn't be able to alert/confirm-spam).
//
// Because there's no same-origin and no server route for build/site/,
// a plain `<a href>`/`<link href>`/`<script src>` inside the srcdoc has
// no base to resolve against. So we INLINE the page's same-build assets:
// fetch each referenced file that lives under build/site/ via storage and
// rewrite the reference to a blob:/data: URL the iframe can load without
// any origin. CSS is inlined into a <style>; JS into a blob-URL <script>;
// images/fonts into blob URLs; url() refs inside inline styles rewritten.
//
// `version` (the build token) is in the deps so a rebuild that produces
// the SAME deterministic entry path still refetches + re-renders the
// fresh bytes.
// ----------------------------------------------------------------------

// Resolve an asset reference (possibly relative, ./ or bare) against the
// directory of the page being previewed, returning a storage path under
// build/site/ — or null if it escapes the site, is absolute (http/data),
// or otherwise isn't an in-site relative ref we should inline.
function resolveSiteAsset(ref, entryPath) {
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
  if (!resolved.startsWith('build/site/')) return null
  return resolved
}

const PREVIEW_TEXT_EXTS = new Set(['css', 'js', 'mjs', 'json', 'svg'])

function HtmlPreview({ storage, entryPath, version }) {
  const [srcDoc, setSrcDoc] = useState(null)
  const [err, setErr] = useState(null)
  const [loading, setLoading] = useState(true)
  const createdUrlsRef = useRef([])

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
        const sitePath = resolveSiteAsset(ref, entryPath)
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
        const html = await storage.getText(entryPath)
        if (cancelled) return
        if (html == null) throw new Error('Built page could not be loaded. Try Build again.')

        // Parse in a detached document so we can walk + rewrite refs without
        // ever attaching (and thus executing) anything in THIS document.
        const doc = new DOMParser().parseFromString(html, 'text/html')

        // <link rel="stylesheet" href="..."> → inline <style> (with its own
        // url() refs rewritten). Same-build only; external CDN links stay.
        for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
          const sitePath = resolveSiteAsset(link.getAttribute('href'), entryPath)
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

        // <script src="..."> → fetch the JS, re-point src at a blob URL so it
        // executes inside the sandbox (a relative src has no origin to resolve).
        for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
          const sitePath = resolveSiteAsset(script.getAttribute('src'), entryPath)
          if (!sitePath) continue
          try {
            const js = await textFor(sitePath)
            if (cancelled) return
            if (js == null) continue
            const type = (script.getAttribute('type') || 'text/javascript') || 'text/javascript'
            const blob = new Blob([js], { type: type.includes('module') ? 'text/javascript' : type })
            script.setAttribute('src', track(URL.createObjectURL(blob)))
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
            const sitePath = resolveSiteAsset(val, entryPath)
            if (!sitePath) continue
            try {
              const url = await blobUrlFor(sitePath)
              if (cancelled) return
              if (url) el.setAttribute(attr, url)
            } catch { /* keep the original ref */ }
          }
        }

        // <a href="page.html"> to a SEPARATE in-site page can't navigate inside
        // a srcdoc (v1 is single-page) — neutralise it so a click is an inert
        // no-op rather than a broken jump to about:srcdoc. External links and
        // in-page anchors are untouched.
        for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
          const sitePath = resolveSiteAsset(a.getAttribute('href'), entryPath)
          if (sitePath) {
            a.setAttribute('data-ws-internal', a.getAttribute('href'))
            a.removeAttribute('href')
          }
        }

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
  }, [storage, entryPath, version])

  // Revoke blob URLs on unmount.
  useEffect(() => () => {
    for (const u of createdUrlsRef.current) URL.revokeObjectURL(u)
    createdUrlsRef.current = []
  }, [])

  if (err) return <div className="ws-preview-note">{err}</div>
  return (
    <div className="ws-preview">
      {loading && <div className="ws-preview-note">Rendering preview…</div>}
      {srcDoc != null && (
        <iframe
          className="ws-preview-frame"
          title="Site preview"
          sandbox="allow-scripts allow-popups"
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

function fileIcon(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'H'
  if (lower.endsWith('.css')) return 'C'
  if (lower.match(/\.(js|mjs|ts|jsx|tsx)$/)) return 'J'
  if (lower.endsWith('.json')) return '{}'
  if (lower.match(/\.(png|jpe?g|gif|webp|svg|ico)$/)) return 'i'
  return '·'
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
function PlayIcon({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d="M6 4.5 19 12 6 19.5V4.5Z" />
    </svg>
  )
}
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

// In-app context menu. Native context menus / window.prompt are unavailable
// in the mini-app sandbox (no allow-modals), and a native right-click menu
// would also offer "back/reload/inspect" that make no sense here. So we render
// our own absolutely-positioned menu at the cursor. It closes on any outside
// pointer-down, on Escape, and on scroll.
function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    const onDown = (e) => {
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
  onContextMenu, onMoveInto, mainPath, parentPath = '',
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
    const r = e.currentTarget.getBoundingClientRect()
    onContextMenu({ x: r.right, y: r.bottom, path: node.path, isFolder: isFolderItem })
  }, [node.path, onContextMenu])
  if (node.children.size === 0 && node.isFile) {
    const selected = node.path === selectedPath
    const isMain = node.path === mainPath
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
          <span className="ws-tree-icon">{fileIcon(node.name)}</span>
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
        <button
          type="button"
          className="ws-tree-menu-btn"
          aria-label={`Actions for ${node.name}`}
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
        onDrop={(e) => dropMove(e, '')}
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
          <span className="ws-tree-icon">{expanded ? '▾' : '▸'}</span>
          <span className="ws-tree-name">{node.name}/</span>
        </button>
        <button
          type="button"
          className="ws-tree-menu-btn"
          aria-label={`Actions for ${node.name} folder`}
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
              parentPath={node.path}
            />
          ))}
        </div>
      )}
    </>
  )
}

// Left slide-in file drawer (VSCode explorer shape): a panel that transforms
// in from the left edge over a dimming backdrop, opened by the ☰ button.
// It is ALWAYS mounted (the `--open` class drives the transform).
//
// `canMutate` is false until the file index has been confirmed against the
// server (App owns the check). While false we disable add/delete so the user
// can't queue an index write derived from an unconfirmed list.
function FileNavPanel({
  appId, open, onClose, files, selectedPath, onSelect, canMutate,
  onCreateFile, onCreateFolder, onDeleteFile, onDeleteFolder,
  onUpload, onMove, onRename, mainPath, onSetMain, returnFocusRef,
}) {
  const root = useMemo(() => buildTree(files), [files])
  const treeRef = useRef(null)
  const prevOpenRef = useRef(open)
  const fileInputRef = useRef(null)
  const folderInputRef = useRef(null)
  const [ctx, setCtx] = useState(null)
  const closeCtx = useCallback(() => setCtx(null), [])
  useEffect(() => { if (!open) setCtx(null) }, [open])

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
        className={`ws-file-drawer ${open ? 'ws-file-drawer--open' : ''}`}
        aria-label="File tree"
        aria-hidden={!open}
      >
        <div className="ws-drawer-head">
          <div>
            {/* Brand row mirrors the shell header: the app's own icon beside
                its name. Replaces the bare "Files" title; item count sits
                underneath as the secondary line. */}
            <span className="ws-drawer-brand">
              <img
                className="ws-drawer-brand-logo"
                src={`/api/apps/${appId}/icon`}
                width={24}
                height={24}
                alt=""
              />
              <span className="ws-drawer-brand-name">Web Studio</span>
            </span>
            <span className="ws-drawer-count">{files.filter(p => !p.endsWith('/.keep')).length} items</span>
          </div>
        </div>
        <div className="ws-drawer-actions">
          <button className="ws-drawer-btn" onClick={onCreateFile} disabled={!canMutate}>New file</button>
          <button className="ws-drawer-btn" onClick={onCreateFolder} disabled={!canMutate}>New folder</button>
          <button
            className="ws-drawer-btn"
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            disabled={!canMutate}
          >
            Upload
          </button>
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
                No files yet. Tap “New file” or Upload to make one. Use a file’s
                ⋯ menu to set it as the main page or delete it.
              </div>
            ) : null
          ) : (
            <FileNode
              node={root}
              selectedPath={selectedPath}
              onSelect={(p) => { onSelect(p); onClose() }}
              depth={-1}
              onContextMenu={setCtx}
              onMoveInto={onMove}
              mainPath={mainPath}
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
  onFilesMaybeChanged,
}) {
  const mountRef = useRef(null)
  const [error, setError] = useState(null)
  // Keep the latest onFilesMaybeChanged in a ref so the mount effect below does
  // NOT depend on it. That callback's identity changes on every file selection;
  // if it were a mount-effect dep, selecting a file would tear down + remount
  // the chat iframe — destroying a streaming turn mid-flight.
  const onFilesRef = useRef(onFilesMaybeChanged)
  useEffect(() => { onFilesRef.current = onFilesMaybeChanged }, [onFilesMaybeChanged])
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
      persist: 'chat_id.json',
      title: 'Web Studio',
      systemPrompt,
      picker: true,
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
  }, [storage, systemPrompt])

  return (
    <section className="ws-chat-panel">
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

  useEffect(() => () => {
    try { navRef.current?.close?.() } catch {}
    navRef.current = null
    resolveRef.current = null
  }, [])

  const node = state ? (
    <ModalView state={state} />
  ) : null

  return { node, alert, confirm, prompt }
}

function ModalView({ state }) {
  const [value, setValue] = useState(state.kind === 'prompt' ? (state.defaultValue || '') : '')
  const inputRef = useRef(null)
  useEffect(() => {
    if (state.kind === 'prompt' && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (state.kind === 'alert') state.resolve()
        else state.resolve(state.kind === 'prompt' ? null : false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state])
  function onSubmit(e) {
    e.preventDefault()
    if (state.kind === 'prompt') state.resolve(value)
    else if (state.kind === 'confirm') state.resolve(true)
    else state.resolve()
  }
  return (
    <div className="ws-modal-scrim" onClick={() => {
      if (state.kind === 'alert') state.resolve()
      else state.resolve(state.kind === 'prompt' ? null : false)
    }}>
      <div className="ws-modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={onSubmit}>
          <div className="ws-modal-title">{state.title}</div>
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
          <div className="ws-modal-actions">
            {(state.kind === 'confirm' || state.kind === 'prompt') && (
              <button
                type="button"
                className="ws-modal-btn ws-modal-btn--secondary"
                onClick={() => state.resolve(state.kind === 'prompt' ? null : false)}
              >
                Cancel
              </button>
            )}
            <button
              type="submit"
              className={`ws-modal-btn ${state.danger ? 'ws-modal-btn--danger' : 'ws-modal-btn--primary'}`}
            >
              {state.kind === 'confirm' ? (state.danger ? 'Delete' : 'OK') : 'OK'}
            </button>
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
// v2: lowered the chat-panel floor so the chat can collapse to ~composer
// height (hide-chat / full-vibe). Bumped so previously-stored heights, which
// were clamped to the old 24% floor, re-clamp under the new floor rather than
// pinning the panel open.
const CHAT_HEIGHT_CACHE_VERSION = 2
// The chat panel collapses to roughly the composer + head height. As a percent
// of the body this floor lets the resizer (and the Home key) hide the chat so
// the source editor gets nearly the whole viewport; the CSS min-height below
// is the matching pixel floor. The 68% ceiling is unchanged.
const CHAT_MIN_PCT = 12
const CHAT_MAX_PCT = 68

function fileCacheKey(appId) {
  return `webstudio:${appId}:files-cache:v${FILE_CACHE_VERSION}`
}

function chatHeightKey(appId) {
  return `webstudio:${appId}:chat-height:v${CHAT_HEIGHT_CACHE_VERSION}`
}

function readChatHeight(appId) {
  if (typeof localStorage === 'undefined') return 36
  const raw = Number(localStorage.getItem(chatHeightKey(appId)))
  if (!Number.isFinite(raw)) return 36
  return Math.min(CHAT_MAX_PCT, Math.max(CHAT_MIN_PCT, raw))
}

function readFileCache(appId) {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(fileCacheKey(appId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return normalizeFileCacheSnapshot(parsed)
  } catch {
    return null
  }
}

function writeFileCache(appId, index, contents, lastPath) {
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
      fileCacheKey(appId),
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

// ----------------------------------------------------------------------
// Sync pill. Three observable states, in priority order:
//   pending > 0 + offline  → "Offline · N pending"
//   pending > 0 + online   → "Saving · N pending"
//   offline + pending == 0 → "Offline"
//   online + pending == 0  → null (idle steady state)
// hasRuntime=false (older shell) hides the pill rather than fabricate a queue.
// ----------------------------------------------------------------------
function SyncPill({ online, pending, hasRuntime }) {
  if (!hasRuntime) return null
  let label = null
  let variant = null
  if (pending > 0) {
    label = online ? `Saving · ${pending} pending` : `Offline · ${pending} pending`
    variant = online ? 'pending' : 'offline'
  } else if (!online) {
    label = 'Offline'
    variant = 'offline'
  }
  if (!label) return null
  return (
    <div
      className={`ws-sync-pill ws-sync-pill--${variant}`}
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

function useBuild({ appId, token, storage, online }) {
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
  const buildingRef = useRef(false)

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => clearPoll, [clearPoll])

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
  const poll = useCallback(async (doc, onDone) => {
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
    if (status && typeof status === 'object' && status.status) {
      // The verdict echoes the target it was built FROM. build/target.txt +
      // build/status.json are one shared pair per app, so a build kicked from
      // another tab/device for a DIFFERENT doc can land its verdict here. If
      // it isn't the doc we're waiting on, ignore it and keep polling.
      if (status.target && status.target !== doc) {
        pollRef.current = setTimeout(() => poll(doc, onDone), BUILD_POLL_MS)
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
    pollRef.current = setTimeout(() => poll(doc, onDone), BUILD_POLL_MS)
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
    buildingRef.current = true
    clearPoll()
    setBuildDoc(doc)
    setBuildStatus('building')
    setBuildLog('')
    try {
      // 0. Clear any verdict from a PRIOR build so the first poll sees 404
      // (still building) until the new run lands a fresh verdict.
      await storage.remove('build/status.json')
      // 1. Tell the build script which page is the entry.
      await storage.setText('build/target.txt', doc)
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
      pollRef.current = setTimeout(() => poll(doc, onDone), BUILD_POLL_MS)
    } catch (e) {
      finishError((e && e.message) ? e.message : 'Build failed to start.')
    }
  }, [appId, token, storage, online, clearPoll, finishError, poll])

  const rememberEntry = useCallback((doc, entry) => {
    if (buildingRef.current) return
    if (!doc || !entry) return
    setBuildDoc(doc)
    finishDone(doc, entry)
  }, [finishDone])

  return {
    buildStatus, buildLog, buildDoc, entryByDoc, build, rememberEntry,
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
  const storage = useMemo(() => makeStorage(appId, token), [appId, token])
  const online = useOnline()
  const modal = useModal()
  const bodyRef = useRef(null)
  const cached = useMemo(() => readFileCache(appId), [appId])
  const [files, setFiles] = useState(() => cached?.index || [])
  const filesRef = useRef(files)
  const [fileCache, setFileCache] = useState(() => cached?.contents || {})
  const [indexLoaded, setIndexLoaded] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const navHandleRef = useRef(null)
  const navToggleRef = useRef(null)
  const [selectedPath, setSelectedPath] = useState(() => cached?.lastPath || null)
  const [fileContent, setFileContent] = useState('')
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState(null)
  const [fileDirty, setFileDirty] = useState(false)
  const [fileSaving, setFileSaving] = useState(false)
  const fileContentRef = useRef(fileContent)
  const fileDirtyRef = useRef(fileDirty)
  const fileSavingRef = useRef(fileSaving)
  useEffect(() => { fileContentRef.current = fileContent }, [fileContent])
  useEffect(() => { fileDirtyRef.current = fileDirty }, [fileDirty])
  useEffect(() => { fileSavingRef.current = fileSaving }, [fileSaving])
  const [pending, setPending] = useState(0)
  const [chatHeight, setChatHeight] = useState(() => readChatHeight(appId))
  // Viewer mode, toggled by the [Source | Preview] segmented control. 'source'
  // shows the editable CodeMirror source; 'preview' shows the MAIN page's built site.
  const [viewMode, setViewMode] = useState('source')
  // The designated MAIN page — the HTML the Preview renders. Persisted in
  // main.json and defaulted (below) to the first .html (preferring
  // files/index.html). null until the index loads + a default is resolved.
  const [mainPath, setMainPath] = useState(null)
  const mainPathRef = useRef(null)
  useEffect(() => { mainPathRef.current = mainPath }, [mainPath])
  const build = useBuild({ appId, token, storage, online })
  const seenBuildStatusRef = useRef('')

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(chatHeightKey(appId), String(chatHeight)) } catch {}
  }, [appId, chatHeight])

  const resizeChatBy = useCallback((deltaPct) => {
    setChatHeight((value) => Math.min(CHAT_MAX_PCT, Math.max(CHAT_MIN_PCT, value + deltaPct)))
  }, [])

  const beginChatResize = useCallback((event) => {
    event.preventDefault()
    const body = bodyRef.current
    const panel = body?.querySelector?.('.ws-chat-panel')
    if (!body || !panel) return
    const total = body.getBoundingClientRect().height
    if (!total) return
    const startY = event.clientY
    const startHeight = panel.getBoundingClientRect().height
    // Pixel floor mirrors CHAT_MIN_PCT so the drag can collapse the chat to
    // ~composer height; the ceiling keeps a sliver of editor visible.
    const minPx = total * (CHAT_MIN_PCT / 100)
    const maxPx = Math.max(minPx, total * (CHAT_MAX_PCT / 100))

    const onMove = (moveEvent) => {
      const nextPx = Math.min(maxPx, Math.max(minPx, startHeight + startY - moveEvent.clientY))
      setChatHeight(Math.min(CHAT_MAX_PCT, Math.max(CHAT_MIN_PCT, (nextPx / total) * 100)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }, [])

  const handleResizeKey = useCallback((event) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      resizeChatBy(4)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      resizeChatBy(-4)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setChatHeight(CHAT_MIN_PCT)
    } else if (event.key === 'End') {
      event.preventDefault()
      setChatHeight(CHAT_MAX_PCT)
    }
  }, [resizeChatBy])

  useEffect(() => {
    writeFileCache(appId, files, fileCache, selectedPath)
  }, [appId, files, fileCache, selectedPath])

  useEffect(() => { filesRef.current = files }, [files])
  const selectedPathRef = useRef(selectedPath)
  useEffect(() => { selectedPathRef.current = selectedPath }, [selectedPath])

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
    if (navOpen) return
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
  }, [navOpen])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-select the first file once we have one. Prefer the HTML entry, then
  // any text file, then any non-.keep entry.
  useEffect(() => {
    if (!selectedPath && files.length > 0) {
      const firstReal = files.find((p) => isHtmlDoc(p))
        || files.find((p) => isTextProjectPath(p))
        || files.find((p) => !p.endsWith('/.keep'))
      if (firstReal) setSelectedPath(firstReal)
    }
  }, [files, selectedPath])

  // Pick a sensible default main page: files/index.html if present, else the
  // first .html alphabetically, else null.
  const defaultMain = useCallback((list) => {
    if (list.includes('files/index.html')) return 'files/index.html'
    return list.find((p) => isHtmlDoc(p)) || null
  }, [])

  const mainResolvedRef = useRef(false)
  const [mainReady, setMainReady] = useState(false)
  useEffect(() => {
    if (!indexLoaded || mainResolvedRef.current) return
    mainResolvedRef.current = true
    let cancelled = false
    ;(async () => {
      let stored = null
      try {
        const m = await (online ? storage.getFresh('main.json') : storage.get('main.json'))
        if (m && typeof m === 'object' && typeof m.path === 'string') stored = m.path
      } catch { /* offline / transient — fall through to default */ }
      if (cancelled) return
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

    const unsubscribe = storage.subscribeText(path, (body) => {
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
      'Path under files/ — e.g. about.html or css/site.css',
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
    try {
      await storage.setText(path, '')
      const next = [...filesRef.current, path].sort()
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
      'Folder name under files/ — e.g. css or img/icons',
      { title: 'New folder', placeholder: 'css' },
    )
    if (!name) return
    const clean = name.replace(/^\/+/, '').replace(/\/+$/, '').trim()
    if (!isSafeRelPath(clean)) {
      await modal.alert('Use letters, digits, . - _ / only.', { title: 'Invalid name' })
      return
    }
    const path = `files/${clean}/.keep`
    try {
      await storage.setText(path, '')
      const next = [...filesRef.current, path].sort()
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
      const next = filesRef.current.filter((p) => p !== path)
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
    for (const f of items) {
      const rel = ((asFolder && f.webkitRelativePath) || f.name || '')
        .replace(/^\/+/, '')
        .trim()
      if (!isSafeRelPath(rel)) {
        failed.push(f.name || rel || '(unnamed)')
        continue
      }
      const path = `files/${rel}`
      try {
        const isText = /\.(html?|css|js|mjs|ts|jsx|tsx|json|txt|md|csv|svg|xml|webmanifest)$/i.test(rel)
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
      const next = [...new Set([...filesRef.current, ...added])].sort()
      try {
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
      const r = await fetch(`/api/storage/apps/${appId}/move`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      })
      if (!r.ok) {
        let detail = ''
        try { detail = (await r.json()).detail || '' } catch { /* non-JSON */ }
        if (r.status === 409) {
          await modal.alert('Something already exists at the destination.', { title: 'Move failed' })
        } else {
          await modal.alert(`Move failed (${r.status}${detail ? `: ${detail}` : ''}).`, { title: 'Move failed' })
        }
        return
      }
      const rewrite = (p) => {
        if (p === from) return to
        if (p.startsWith(`${from}/`)) return to + p.slice(from.length)
        return p
      }
      const next = [...new Set(filesRef.current.map(rewrite))].sort()
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
      await modal.alert(e.message || String(e), { title: 'Move failed' })
    }
  }, [appId, token, storage, modal, refreshPending, ensureIndexWritable, build])

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
      const r = await fetch(`/api/storage/apps/${appId}/folder/${folderPath}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok && r.status !== 404) {
        let detail = ''
        try { detail = (await r.json()).detail || '' } catch { /* non-JSON */ }
        await modal.alert(`Could not delete folder (${r.status}${detail ? `: ${detail}` : ''}).`, { title: 'Delete failed' })
        return
      }
      const under = (p) => p === folderPath || p.startsWith(`${folderPath}/`)
      const next = filesRef.current.filter((p) => !under(p))
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
  }, [appId, token, storage, modal, refreshPending, ensureIndexWritable, build])

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
      storage.setText(path, body).then(() => {
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
      })
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
    if (!selectedPath || selectedIsBinary || isManagedJsonPath(selectedPath) || fileSaving) return
    setFileSaving(true)
    setFileError(null)
    try {
      await storage.setText(selectedPath, fileContent)
      setFileDirty(false)
      setFileCache((prev) => ({ ...prev, [selectedPath]: fileContent }))
      refreshPending()
    } catch (e) {
      setFileError(e.message || 'Could not save file.')
    } finally {
      setFileSaving(false)
    }
  }, [selectedPath, selectedIsBinary, fileSaving, storage, fileContent, refreshPending])

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
    // Preview mode (only reachable for .html selections via the toggle) shows
    // the MAIN page's built site.
    if (selectedIsHtml && viewMode === 'preview') {
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

  // The Preview view shows the MAIN page's output, so the [Source | Preview]
  // toggle and Build are meaningful while an .html is open.
  const showHtmlControls = selectedIsHtml && hasMain
  const openName = selectedPath ? selectedPath.replace(/^files\//, '') : null

  return (
    <div className="ws-root">
      <style>{CSS}</style>
      <header className="ws-top-bar">
        <button
          ref={navToggleRef}
          className="ws-nav-toggle"
          onClick={toggleNav}
          aria-label={navOpen ? 'Close file drawer' : 'Open file drawer'}
          aria-expanded={navOpen}
        >
          ☰
        </button>
        <div className="ws-top-title">
          {openName
            ? <span className="ws-top-path" title={selectedPath}>{openName}</span>
            : <span className="ws-top-path ws-top-path--muted">No file open</span>}
        </div>
        <div className="ws-top-actions">
          {showHtmlControls && (
            <>
              {/* One icon toggles between the source editor and the live
                  preview; its glyph names the destination (eye = show preview,
                  code = back to source). */}
              <button
                type="button"
                className="ws-icon-btn"
                aria-pressed={viewMode === 'preview'}
                aria-label={viewMode === 'preview' ? 'Show source' : 'Show preview'}
                title={viewMode === 'preview' ? 'Show source' : 'Show preview'}
                onClick={() => setViewMode((m) => (m === 'preview' ? 'source' : 'preview'))}
              >
                {viewMode === 'preview' ? <CodeIcon /> : <EyeIcon />}
              </button>
              <button
                className="ws-icon-btn ws-icon-btn--primary"
                onClick={handleBuild}
                disabled={build.buildStatus === 'building'}
                aria-label={`Build and preview the main page (${mainPath.replace(/^files\//, '')})`}
                title={build.buildStatus === 'building'
                  ? 'Building…'
                  : `Build + preview ${mainPath.replace(/^files\//, '')}`}
              >
                <PlayIcon />
              </button>
            </>
          )}
          <SyncPill online={online} pending={pending} hasRuntime={storage.hasRuntime} />
        </div>
      </header>

      <div
        ref={bodyRef}
        className="ws-body"
        style={{ '--ws-chat-panel-height': `${chatHeight}%` }}
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
        />
        <main className="ws-content">{renderMain()}</main>
        <div
          className="ws-chat-resizer"
          role="separator"
          aria-label="Resize chat and preview areas"
          aria-orientation="horizontal"
          aria-valuemin={CHAT_MIN_PCT}
          aria-valuemax={CHAT_MAX_PCT}
          aria-valuenow={Math.round(chatHeight)}
          tabIndex={0}
          onPointerDown={beginChatResize}
          onKeyDown={handleResizeKey}
        >
          <span className="ws-chat-resizer-bar" aria-hidden="true" />
        </div>
        <ChatPanel
          appId={appId}
          token={token}
          storage={storage}
          onFilesMaybeChanged={onFilesMaybeChanged}
        />
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
.ws-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: var(--bg, #111614);
  color: var(--text, #eef7f1);
  font-family: var(--font, Inter, ui-sans-serif, system-ui, sans-serif);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
}

.ws-top-bar {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 6px 10px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.ws-nav-toggle {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  min-height: 44px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 16px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ws-nav-toggle:active { background: var(--surface2); }
.ws-top-title {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
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
.ws-top-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}
/* ---- single-line icon toolbar (eye toggle + play Build) ----
   Square 44x44 tap targets so the whole bar — filename, view toggle, Build —
   stays on one line even on a narrow phone. */
.ws-icon-btn {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
}
.ws-icon-btn:active { background: var(--surface2, var(--surface)); }
.ws-icon-btn[aria-pressed="true"] {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  color: var(--accent);
}
.ws-icon-btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #062016;
}
.ws-icon-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ---- body: content area + bounded chat, stacked ----
   position: relative so the absolutely-positioned file drawer + its backdrop
   resolve against THIS box — i.e. they overlay only the area below the top
   bar, leaving the ☰ toggle always tappable. */
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
   The built site renders inside a sandboxed iframe via srcdoc. White
   backdrop behind it because most generated pages assume a light page. */
.ws-preview {
  position: relative;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: #fff;
}
.ws-preview .ws-preview-note {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface2, var(--surface));
}
.ws-preview-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}

/* ---- file drawer ---- */
.ws-drawer-scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
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
.ws-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 52px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.ws-drawer-brand {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ws-drawer-brand-logo {
  flex: 0 0 auto;
  border-radius: 6px;
  display: block;
}
.ws-drawer-brand-name { font-size: 14px; font-weight: 600; color: var(--text); }
.ws-drawer-count {
  display: block;
  margin-top: 2px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
}
.ws-drawer-actions {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
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
}
.ws-drawer-btn:active { background: var(--surface2, var(--surface)); }
.ws-drawer-btn:disabled { opacity: 0.45; cursor: default; }
.ws-drawer-syncing {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}
.ws-drawer-tree {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 8px 0;
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
}
.ws-tree-file, .ws-tree-folder {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 44px;
  padding: 7px 12px;
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
  font-family: var(--font);
  outline: none;
}
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
  background: none;
  color: var(--muted);
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.12s ease, color 0.12s ease;
}
.ws-tree-row:hover .ws-tree-menu-btn,
.ws-tree-menu-btn:focus-visible { opacity: 1; }
.ws-tree-menu-btn:hover { color: var(--text); }
.ws-tree-menu-btn:active { color: var(--accent); }
@media (hover: none) {
  .ws-tree-menu-btn { opacity: 1; }
}
.ws-tree-file:hover, .ws-tree-folder:hover {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.ws-tree-file:focus-visible, .ws-tree-folder:focus-visible {
  box-shadow: inset 3px 0 0 var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.ws-tree-file:active, .ws-tree-folder:active {
  background: var(--surface2, var(--bg));
}
.ws-tree-file--selected {
  background: color-mix(in srgb, var(--accent) 22%, var(--surface));
  color: var(--text);
  box-shadow: inset 3px 0 0 var(--accent);
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

/* In-app context menu (right-click / long-press). position: fixed so its
   left/top (set from the pointer's viewport coords) land exactly under the
   finger regardless of which positioned ancestor it renders inside. */
.ws-ctx-menu {
  position: fixed;
  z-index: 60;
  min-width: 160px;
  padding: 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ws-ctx-item {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 8px 10px;
  text-align: left;
  border: none;
  border-radius: 7px;
  background: none;
  color: var(--text);
  font: 550 13px/1.2 var(--font);
  cursor: pointer;
}
.ws-ctx-item:active { background: var(--surface2, var(--surface)); }
.ws-ctx-item--danger { color: var(--danger); }
.ws-tree-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  font-size: 11px;
  font-weight: 700;
  color: var(--muted);
  flex: 0 0 auto;
}
.ws-tree-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/* ---- chat panel (bottom sheet, bounded height) ----
   The embedded shell chat runs inside an iframe (window.mobius.chat). The
   panel needs a BOUNDED height and the embed needs min-height:0 so the iframe
   (which has its own internal scroll + a sticky composer) can shrink to fit
   and scroll internally instead of overflowing the container. */
.ws-chat-panel {
  flex: 0 0 auto;
  height: var(--ws-chat-panel-height, 36%);
  /* Floor low enough to collapse to ~composer height (head + a row for the
     composer): the hide-chat / full-vibe layout where the source editor takes
     almost the whole viewport. Was min(220px, 45%), which pinned the chat open. */
  min-height: min(96px, 18%);
  max-height: calc(100% - 120px);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-top: 1px solid var(--border);
}
.ws-chat-resizer {
  flex: 0 0 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ns-resize;
  background: var(--surface);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  touch-action: none;
}
.ws-chat-resizer:hover,
.ws-chat-resizer:focus-visible {
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
  outline: none;
}
.ws-chat-resizer-bar {
  width: 44px;
  height: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 65%, transparent);
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

/* ---- modal ---- */
.ws-modal-scrim {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  z-index: 50;
  padding: 16px;
}
.ws-modal {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
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
  outline: none;
  margin-bottom: 14px;
  box-sizing: border-box;
}
.ws-modal-input:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
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
}
.ws-modal-btn--primary {
  background: var(--accent);
  color: #062016;
  border-color: var(--accent);
}
.ws-modal-btn--danger {
  background: var(--danger);
  color: #fff;
  border-color: var(--danger);
}
.ws-modal-btn--secondary { background: var(--surface); }

/* ---- sync pill ----
   Hidden in the steady state (online + 0 pending); only appears when there's
   something to say. Same shape as the latex + atlas apps so the platform
   feels coherent. */
.ws-sync-pill {
  position: absolute;
  right: 12px;
  bottom: 12px;
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
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
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
.ws-top-actions .ws-sync-pill {
  position: static;
  right: auto;
  bottom: auto;
  z-index: auto;
  box-shadow: none;
  white-space: nowrap;
}
`
