import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceFingerprint, sourceNeedsBuild } from '../domain.js'

const file = (path, size, modified_at) => ({ path, type: 'file', size, modified_at })

test('sourceFingerprint ignores directories, build output, and listing order', () => {
  const a = sourceFingerprint([
    file('files/index.html', 120, '2026-08-25T10:00:00Z'),
    { path: 'files/css', type: 'directory' },
    file('files/css/site.css', 40, '2026-08-25T10:00:00Z'),
    file('build/site/index.html', 120, '2026-08-25T11:00:00Z'),
  ])
  const b = sourceFingerprint([
    file('files/css/site.css', 40, '2026-08-25T10:00:00Z'),
    file('files/index.html', 120, '2026-08-25T10:00:00Z'),
  ])
  assert.equal(a, b)
})

test('sourceFingerprint changes when a file is edited in place at the same size', () => {
  const before = sourceFingerprint([file('files/index.html', 120, '2026-08-25T10:00:00Z')])
  const after = sourceFingerprint([file('files/index.html', 120, '2026-08-25T10:05:00Z')])
  assert.notEqual(before, after)
})

test('sourceFingerprint changes when a file is added or removed', () => {
  const one = sourceFingerprint([file('files/index.html', 120, '2026-08-25T10:00:00Z')])
  const two = sourceFingerprint([
    file('files/index.html', 120, '2026-08-25T10:00:00Z'),
    file('files/about.html', 90, '2026-08-25T10:01:00Z'),
  ])
  assert.notEqual(one, two)
})

test('sourceFingerprint is null when the listing carries no stat metadata', () => {
  // The offline-derived listing shape: name/path/type only. Comparing those
  // would report "unchanged" for an edit, so it must be unusable instead.
  assert.equal(sourceFingerprint([{ path: 'files/index.html', type: 'file' }]), null)
  assert.equal(sourceFingerprint(null), null)
})

test('sourceNeedsBuild builds on a changed tree and on a never-built project', () => {
  assert.equal(sourceNeedsBuild('a', 'b'), true)
  assert.equal(sourceNeedsBuild('a', null), true)
})

test('sourceNeedsBuild refuses an unchanged tree and an unreadable one', () => {
  assert.equal(sourceNeedsBuild('a', 'a'), false)
  // null = "cannot tell". Building on a guess would take the app-wide build
  // slot away from a real build.
  assert.equal(sourceNeedsBuild(null, 'a'), false)
  assert.equal(sourceNeedsBuild(null, null), false)
})
