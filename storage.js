import { useEffect, useState } from 'react'
import {
  CHAT_OPEN_VERSION,
  CHAT_RATIO_VERSION,
  FILE_CACHE_VERSION,
  FILE_CONTENT_CACHE_LIMIT,
} from './constants.js'
import {
  cleanIndexPaths,
  isManagedJsonPath,
  isSafeProjectId,
  normalizeFileCacheSnapshot,
  prefixedPath,
} from './domain.js'

export function makeStorage(appId, token) {
  const ms = (typeof window !== 'undefined' && window.mobius && window.mobius.storage) || null
  const hasRuntime = !!ms
  async function get(path) {
    // Read with the TYPED getter matching how the path was written: only the
    // app's OWN metadata (isManagedJsonPath — files-index/main/chat_id/build)
    // holds typed JSON (get); everything else, including a user's editable
    // files/*.json source, is raw text (getText). Keying on the extension alone
    // routed user .json through the JSON getter while it was written as text,
    // an assertReadKind wrong-kind read that made those files uneditable.
    if (ms) {
      const isJson = isManagedJsonPath(path)
      if (isJson && typeof ms.get === 'function') return ms.get(path)
      if (!isJson && typeof ms.getText === 'function') return ms.getText(path)
    }
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`get ${path} → ${r.status}`)
    const ct = r.headers.get('content-type') || ''
    if (ct.includes('application/json')) return r.json()
    return r.text()
  }
  async function getFresh(path) {
    // Direct server read. The runtime getter is cache-first for offline
    // work, which is what we want during editing, but a server-side agent can
    // update the same file behind that mirror. This path asks the backend for
    // the canonical bytes so the editor and the file on disk converge online.
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`get ${path} → ${r.status}`)
    const ct = r.headers.get('content-type') || ''
    if (ct.includes('application/json')) return r.json()
    return r.text()
  }
  async function getText(path) {
    // Like get(), but always returns text (never parses JSON). Used by the
    // preview to fetch the built HTML/CSS/JS bytes verbatim — a build/site
    // .json asset must come back as its raw source, not a parsed object.
    if (ms && typeof ms.getText === 'function') return ms.getText(path)
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`getText ${path} → ${r.status}`)
    return r.text()
  }
  async function getBlob(path) {
    if (ms && typeof ms.getBlob === 'function') return ms.getBlob(path)
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) return null
    return r.blob()
  }
  async function setText(path, text) {
    // Write through the runtime's TYPED text writer — ms.set is the JSON writer
    // (sends application/json + JSON.stringify), which corrupts/400s a .html or
    // build/target.txt save. ms.setText sends raw UTF-8 (text/plain). An older
    // runtime without setText falls through to the direct fetch below, which
    // also sends text/plain — so both paths agree on the wire shape.
    if (ms && typeof ms.setText === 'function') return ms.setText(path, text)
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: text,
    })
    if (!r.ok) throw new Error(`set ${path} → ${r.status}`)
    return { synced: true }
  }
  async function setBlob(path, blob, options = {}) {
    if (ms && typeof ms.setBlob === 'function') return ms.setBlob(path, blob, options)
    const contentType = options.contentType || (blob && blob.type) || 'application/octet-stream'
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body: blob,
    })
    if (!r.ok) throw new Error(`set ${path} → ${r.status}`)
    return { synced: true }
  }
  async function setJSON(path, obj) {
    if (ms && typeof ms.set === 'function') return ms.set(path, obj)
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    })
    if (!r.ok) throw new Error(`set ${path} → ${r.status}`)
    return { synced: true }
  }
  async function remove(path) {
    if (ms && typeof ms.remove === 'function') return ms.remove(path)
    const r = await fetch(`/api/storage/apps/${appId}/${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok && r.status !== 404) throw new Error(`remove ${path} → ${r.status}`)
    return { synced: true }
  }
  async function move(from, to) {
    const r = await fetch(`/api/storage/apps/${appId}/move`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    })
    if (!r.ok) {
      let detail = ''
      try { detail = (await r.json()).detail || '' } catch { /* non-JSON */ }
      const err = new Error(`move ${from} → ${to} → ${r.status}${detail ? `: ${detail}` : ''}`)
      err.status = r.status
      err.detail = detail
      throw err
    }
    return { synced: true }
  }
  async function removeFolder(path) {
    const r = await fetch(`/api/storage/apps/${appId}/folder/${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok && r.status !== 404) {
      let detail = ''
      try { detail = (await r.json()).detail || '' } catch { /* non-JSON */ }
      const err = new Error(`remove folder ${path} → ${r.status}${detail ? `: ${detail}` : ''}`)
      err.status = r.status
      err.detail = detail
      throw err
    }
    return { synced: true }
  }
  async function list(prefix = '') {
    const out = []
    let cursor = null
    do {
      const qs = new URLSearchParams({ limit: '500' })
      if (cursor) qs.set('cursor', cursor)
      const r = await fetch(`/api/storage/apps-list/${appId}/${prefix}?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) throw new Error(`list ${prefix} → ${r.status}`)
      const data = await r.json()
      out.push(...(Array.isArray(data.entries) ? data.entries : []))
      cursor = data.next_cursor || null
    } while (cursor)
    return out
  }
  async function pendingCount() {
    if (ms && typeof ms.pendingCount === 'function') {
      try { return await ms.pendingCount() } catch { return 0 }
    }
    return 0
  }
  function subscribeText(path, cb) {
    if (ms && typeof ms.subscribeText === 'function') return ms.subscribeText(path, cb)
    return () => {}
  }
  return {
    get, getFresh, getText, getBlob,
    setText, setBlob, setJSON, remove,
    move, removeFolder, list,
    subscribeText,
    pendingCount,
    hasRuntime,
  }
}

export function scopedStorage(storage, prefix) {
  const p = prefix || ''
  return {
    get: (path) => storage.get(prefixedPath(p, path)),
    getFresh: (path) => storage.getFresh(prefixedPath(p, path)),
    getText: (path) => storage.getText(prefixedPath(p, path)),
    getBlob: (path) => storage.getBlob(prefixedPath(p, path)),
    setText: (path, text) => storage.setText(prefixedPath(p, path), text),
    setBlob: (path, blob, options) => storage.setBlob(prefixedPath(p, path), blob, options),
    setJSON: (path, obj) => storage.setJSON(prefixedPath(p, path), obj),
    remove: (path) => storage.remove(prefixedPath(p, path)),
    move: (from, to) => storage.move(prefixedPath(p, from), prefixedPath(p, to)),
    removeFolder: (path) => storage.removeFolder(prefixedPath(p, path)),
    list: (path = '') => storage.list(prefixedPath(p, path)),
    subscribeText: (path, cb) => storage.subscribeText(prefixedPath(p, path), cb),
    pendingCount: () => storage.pendingCount(),
    hasRuntime: storage.hasRuntime,
  }
}

// ----------------------------------------------------------------------
// Image preview. The storage API requires a bearer token, so we
// fetch the file as a blob and convert to an object URL — <img src>
// can't carry an Authorization header.

export function useOnline() {
  const [online, setOnline] = useState(() => {
    const m = typeof window !== 'undefined' ? window.mobius : null
    // Prefer the Mobius runtime's own connectivity view for the first paint —
    // it gates reads, builds, and the offline pill — falling back to the
    // browser's navigator.onLine when the runtime isn't present.
    if (m && typeof m.online === 'boolean') return m.online
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false
  })
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const m = window.mobius
    // Subscribe to the runtime's connectivity change hook when it exists (a
    // future runtime may expose one); today window.mobius.online is a getter
    // over navigator.onLine with no change event, so the browser online/offline
    // events remain the live signal and the reliable fallback.
    let unsub = null
    if (m && typeof m.onOnlineChange === 'function') {
      try {
        unsub = m.onOnlineChange((v) => setOnline(
          typeof v === 'boolean' ? v : navigator.onLine !== false,
        ))
      } catch { unsub = null }
    }
    const sync = () => setOnline(
      m && typeof m.online === 'boolean' ? m.online : navigator.onLine !== false,
    )
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
      try { unsub?.() } catch { /* ignore */ }
    }
  }, [])
  return online
}

// ----------------------------------------------------------------------
// In-app modal. Möbius mini-apps run in an iframe with the `allow-modals`
// sandbox token deliberately excluded, so window.alert/.confirm/.prompt
// silently no-op and return false. We render our own modal instead.

export function activeProjectKey(appId) {
  return `webstudio:${appId}:activeProject`
}

export function readActiveProject(appId) {
  if (typeof localStorage === 'undefined') return 'default'
  try {
    const stored = localStorage.getItem(activeProjectKey(appId))
    return isSafeProjectId(stored) ? stored : 'default'
  } catch {
    return 'default'
  }
}

export function writeActiveProject(appId, id) {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(activeProjectKey(appId), id) } catch {}
}

export function fileCacheKey(appId, projectId = 'default') {
  if (projectId === 'default') return `webstudio:${appId}:files-cache:v${FILE_CACHE_VERSION}`
  return `webstudio:${appId}:project:${projectId}:files-cache:v${FILE_CACHE_VERSION}`
}

export function chatOpenKey(appId) {
  return `webstudio:${appId}:chat-open:v${CHAT_OPEN_VERSION}`
}

export function chatRatioKey(appId) {
  return `webstudio:${appId}:chat-ratio:v${CHAT_RATIO_VERSION}`
}

export function readChatOpen(appId) {
  if (typeof localStorage === 'undefined') return false
  try {
    const raw = localStorage.getItem(chatOpenKey(appId))
    if (raw === null) return false
    return JSON.parse(raw) === true
  } catch { return false }
}

export function readChatRatio(appId) {
  if (typeof localStorage === 'undefined') return 0.5
  const raw = Number(localStorage.getItem(chatRatioKey(appId)))
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) return 0.5
  return raw
}

export function readFileCache(appId, projectId = 'default') {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(fileCacheKey(appId, projectId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return normalizeFileCacheSnapshot(parsed)
  } catch {
    return null
  }
}

export function writeFileCache(appId, projectId, index, contents, lastPath) {
  if (typeof localStorage === 'undefined') return
  try {
    const safeIndex = cleanIndexPaths(index)
    const trimmed = {}
    const indexSet = new Set(safeIndex)
    const entries = Object.entries(contents)
      .filter(([p, v]) => indexSet.has(p) && typeof v === 'string')
      .slice(-FILE_CONTENT_CACHE_LIMIT)
    for (const [p, v] of entries) trimmed[p] = v
    localStorage.setItem(
      fileCacheKey(appId, projectId),
      JSON.stringify({
        index: safeIndex,
        contents: trimmed,
        lastPath: (lastPath && indexSet.has(lastPath)) ? lastPath : null,
      }),
    )
  } catch {
    // Quota / disabled / serialization — leave the previous snapshot in place.
  }
}

export function removeFileCache(appId, projectId) {
  if (typeof localStorage === 'undefined') return
  try { localStorage.removeItem(fileCacheKey(appId, projectId)) } catch {}
}
