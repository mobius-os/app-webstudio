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
