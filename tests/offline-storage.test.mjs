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
    list: async (path) => { calls.push(['list', path]); return [] },
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
    assert.deepEqual(await storage.list('files/'), [])
    assert.equal(await storage.pendingCount(), 3)
    assert.deepEqual(calls.map((call) => call[0]), [
      'get', 'getText', 'getText', 'getBlob', 'set', 'setText', 'setBlob', 'remove', 'list',
    ])
  } finally {
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})

test('shared JSON updates retry against the latest server version', async () => {
  const previousWindow = globalThis.window
  let reads = 0
  const writes = []
  globalThis.window = {
    mobius: {
      online: true,
      storage: {
        async getWithVersion(path, format) {
          assert.equal(path, 'files-index.json')
          assert.equal(format, 'json')
          reads += 1
          return reads === 1
            ? { value: ['files/index.html'], version: 'v1' }
            : { value: ['files/agent.js', 'files/index.html'], version: 'v2' }
        },
        async durableWrite(path, value, options) {
          writes.push({ path, value, options })
          if (writes.length === 1) {
            throw Object.assign(new Error('changed'), { code: 'conflict' })
          }
          return { synced: true }
        },
      },
    },
  }
  try {
    const storage = makeStorage(68, 'token')
    const result = await storage.updateJSON('files-index.json', (current) => (
      [...new Set([...(current || []), 'files/local.css'])].sort()
    ))
    assert.deepEqual(result.value, [
      'files/agent.js',
      'files/index.html',
      'files/local.css',
    ])
    assert.deepEqual(writes.map(({ options }) => options), [
      { ifMatch: 'v1' },
      { ifMatch: 'v2' },
    ])
  } finally {
    globalThis.window = previousWindow
  }
})

test('recursive listing stays on the runtime storage boundary', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const seen = []
  globalThis.window = {
    mobius: {
      storage: {
        async list(path) {
          seen.push(path)
          if (path === 'files/') return [
            { type: 'directory', path: 'files/css' },
            { type: 'file', path: 'files/index.html' },
          ]
          if (path === 'files/css/') return [{ type: 'file', path: 'files/css/site.css' }]
          return []
        },
      },
    },
  }
  globalThis.fetch = async () => { throw new Error('runtime list must not fall through') }
  try {
    const storage = makeStorage(68, 'token')
    assert.deepEqual(await storage.listFiles('files/'), [
      'files/css/site.css',
      'files/index.html',
    ])
    assert.deepEqual(seen, ['files/', 'files/css/'])
  } finally {
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})
