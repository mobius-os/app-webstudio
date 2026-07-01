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

export const PREVIEW_TEXT_EXTS = new Set(['css', 'js', 'mjs', 'json', 'svg'])

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
export const WS_PREVIEW_NAV_TYPE = 'ws-preview-nav'
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
