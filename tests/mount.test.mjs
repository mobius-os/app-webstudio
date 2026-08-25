// The app must PAINT, not merely link. `npm run smoke` is a parse-and-link
// check: it happily accepts a component that is referenced but never imported,
// because that is only a ReferenceError at render time. This test bundles the
// app the way Möbius compiles it and mounts it in a real headless browser, so
// that whole class of bug fails here instead of in the user's frame.
//
// Skips (rather than fails) when the shared frontend node_modules or a
// chromium binary is absent, matching how the other bundling tests degrade on
// a fresh clone. Point CHROMIUM_PATH at a binary to force it on.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repoRoot, sharedNodeModules } from './bundle.mjs'

// MUST be async: the harness is served by a server in THIS process, so a
// synchronous spawn would block the event loop and chromium would wait
// forever for a response that can never be written.
const execFileAsync = promisify(execFile)

function findChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH
  }
  for (const p of [
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  ]) if (existsSync(p)) return p
  return null
}

const frontend = sharedNodeModules()
const chromium = findChromium()
const reason = !frontend
  ? 'shared frontend node_modules not found'
  : (!chromium ? 'no chromium binary found' : null)

// `skip` must be a string or an explicit false — a null here is not
// reliably treated as "do not skip", which silently disables the test.
test('the app mounts and paints in a browser', { skip: reason || false }, async () => {
  const outDir = join(repoRoot, 'tests', '.mount')
  mkdirSync(outDir, { recursive: true })
  const req = createRequire(join(frontend, 'package.json'))
  const { rolldown } = await import(pathToFileURL(req.resolve('rolldown')).href)
  const build = await rolldown({
    input: join(repoRoot, 'tests', 'mount-harness.jsx'),
    platform: 'browser',
    tsconfig: false,
    transform: { jsx: 'react-jsx' },
    resolve: { modules: [frontend, 'node_modules'] },
  })
  // IIFE, not ESM: a classic script runs synchronously, so --dump-dom cannot
  // race module evaluation and report an empty page as a pass.
  await build.write({ file: join(outDir, 'mount.js'), format: 'iife' })
  await build.close()

  const html = '<!doctype html><html><body><div id="root"></div>'
    + '<script src="./mount.js"></script></body></html>'
  const server = createServer((rq, rs) => {
    if (rq.url.startsWith('/mount.js')) {
      rs.writeHead(200, { 'content-type': 'text/javascript', connection: 'close' })
      rs.end(readFileSync(join(outDir, 'mount.js')))
      return
    }
    rs.writeHead(200, { 'content-type': 'text/html', connection: 'close' })
    rs.end(html)
  })
  server.keepAliveTimeout = 1
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  try {
    const profile = mkdtempSync(join(tmpdir(), 'ws-mount-'))
    let dom
    try {
      const run = await execFileAsync(chromium, [
        '--headless=new', '--no-sandbox', '--disable-gpu',
        '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-background-networking',
        `--user-data-dir=${profile}`,
        '--virtual-time-budget=8000',
        '--dump-dom', `http://127.0.0.1:${port}/`,
      ], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 })
      dom = run.stdout
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }

    const match = dom.match(/<pre id="probe">([\s\S]*?)<\/pre>/)
    assert.ok(match, 'the harness never reported — the app did not finish mounting')
    const probe = JSON.parse(
      match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
    )
    assert.deepEqual(probe.errors, [], 'the app raised errors while mounting')
    // A real render is thousands of bytes; a blank shell is a few hundred.
    assert.ok(
      probe.rendered > 2000,
      `the app painted only ${probe.rendered} bytes — it did not really render`,
    )
  } finally {
    server.close()
  }
})
