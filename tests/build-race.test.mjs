// Unit tests for the build-dispatch race predicates (build/useBuild.js wires
// these to fresh server reads). domain.js is ESM-with-imports, so — like the
// preview tests — we bundle it to a plain .mjs first (node runs .js as CJS here
// since package.json has no "type":"module"). Its own outfile: node --test runs
// files in parallel processes, so a shared .build path would race the bundles.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const esbuild = fileURLToPath(new URL('../node_modules/.bin/esbuild', import.meta.url))
mkdirSync(new URL('./.build/', import.meta.url), { recursive: true })
execFileSync(esbuild, [
  '--bundle',
  '--format=esm',
  '--platform=node',
  'domain.js',
  '--outfile=tests/.build/domain-race.mjs',
], { cwd: repoRoot, stdio: 'pipe' })

const { foreignClaimBlocks, claimIsOurs, buildTargetSuperseded } = await import(
  './.build/domain-race.mjs'
)

const TIMEOUT = 120000

// ---- foreignClaimBlocks (pre-check refuse) ------------------------------

test('foreignClaimBlocks: a fresh claim for a DIFFERENT target blocks', () => {
  const now = 1_000_000
  assert.equal(
    foreignClaimBlocks({ target: 'files/other.html', at: now - 1000 }, 'files/index.html', now, TIMEOUT),
    true,
  )
})

test('foreignClaimBlocks: a claim for OUR OWN target does not block (builds converge)', () => {
  const now = 1_000_000
  assert.equal(
    foreignClaimBlocks({ target: 'files/index.html', at: now - 1000 }, 'files/index.html', now, TIMEOUT),
    false,
  )
})

test('foreignClaimBlocks: a STALE claim (older than the timeout) does not block', () => {
  const now = 1_000_000
  assert.equal(
    foreignClaimBlocks({ target: 'files/other.html', at: now - TIMEOUT - 1 }, 'files/index.html', now, TIMEOUT),
    false,
  )
})

test('foreignClaimBlocks: a claim exactly at the timeout boundary has aged out', () => {
  const now = 1_000_000
  assert.equal(
    foreignClaimBlocks({ target: 'files/other.html', at: now - TIMEOUT }, 'files/index.html', now, TIMEOUT),
    false,
  )
})

test('foreignClaimBlocks: malformed/absent claims never block', () => {
  const now = 1_000_000
  for (const bad of [null, undefined, {}, 'x', 42, { target: 'files/o.html' }, { at: now }, { target: '', at: now }, { target: 'files/o.html', at: 'nan' }]) {
    assert.equal(foreignClaimBlocks(bad, 'files/index.html', now, TIMEOUT), false, `should not block: ${JSON.stringify(bad)}`)
  }
})

// ---- claimIsOurs (read-back after settle) -------------------------------

test('claimIsOurs: read-back matching our target is ours', () => {
  assert.equal(claimIsOurs({ target: 'files/index.html', at: 1 }, 'files/index.html'), true)
})

test('claimIsOurs: read-back of a DIFFERENT target means we lost the slot', () => {
  assert.equal(claimIsOurs({ target: 'files/other.html', at: 1 }, 'files/index.html'), false)
})

test('claimIsOurs: a null/absent read-back is not ours', () => {
  assert.equal(claimIsOurs(null, 'files/index.html'), false)
  assert.equal(claimIsOurs(undefined, 'files/index.html'), false)
  assert.equal(claimIsOurs('files/index.html', 'files/index.html'), false)
})

test('claimIsOurs: honours the project prefix in myTarget', () => {
  const t = 'projects/site-a/files/index.html'
  assert.equal(claimIsOurs({ target: t, at: 1 }, t), true)
  assert.equal(claimIsOurs({ target: 'projects/site-b/files/index.html', at: 1 }, t), false)
})

// ---- buildTargetSuperseded (poller fail-fast) ---------------------------

test('buildTargetSuperseded: root target still ours → not superseded', () => {
  assert.equal(buildTargetSuperseded('files/index.html', 'files/index.html'), false)
})

test('buildTargetSuperseded: root target names a DIFFERENT build → superseded', () => {
  assert.equal(buildTargetSuperseded('files/other.html', 'files/index.html'), true)
})

test('buildTargetSuperseded: whitespace around the stored target is ignored', () => {
  assert.equal(buildTargetSuperseded('files/index.html\n', 'files/index.html'), false)
  assert.equal(buildTargetSuperseded('  files/other.html  ', 'files/index.html'), true)
})

test('buildTargetSuperseded: empty/missing/non-string target is NOT a supersede', () => {
  for (const empty of ['', '   ', '\n', null, undefined, 0, {}]) {
    assert.equal(buildTargetSuperseded(empty, 'files/index.html'), false, `should not supersede: ${JSON.stringify(empty)}`)
  }
})

test('buildTargetSuperseded: a superseding build under a project prefix is detected', () => {
  const mine = 'projects/site-a/files/index.html'
  assert.equal(buildTargetSuperseded('projects/site-b/files/index.html', mine), true)
  assert.equal(buildTargetSuperseded(mine, mine), false)
})
