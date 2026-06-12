// Unit tests for the preview's link policy and the first-load file pick.
// The functions under test are pure module-level exports of index.jsx, so the
// whole app is bundled once (esbuild, platform=node) and imported — the same
// harness app-atlas uses. react resolves from the mobius frontend checkout and
// @codemirror/* from app-notes' node_modules via NODE_PATH.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const esbuild = '/home/hmzmrzx/projects/mobius/frontend/node_modules/.bin/esbuild'
const nodePath = [
  '/home/hmzmrzx/projects/mobius/frontend/node_modules',
  '/home/hmzmrzx/projects/mobius-catalog-work/app-notes/node_modules',
].join(':')
mkdirSync(new URL('./.build/', import.meta.url), { recursive: true })
execFileSync(esbuild, [
  '--bundle',
  '--format=esm',
  '--jsx=automatic',
  '--platform=node',
  'index.jsx',
  '--outfile=tests/.build/index.mjs',
], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, NODE_PATH: nodePath },
  stdio: 'pipe',
})

const {
  anchorActionFor,
  pickAutoSelectPath,
  resolveSiteAsset,
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

test('external links open a new tab; anchors and scheme links keep native behavior', () => {
  assert.deepEqual(anchorActionFor('https://example.com', ROOT_PAGE), { kind: 'external' })
  assert.deepEqual(anchorActionFor('//example.com/page', ROOT_PAGE), { kind: 'external' })
  assert.deepEqual(anchorActionFor('#section', ROOT_PAGE), { kind: 'keep' })
  assert.deepEqual(anchorActionFor('mailto:hi@example.com', ROOT_PAGE), { kind: 'keep' })
  assert.deepEqual(anchorActionFor('tel:+123', ROOT_PAGE), { kind: 'keep' })
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
