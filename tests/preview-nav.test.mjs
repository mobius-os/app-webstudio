// Unit tests for the preview's link policy and the first-load file pick.
// The functions under test are pure module-level exports of index.jsx, so the
// whole app is bundled once (esbuild, platform=node) and imported. Everything
// resolves from THIS repo's own node_modules after `npm install`; in the
// monorepo workspace it can fall back to the shared Mobius esbuild.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveEsbuild, sharedReactAliases } from './esbuild-path.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const esbuild = resolveEsbuild(import.meta.url)
mkdirSync(new URL('./.build/', import.meta.url), { recursive: true })
execFileSync(esbuild, [
  '--bundle',
  '--format=esm',
  '--jsx=automatic',
  '--platform=node',
  ...sharedReactAliases(import.meta.url),
  '--alias:@codemirror/state=./tests/runtime-lib-stub.mjs',
  '--alias:@codemirror/view=./tests/runtime-lib-stub.mjs',
  '--alias:@codemirror/commands=./tests/runtime-lib-stub.mjs',
  'index.jsx',
  '--outfile=tests/.build/index.mjs',
], {
  cwd: repoRoot,
  stdio: 'pipe',
})

const {
  anchorActionFor,
  pickAutoSelectPath,
  resolveSiteAsset,
  clampChatRatio,
  isManagedJsonPath,
  WS_PREVIEW_NAV_SCRIPT,
} = await import('./.build/index.mjs')

const ROOT_PAGE = 'build/site/index.html'
const ABOUT_PAGE = 'build/site/about/index.html'

test('resolveSiteAsset maps the site root to its index page', () => {
  // href="/" from any page, and "../" chains that land on the root, must
  // resolve to the index page — not the bare 'build/site' string that the
  // prefix guard rejects (which is what made root links fall through live).
  assert.equal(resolveSiteAsset('/', ROOT_PAGE), ROOT_PAGE)
  assert.equal(resolveSiteAsset('/', ABOUT_PAGE), ROOT_PAGE)
  assert.equal(resolveSiteAsset('../', ABOUT_PAGE), ROOT_PAGE)
  assert.equal(resolveSiteAsset('..', ABOUT_PAGE), ROOT_PAGE)
  assert.equal(resolveSiteAsset('./', ROOT_PAGE), ROOT_PAGE)
  // Climbing is clamped at the site root, never above it.
  assert.equal(resolveSiteAsset('../../..', ABOUT_PAGE), ROOT_PAGE)
})

test('resolveSiteAsset still resolves ordinary refs and rejects escapes', () => {
  assert.equal(resolveSiteAsset('style.css', ROOT_PAGE), 'build/site/style.css')
  assert.equal(resolveSiteAsset('../style.css', ABOUT_PAGE), 'build/site/style.css')
  assert.equal(resolveSiteAsset('/about/index.html', ROOT_PAGE), ABOUT_PAGE)
  assert.equal(resolveSiteAsset('https://example.com/x.css', ROOT_PAGE), null)
  assert.equal(resolveSiteAsset('//cdn.example.com/x.js', ROOT_PAGE), null)
  assert.equal(resolveSiteAsset('#top', ROOT_PAGE), null)
  assert.equal(resolveSiteAsset('', ROOT_PAGE), null)
})

test('root links are in-preview navigations to the home page', () => {
  assert.deepEqual(anchorActionFor('/', ABOUT_PAGE), { kind: 'internal', target: ROOT_PAGE })
  assert.deepEqual(anchorActionFor('../', ABOUT_PAGE), { kind: 'internal', target: ROOT_PAGE })
  assert.deepEqual(anchorActionFor('/', ROOT_PAGE), { kind: 'internal', target: ROOT_PAGE })
})

test('page and directory links are in-preview navigations', () => {
  assert.deepEqual(anchorActionFor('about/index.html', ROOT_PAGE), { kind: 'internal', target: ABOUT_PAGE })
  assert.deepEqual(anchorActionFor('about/', ROOT_PAGE), { kind: 'internal', target: ABOUT_PAGE })
  assert.deepEqual(anchorActionFor('/docs', ROOT_PAGE), { kind: 'internal', target: 'build/site/docs/index.html' })
})

test('external links open a new tab; anchors and allowlisted schemes keep native behavior', () => {
  assert.deepEqual(anchorActionFor('https://example.com', ROOT_PAGE), { kind: 'external' })
  assert.deepEqual(anchorActionFor('//example.com/page', ROOT_PAGE), { kind: 'external' })
  assert.deepEqual(anchorActionFor('#section', ROOT_PAGE), { kind: 'keep' })
  assert.deepEqual(anchorActionFor('mailto:hi@example.com', ROOT_PAGE), { kind: 'keep' })
  assert.deepEqual(anchorActionFor('tel:+123', ROOT_PAGE), { kind: 'keep' })
})

test('about page is an in-preview internal navigation', () => {
  assert.deepEqual(anchorActionFor('/about', ROOT_PAGE), { kind: 'internal', target: 'build/site/about/index.html' })
  assert.deepEqual(anchorActionFor('about.html', ROOT_PAGE), { kind: 'internal', target: 'build/site/about.html' })
})

test('dangerous schemes are neutralised, never kept live', () => {
  // The scheme policy is an allowlist (mailto, tel) — any other scheme,
  // especially the dangerous ones, must have its href stripped. The preview
  // iframe runs with allow-scripts (no allow-same-origin), so a live
  // `javascript:` href would still execute inside the sandbox; neutralising
  // is defense in depth regardless of the sandbox flags.
  assert.deepEqual(anchorActionFor('javascript:alert(1)', ROOT_PAGE), { kind: 'neutralise' })
  assert.deepEqual(anchorActionFor('JavaScript:alert(1)', ROOT_PAGE), { kind: 'neutralise' }) // case-insensitive
  assert.deepEqual(anchorActionFor('data:text/html,<script>1</script>', ROOT_PAGE), { kind: 'neutralise' })
  assert.deepEqual(anchorActionFor('vbscript:msgbox(1)', ROOT_PAGE), { kind: 'neutralise' })
  assert.deepEqual(anchorActionFor('blob:https://x/abc', ROOT_PAGE), { kind: 'neutralise' })
  assert.deepEqual(anchorActionFor('file:///etc/passwd', ROOT_PAGE), { kind: 'neutralise' })
})

test('any schemeless href that fails to resolve is neutralised, never left live', () => {
  // A live schemeless href natively navigates the sandboxed srcdoc frame
  // away (blank pane; the shell origin in production) — the whole point of
  // the neutralise branch is that nothing schemeless ever falls through.
  assert.deepEqual(anchorActionFor('style.css', ROOT_PAGE), { kind: 'neutralise' }) // non-page asset
  assert.deepEqual(anchorActionFor('/notes.txt', ABOUT_PAGE), { kind: 'neutralise' }) // root-relative non-page
  assert.deepEqual(anchorActionFor('', ROOT_PAGE), { kind: 'neutralise' })          // empty href
  assert.deepEqual(anchorActionFor('?page=2', ROOT_PAGE), { kind: 'neutralise' })    // query-only
  assert.deepEqual(anchorActionFor('   ', ROOT_PAGE), { kind: 'neutralise' })        // whitespace
})

test('auto-select prefers the main page over alphabetical order', () => {
  const files = ['files/about/index.html', 'files/app.js', 'files/index.html', 'files/style.css']
  // The bug this guards: files/about/index.html sorts first, but opening it
  // hides the Build/Preview controls (they require selectedPath === mainPath).
  assert.equal(pickAutoSelectPath(files, 'files/index.html'), 'files/index.html')
  // A non-default main wins too.
  assert.equal(pickAutoSelectPath(files, 'files/about/index.html'), 'files/about/index.html')
  // Main not (yet) in the list → first HTML file, as before.
  assert.equal(pickAutoSelectPath(files, 'files/gone.html'), 'files/about/index.html')
  assert.equal(pickAutoSelectPath(files, null), 'files/about/index.html')
  // No HTML at all → first text file, then any non-placeholder.
  assert.equal(pickAutoSelectPath(['files/style.css'], null), 'files/style.css')
  assert.equal(pickAutoSelectPath(['files/img/.keep', 'files/logo.png'], null), 'files/logo.png')
  assert.equal(pickAutoSelectPath(['files/img/.keep'], null), null)
})

// ----------------------------------------------------------------------
// Managed-JSON classification (isManagedJsonPath). Regression guard for the
// medium bug where EVERY .json was treated as read-only typed JSON, so a
// user's files/data.json was written as text but read as JSON (assertReadKind
// wrong-kind) and could not be edited. Only the app's OWN metadata is managed;
// user files under files/ (including .json) are editable source.
// ----------------------------------------------------------------------
test('isManagedJsonPath marks only the app metadata, not user files', () => {
  // App metadata — managed (read-only, typed JSON), scoped and root-prefixed.
  for (const p of ['files-index.json', 'main.json', 'chat_id.json',
    'build/status.json', 'build/dispatch.json', 'projects.json',
    'projects/abc/main.json', 'projects/abc/build/status.json']) {
    assert.equal(isManagedJsonPath(p), true, `${p} should be managed`)
  }
  // User source under files/ — NOT managed, so it round-trips as editable text.
  for (const p of ['files/data.json', 'files/config.json', 'files/index.html',
    'files/css/site.css', 'projects/abc/files/data.json']) {
    assert.equal(isManagedJsonPath(p), false, `${p} should be editable source`)
  }
  assert.equal(isManagedJsonPath(''), false)
  assert.equal(isManagedJsonPath(null), false)
})

// ----------------------------------------------------------------------
// Chat-pane resize bound (clampChatRatio): the chat collapses to exactly the
// composer pill (CHAT_PANE_MIN_PX) and no smaller, and the editor/preview
// always keeps at least one pill. Mirrors app-latex / app-editor.
// ----------------------------------------------------------------------
const CHAT_MIN = 74 // CHAT_PANE_MIN_PX (pill 64 + divider 10) — keep in sync with index.jsx

test('clampChatRatio collapses to exactly the pill floor, never smaller', () => {
  const total = 800
  assert.equal(clampChatRatio(0, total, CHAT_MIN), CHAT_MIN / total)
  assert.equal(clampChatRatio(-500, total, CHAT_MIN), CHAT_MIN / total)
  assert.equal(clampChatRatio(CHAT_MIN - 1, total, CHAT_MIN), CHAT_MIN / total)
})

test('clampChatRatio caps the other end so the editor keeps a pill', () => {
  const total = 800
  assert.equal(clampChatRatio(total, total, CHAT_MIN), (total - CHAT_MIN) / total)
  assert.equal(clampChatRatio(total + 500, total, CHAT_MIN), (total - CHAT_MIN) / total)
})

test('clampChatRatio passes mid-range values through unchanged', () => {
  const total = 800
  assert.equal(clampChatRatio(400, total, CHAT_MIN), 0.5)
  assert.equal(clampChatRatio(200, total, CHAT_MIN), 0.25)
})

test('clampChatRatio falls back to 50/50 when the body cannot hold two pills', () => {
  assert.equal(clampChatRatio(10, 100, CHAT_MIN), 0.5)
  assert.equal(clampChatRatio(90, 100, CHAT_MIN), 0.5)
  assert.equal(clampChatRatio(50, 0, CHAT_MIN), 0.5)
  assert.equal(clampChatRatio(50, -1, CHAT_MIN), 0.5)
})

// ----------------------------------------------------------------------
// Injected preview click handler (WS_PREVIEW_NAV_SCRIPT). This is the source-
// level fix for the shell-drawer-corruption bug: a sandboxed srcdoc iframe
// shares the browser's single session history with the top shell, so a native
// `<a href="#x">` click pushes a phantom history entry that desyncs the shell's
// back-stack. The script must intercept #anchor clicks, scroll in-frame, and
// preventDefault — never performing a fragment navigation. We run the script in
// a minimal DOM/event mock and exercise its installed click handler.
// ----------------------------------------------------------------------
function runNavScript() {
  let clickHandler = null
  const scrolled = []
  const posted = []
  const elementsById = {}
  const doc = {
    addEventListener: (type, fn, capture) => {
      if (type === 'click' && capture === true) clickHandler = fn
    },
    getElementById: (id) => elementsById[id] || null,
    querySelector: () => null,
  }
  const win = {
    parent: { postMessage: (msg) => posted.push(msg) },
    CSS: { escape: (s) => s },
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'window', 'CSS', WS_PREVIEW_NAV_SCRIPT)
  fn(doc, win, win.CSS)
  const makeAnchor = (attrs, opts = {}) => {
    const el = {
      _attrs: attrs,
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      closest(sel) {
        if (sel === 'a[data-ws-internal]') return 'data-ws-internal' in attrs ? this : null
        if (sel === 'a[href^="#"]') return (attrs.href || '').startsWith('#') ? this : null
        return null
      },
      scrollIntoView: () => scrolled.push(el),
      ...opts,
    }
    return el
  }
  const click = (target) => {
    let defaultPrevented = false
    clickHandler({ target, preventDefault: () => { defaultPrevented = true } })
    return defaultPrevented
  }
  return { click, makeAnchor, scrolled, posted, elementsById }
}

test('nav-script intercepts #anchor clicks: scrolls in-frame, no history-pushing nav', () => {
  const h = runNavScript()
  h.elementsById.book = { scrollIntoView: () => h.scrolled.push('book') }
  const anchor = h.makeAnchor({ href: '#book' })
  // The mocked target IS the anchor; closest('a[data-ws-internal]') misses,
  // closest('a[href^="#"]') hits — the #anchor branch runs.
  const target = { closest: anchor.closest.bind(anchor) }
  const prevented = h.click(target)
  // Default prevented (so the browser never performs the fragment navigation
  // that would push a phantom entry into the shared session history) and the
  // resolved element was scrolled into view instead.
  assert.equal(prevented, true)
  assert.deepEqual(h.scrolled, ['book'])
  // No postMessage: a pure #anchor is handled entirely in-frame.
  assert.equal(h.posted.length, 0)
})

test('nav-script still routes data-ws-internal page links via postMessage', () => {
  const h = runNavScript()
  const anchor = h.makeAnchor({ 'data-ws-internal': 'build/site/about/index.html', href: 'about/' })
  const target = { closest: anchor.closest.bind(anchor) }
  const prevented = h.click(target)
  assert.equal(prevented, true)
  assert.deepEqual(h.posted, [{ type: 'ws-preview-nav', path: 'build/site/about/index.html' }])
})

test('nav-script ignores clicks that hit no link', () => {
  const h = runNavScript()
  const target = { closest: () => null }
  const prevented = h.click(target)
  assert.equal(prevented, false)
  assert.equal(h.scrolled.length, 0)
  assert.equal(h.posted.length, 0)
})

test('nav-script preventDefaults a bare "#" with no target (still no nav)', () => {
  const h = runNavScript()
  const anchor = h.makeAnchor({ href: '#' })
  const target = { closest: anchor.closest.bind(anchor) }
  const prevented = h.click(target)
  assert.equal(prevented, true)
  assert.equal(h.scrolled.length, 0)
  assert.equal(h.posted.length, 0)
})
