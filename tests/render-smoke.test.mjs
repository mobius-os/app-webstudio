import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { bundleModule, repoRoot } from './bundle.mjs'

const outfile = 'tests/.build/webstudio-render-app.mjs'

test('the launcher mounts against the current Projects API without a migrate method', async (t) => {
  t.after(async () => {
    delete globalThis.__webstudioRenderEffects
    delete globalThis.window
    await rm(join(repoRoot, outfile), { force: true })
  })

  const calls = []
  globalThis.__webstudioRenderEffects = []
  globalThis.window = {
    mobius: {
      projects: {
        async list() { calls.push('list'); return [] },
        async templates() { calls.push('templates'); return [] },
        async create() { calls.push('create') },
        async open() { calls.push('open') },
      },
      signal() {},
    },
  }

  const { default: App } = await bundleModule({
    entry: 'index.jsx',
    outfile,
    alias: {
      react: join(repoRoot, 'tests', 'render-react-stub.mjs'),
      'react/jsx-runtime': join(repoRoot, 'tests', 'render-jsx-stub.mjs'),
      '@openai/apps-sdk-ui/components/Icon': join(repoRoot, 'tests', 'render-icons-stub.mjs'),
    },
  })

  assert.equal(typeof App, 'function')
  assert.doesNotThrow(() => App({ appId: 19 }))
  assert.equal(globalThis.__webstudioRenderEffects.length, 1)
  globalThis.__webstudioRenderEffects.shift()()
  for (let i = 0; i < 4; i += 1) await Promise.resolve()

  assert.deepEqual(calls, ['list', 'templates'])
})

function elements(node) {
  if (!node || typeof node !== 'object') return []
  const children = node.props?.children
  return [node, ...[children].flat(Infinity).flatMap(elements)]
}

test('browse opens shell Projects without broadening the website list; load errors remain retryable', async (t) => {
  const browseOutfile = 'tests/.build/webstudio-browse-app.mjs'
  t.after(async () => {
    delete globalThis.__webstudioRenderEffects
    delete globalThis.__webstudioStates
    delete globalThis.__webstudioStateIndex
    delete globalThis.window
    await rm(join(repoRoot, browseOutfile), { force: true })
  })
  const calls = []
  let fail = true
  let browseFails = false
  let onlineChange
  globalThis.__webstudioRenderEffects = []
  globalThis.__webstudioStates = []
  globalThis.window = { mobius: {
    projects: {
      async list() {
        calls.push('list')
        if (fail) throw new Error('Load failed')
        return [{ id: 'web', name: 'Site', template: { id: 'website' } },
          { id: 'doc', name: 'Document', template: { id: 'document' } }]
      },
      async templates() { calls.push('templates'); return [{ id: 'website', key: 'webstudio:website' }] },
      async browse() { calls.push('browse'); if (browseFails) throw new Error('Browse failed') },
    },
    onOnlineChange(callback) { onlineChange = callback; return () => {} },
    signal() {},
  } }
  const { default: App, projectDate, projectTimestamp } = await bundleModule({
    entry: 'index.jsx', outfile: browseOutfile,
    alias: {
      react: join(repoRoot, 'tests', 'render-react-stub.mjs'),
      'react/jsx-runtime': join(repoRoot, 'tests', 'render-jsx-stub.mjs'),
      '@openai/apps-sdk-ui/components/Icon': join(repoRoot, 'tests', 'render-icons-stub.mjs'),
    },
  })
  const render = () => { globalThis.__webstudioStateIndex = 0; return elements(App({ appId: 19 })) }
  const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() }
  render()
  globalThis.__webstudioRenderEffects.shift()()
  await settle()
  assert.equal(globalThis.__webstudioStates[4], 'Load failed')
  fail = false
  render().find(node => node.type === 'button' && node.props.children === 'Try again').props.onClick()
  await settle()
  assert.deepEqual(globalThis.__webstudioStates[0].map(row => row.id), ['web'])
  const nodes = render()
  assert.ok(nodes.some(node => node.type === 'small' && node.props.children[0] === 'Website'))
  nodes.find(node => node.type === 'button' && node.props.children?.[0]?.trim?.() === 'All projects').props.onClick()
  await settle()
  assert.equal(calls.at(-1), 'browse')
  browseFails = true
  nodes.find(node => node.type === 'button' && node.props.children?.[0]?.trim?.() === 'All projects').props.onClick()
  await settle()
  assert.equal(globalThis.__webstudioStates[5], 'Browse failed')
  onlineChange(false)
  onlineChange(true)
  await settle()
  assert.deepEqual(calls.slice(-2), ['list', 'templates'])

  const now = Date.parse('2026-11-03T12:00:00Z')
  const relative = new Intl.RelativeTimeFormat('en', { numeric: 'always' })
  assert.equal(projectTimestamp('2026-11-03T11:00:00'), Date.parse('2026-11-03T11:00:00Z'))
  assert.equal(projectTimestamp('2026-11-03T13:00:00+02:00'), Date.parse('2026-11-03T11:00:00Z'))
  assert.equal(projectDate('2026-11-03T11:59:30Z', now), 'Just now')
  assert.equal(projectDate('2026-11-03T11:58:00Z', now), relative.format(-2, 'minute'))
  assert.equal(projectDate('2026-11-03T11:00:00Z', now), relative.format(-1, 'hour'))
  assert.equal(projectDate('2026-10-28T12:00:00Z', now), relative.format(-6, 'day'))
  assert.equal(projectDate('2026-10-27T12:00:01Z', now), relative.format(-6, 'day'))
  assert.equal(projectDate('2026-10-27T12:00:00Z', now), '27 Oct 2026')
  assert.equal(projectDate('invalid', now), '')
  assert.equal(projectDate(null, now), '')
})
