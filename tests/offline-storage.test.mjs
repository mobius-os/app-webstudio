import assert from 'node:assert/strict'
import test from 'node:test'

import { makeStorage } from '../storage.js'

test('offline-capable reads and writes stay on the Mobius storage runtime', async () => {
  const calls = []
  const runtime = {
    get: async (path) => { calls.push(['get', path]); return { path } },
    getText: async (path) => { calls.push(['getText', path]); return `cached:${path}` },
    getBlob: async (path) => { calls.push(['getBlob', path]); return { path, kind: 'blob' } },
    set: async (path, value) => { calls.push(['set', path, value]); return { durability: 'queued' } },
    setText: async (path, value) => { calls.push(['setText', path, value]); return { durability: 'queued' } },
    setBlob: async (path, value) => { calls.push(['setBlob', path, value]); return { durability: 'queued' } },
    remove: async (path) => { calls.push(['remove', path]); return { durability: 'queued' } },
    pendingCount: async () => 3,
  }
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  globalThis.window = { mobius: { storage: runtime } }
  globalThis.fetch = async () => { throw new Error('network fallback must not run') }

  try {
    const storage = makeStorage(68, 'token')
    assert.equal(storage.hasRuntime, true)
    assert.deepEqual(await storage.get('main.json'), { path: 'main.json' })
    assert.equal(await storage.get('files/index.html'), 'cached:files/index.html')
    assert.equal(await storage.getText('build/site/index.html'), 'cached:build/site/index.html')
    assert.deepEqual(await storage.getBlob('files/logo.png'), { path: 'files/logo.png', kind: 'blob' })
    assert.deepEqual(await storage.setJSON('main.json', { path: 'files/index.html' }), { durability: 'queued' })
    assert.deepEqual(await storage.setText('files/index.html', '<h1>Offline</h1>'), { durability: 'queued' })
    assert.deepEqual(await storage.setBlob('files/logo.png', { bytes: 4 }), { durability: 'queued' })
    assert.deepEqual(await storage.remove('files/old.css'), { durability: 'queued' })
    assert.equal(await storage.pendingCount(), 3)
    assert.deepEqual(calls.map((call) => call[0]), [
      'get', 'getText', 'getText', 'getBlob', 'set', 'setText', 'setBlob', 'remove',
    ])
  } finally {
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})
