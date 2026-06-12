// Unit tests for readWithRetry — the bounded, cancellation-aware retry around
// the preview's main-page read. Same bundle-and-import harness as
// preview-nav.test.mjs, but with its own outfile: node --test runs test files
// in parallel processes, so sharing one .build path would race the bundles.
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
  '--outfile=tests/.build/index-retry.mjs',
], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, NODE_PATH: nodePath },
  stdio: 'pipe',
})

const { readWithRetry } = await import('./.build/index-retry.mjs')

// Injectable fake sleep: records the requested delays, resolves immediately.
function fakeSleep() {
  const delays = []
  const sleep = (ms) => { delays.push(ms); return Promise.resolve() }
  return { delays, sleep }
}

test('readWithRetry: first success returns the value with no retry or delay', async () => {
  const { delays, sleep } = fakeSleep()
  let calls = 0
  const v = await readWithRetry(() => { calls += 1; return '<html>' }, { sleep })
  assert.equal(v, '<html>')
  assert.equal(calls, 1)
  assert.deepEqual(delays, [])
})

test('readWithRetry: a transient throw is retried with growing backoff, then succeeds', async () => {
  const { delays, sleep } = fakeSleep()
  let calls = 0
  const v = await readWithRetry(() => {
    calls += 1
    if (calls < 3) throw new Error('blip')
    return 'page'
  }, { sleep })
  assert.equal(v, 'page')
  assert.equal(calls, 3)
  assert.deepEqual(delays, [300, 600])
})

test('readWithRetry: throws the LAST error after the attempt budget is spent', async () => {
  const { sleep } = fakeSleep()
  let calls = 0
  await assert.rejects(
    readWithRetry(() => { calls += 1; throw new Error(`fail ${calls}`) }, { sleep }),
    /fail 3/,
  )
  assert.equal(calls, 3)
})

test('readWithRetry: persistent null resolves null (absent page, not an error)', async () => {
  const { sleep } = fakeSleep()
  let calls = 0
  const v = await readWithRetry(() => { calls += 1; return null }, { sleep })
  assert.equal(v, null)
  assert.equal(calls, 3)
})

test('readWithRetry: a throw followed by clean nulls gives up cleanly, not with the stale error', async () => {
  // null means absent-or-transient; once the read stops THROWING, the earlier
  // error must not resurface — the caller renders "try Build again", not a
  // stale exception message.
  const { sleep } = fakeSleep()
  let calls = 0
  const v = await readWithRetry(() => {
    calls += 1
    if (calls === 1) throw new Error('blip')
    return null
  }, { sleep })
  assert.equal(v, null)
  assert.equal(calls, 3)
})

test('readWithRetry: cancellation between attempts stops the loop promptly', async () => {
  const { delays, sleep } = fakeSleep()
  let calls = 0
  let cancelled = false
  const v = await readWithRetry(() => {
    calls += 1
    cancelled = true // unmount lands while the first attempt is in flight
    throw new Error('blip')
  }, { sleep, isCancelled: () => cancelled })
  assert.equal(v, null)
  assert.equal(calls, 1)
  // The backoff before the would-be second attempt still ran; the cancel
  // check at the top of the next iteration is what stops the loop.
  assert.deepEqual(delays, [300])
})

test('readWithRetry: cancellation before the first attempt never reads at all', async () => {
  const { sleep } = fakeSleep()
  let calls = 0
  const v = await readWithRetry(() => { calls += 1; return 'x' }, {
    sleep, isCancelled: () => true,
  })
  assert.equal(v, null)
  assert.equal(calls, 0)
})

test('readWithRetry: attempts budget is honoured', async () => {
  const { delays, sleep } = fakeSleep()
  let calls = 0
  const v = await readWithRetry(() => { calls += 1; return null }, { sleep, attempts: 5 })
  assert.equal(v, null)
  assert.equal(calls, 5)
  assert.deepEqual(delays, [300, 600, 900, 1200])
})
