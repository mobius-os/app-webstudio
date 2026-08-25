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

// ---- Page notes: the in-sandbox half ------------------------------------
// The preview is a srcdoc frame WITHOUT allow-same-origin, so the parent can
// neither read the site's DOM nor measure an element's position. Everything
// about pinning therefore has to run inside the frame: this script derives the
// selector, draws the pins, and talks to the parent only through postMessage.
// The parent stays the source of truth for the note list and re-posts it
// whenever it changes.
//
// Toggling the mode is a message rather than a re-render on purpose: rebuilding
// srcdoc to flip a boolean would remount the whole page and throw away the
// reader's scroll position mid-annotation.
export const WS_NOTE_SCRIPT_TEMPLATE = `
(function () {
  var MODE = '__MODE_TYPE__'
  var PICK = '__PICK_TYPE__'
  var on = false
  var notes = []
  var pins = []

  // A selector the PARENT can hand to the agent. Prefer an id (short and
  // stable across a rebuild); otherwise walk up recording nth-of-type so the
  // path stays valid when siblings of other tags come and go.
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return ''
    if (el.id && /^[A-Za-z][-\\w]*$/.test(el.id)) return '#' + el.id
    var parts = []
    var node = el
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var tag = node.tagName.toLowerCase()
      var parent = node.parentNode
      if (!parent) break
      var index = 1
      var sibling = node
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName === node.tagName) index++
      }
      parts.unshift(tag + ':nth-of-type(' + index + ')')
      if (tag === 'body') break
      node = parent
    }
    return parts.join(' > ')
  }

  function clearPins() {
    for (var i = 0; i < pins.length; i++) {
      if (pins[i] && pins[i].parentNode) pins[i].parentNode.removeChild(pins[i])
    }
    pins = []
  }

  // Pins are absolutely positioned in DOCUMENT space and re-laid-out on
  // resize, so they track their element through reflow without needing the
  // parent (which cannot see into this frame) to know anything about layout.
  function drawPins() {
    clearPins()
    if (!document.body) return
    for (var i = 0; i < notes.length; i++) {
      var note = notes[i]
      var target = null
      try { target = document.querySelector(note.selector) } catch (e) { target = null }
      if (!target) continue
      var box = target.getBoundingClientRect()
      var pin = document.createElement('div')
      pin.textContent = String(i + 1)
      pin.setAttribute('title', note.note)
      // all:initial keeps the site's own CSS (a global div rule, a reset)
      // from restyling the pin out of existence.
      pin.style.cssText = 'all:initial;position:absolute;z-index:2147483646;'
        + 'font:600 12px/20px system-ui,sans-serif;color:#fff;background:#d1453b;'
        + 'width:20px;height:20px;border-radius:10px;text-align:center;'
        + 'box-shadow:0 1px 4px rgba(0,0,0,.4);pointer-events:none;'
      pin.style.left = (box.left + window.scrollX - 6) + 'px'
      pin.style.top = (box.top + window.scrollY - 6) + 'px'
      document.body.appendChild(pin)
      pins.push(pin)
    }
  }

  var outline = null
  function setOutline(el) {
    if (!outline) {
      outline = document.createElement('div')
      outline.style.cssText = 'all:initial;position:absolute;z-index:2147483645;'
        + 'border:2px solid #d1453b;background:rgba(209,69,59,.08);'
        + 'pointer-events:none;border-radius:2px;'
    }
    if (!el || !document.body) {
      if (outline.parentNode) outline.parentNode.removeChild(outline)
      return
    }
    var box = el.getBoundingClientRect()
    outline.style.left = (box.left + window.scrollX) + 'px'
    outline.style.top = (box.top + window.scrollY) + 'px'
    outline.style.width = box.width + 'px'
    outline.style.height = box.height + 'px'
    if (!outline.parentNode) document.body.appendChild(outline)
  }

  document.addEventListener('mousemove', function (event) {
    if (!on) return
    setOutline(event.target && event.target.nodeType === 1 ? event.target : null)
  }, true)

  // Capture phase, and preventDefault/stopPropagation: while annotating, a
  // click must never also activate the site's own handlers or follow a link.
  document.addEventListener('click', function (event) {
    if (!on) return
    event.preventDefault()
    event.stopPropagation()
    var el = event.target
    if (!el || el.nodeType !== 1) return
    var text = ''
    try { text = (el.innerText || el.textContent || '').slice(0, 200) } catch (e) { text = '' }
    // The element's OWN markup is what makes a note findable in source. A
    // selector derived from the built page is a hint at best: it breaks the
    // moment the agent adds a sibling, and it says nothing a human would
    // recognise. The markup is what the agent can actually grep for.
    var html = ''
    try { html = (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 300) } catch (e) { html = '' }
    window.parent.postMessage({
      type: PICK,
      selector: selectorFor(el),
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      text: text,
      html: html,
    }, '*')
  }, true)

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || data.type !== MODE) return
    on = !!data.on
    notes = Array.isArray(data.notes) ? data.notes : []
    try { document.body.style.cursor = on ? 'crosshair' : '' } catch (e) {}
    if (!on) setOutline(null)
    drawPins()
  })

  window.addEventListener('resize', drawPins)
})()
`

// The parent injects the concrete types so the sandbox half and the parent
// half can never drift to different message names.
export function noteScript(modeType, pickType) {
  return WS_NOTE_SCRIPT_TEMPLATE
    .replace('__MODE_TYPE__', modeType)
    .replace('__PICK_TYPE__', pickType)
}
