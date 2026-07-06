import { BINARY_FILE_EXTS, DEFAULT_PROJECT, NAME_RE, PROJECT_ID_RE } from './constants.js'

export const projectPrefix = (id) => (id === 'default' ? '' : `projects/${id}/`)

export function isSafeProjectId(id) {
  return typeof id === 'string' && PROJECT_ID_RE.test(id)
}

export function prefixedPath(prefix, path) {
  return `${prefix || ''}${path}`
}

export function isSafeRelPath(path) {
  const value = typeof path === 'string' ? path.trim() : ''
  if (!value || value.startsWith('/') || value.includes('\\')) return false
  if (!NAME_RE.test(value)) return false
  const parts = value.split('/')
  // Reject a leading dash in any segment: build.sh treats a leading-dash target
  // as a CLI flag and refuses it, so allowing it here would create a file the
  // app shows + lets you set as main but can never build (opaque error).
  return parts.every((part) => part && part !== '.' && part !== '..' && !part.startsWith('-'))
}

export function isSafeStoragePath(path) {
  return typeof path === 'string'
    && path.startsWith('files/')
    && isSafeRelPath(path.slice('files/'.length))
}
export function extensionFor(path) {
  return String(path || '').split('.').pop().toLowerCase()
}

export function isBinaryProjectPath(path) {
  return BINARY_FILE_EXTS.has(extensionFor(path))
}

export function isTextProjectPath(path) {
  return isSafeStoragePath(path)
    && !path.endsWith('/.keep')
    && !isBinaryProjectPath(path)
}

// The app's OWN metadata files are stored as typed JSON (envelope-free): every
// reader loads them with the JSON getter, which throws assertReadKind if they
// were written as text/plain. Everything the USER creates lives under files/
// and is editable text-or-binary — a user's files/data.json is SOURCE, not
// typed JSON, so it round-trips through getText/setText like any other source
// file and is freely editable. This predicate marks ONLY the app's own
// metadata, so the editor leaves those read-only and the storage layer routes
// them through the JSON getter; a user .json is neither. It matches on the name
// after stripping an optional projects/<id>/ scope prefix, so the storage layer
// (root-prefixed paths) and the editor (scoped paths) agree on the kind.
const MANAGED_JSON_NAMES = new Set([
  'files-index.json',
  'main.json',
  'chat_id.json',
  'build/status.json',
  'build/dispatch.json',
])
export function isManagedJsonPath(path) {
  const rel = String(path || '').replace(/^projects\/[A-Za-z0-9_-]+\//, '')
  return MANAGED_JSON_NAMES.has(rel)
}

// Is `path` an HTML entry the user could build? The Web Studio equivalent of
// LaTeX's `.tex` predicate. Build always assembles the whole site, but the
// "main" file is the HTML page the preview renders, so the settable main is
// restricted to .html/.htm files.
export function isHtmlDoc(path) {
  if (!isSafeStoragePath(path)) return false
  return path.endsWith('.html') || path.endsWith('.htm')
}

// First file to open when nothing is selected yet. The main page wins over
// alphabetical order: showHtmlControls requires selectedPath === mainPath,
// so opening anything else (e.g. files/about/index.html, which sorts before
// files/index.html) would hide the Build/Preview controls on first load.
// Then any HTML page, any editable text file, any non-placeholder entry.
export function pickAutoSelectPath(files, mainPath) {
  if (mainPath && files.includes(mainPath)) return mainPath
  return files.find((p) => isHtmlDoc(p))
    || files.find((p) => isTextProjectPath(p))
    || files.find((p) => !p.endsWith('/.keep'))
    || null
}

// Resolve a successful build's entry path for a given main doc. The build
// writes the rendered site under build/site/, mirroring the files/ tree, so
// the entry for files/index.html is build/site/index.html. We honour the
// status verdict's own `entry` when it targets the doc we asked for; otherwise
// we fall back to the deterministic path so a restored build still resolves.
export function entryFromBuildStatusForDoc(status, doc) {
  if (!status || typeof status !== 'object') return null
  if (status.status !== 'done') return null
  if (!isHtmlDoc(doc)) return null
  if (status.target && status.target !== doc) return null
  if (typeof status.entry === 'string' && status.entry.startsWith('build/site/')) {
    return status.entry
  }
  return null
}

// Deterministic entry path for a main HTML doc (files/index.html ->
// build/site/index.html). Used to restore a preview when the status verdict
// predates the `entry` field, or to probe whether a prior build exists.
export function entryPathForHtmlDoc(doc) {
  if (!isHtmlDoc(doc)) return null
  return `build/site/${doc.slice('files/'.length)}`
}

export function cleanIndexPaths(paths) {
  return [...new Set((paths || []).filter(isSafeStoragePath))].sort()
}

export function normalizeFileCacheSnapshot(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const index = cleanIndexPaths(parsed.index)
  const indexSet = new Set(index)
  const contents = {}
  const rawContents = (parsed.contents && typeof parsed.contents === 'object')
    ? parsed.contents : {}
  for (const [path, body] of Object.entries(rawContents)) {
    if (indexSet.has(path) && typeof body === 'string') contents[path] = body
  }
  const lastPath = (typeof parsed.lastPath === 'string' && indexSet.has(parsed.lastPath))
    ? parsed.lastPath : null
  return { index, contents, lastPath }
}

export function buildTree(paths) {
  // Each node: { name, path, children: Map, isFile }
  const root = { name: '', path: '', children: new Map(), isFile: false }
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    parts.forEach((seg, i) => {
      const last = i === parts.length - 1
      if (!node.children.has(seg)) {
        node.children.set(seg, {
          name: seg,
          path: parts.slice(0, i + 1).join('/'),
          children: new Map(),
          isFile: last,
        })
      } else if (last) {
        node.children.get(seg).isFile = true
      }
      node = node.children.get(seg)
    })
  }
  return root
}

// File-type kind for the tree glyph. The glyph itself is a bare lucide-style
// SVG (see FileGlyph) — the kind only selects which inner mark it draws.
export function fileKind(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (lower.endsWith('.css')) return 'css'
  if (lower.match(/\.(js|mjs|ts|jsx|tsx)$/)) return 'code'
  if (lower.endsWith('.json')) return 'json'
  if (lower.match(/\.(png|jpe?g|gif|webp|svg|ico)$/)) return 'image'
  return 'file'
}

// Bare lucide-style file glyph for the tree (fill none, currentColor stroke,
// round caps — the shared Möbius icon idiom). No bounding box / fill / boxed
// padding: it inherits the row's text color exactly like the shell's icons.
// Each kind draws the lucide "document" outline plus a small inner mark so the

export function clampChatRatio(desiredPx, total, minPx) {
  if (!(total > 0)) return 0.5
  const floor = minPx
  const ceil = total - minPx
  // Body too short to honor both floors: split evenly rather than clip a pill.
  if (ceil <= floor) return 0.5
  const px = Math.max(floor, Math.min(ceil, desiredPx))
  return px / total
}

export function normalizeProjects(raw) {
  if (!Array.isArray(raw)) return null
  const seen = new Set()
  const projects = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = item.id === 'default' ? 'default' : (isSafeProjectId(item.id) ? item.id : null)
    if (!id || seen.has(id)) continue
    const name = String(item.name || '').trim() || (id === 'default' ? 'Project 1' : id)
    const createdAt = Number.isFinite(item.createdAt) ? item.createdAt : Date.now()
    seen.add(id)
    projects.push({ id, name, createdAt })
  }
  if (!seen.has('default')) {
    projects.unshift({ id: DEFAULT_PROJECT.id, name: DEFAULT_PROJECT.name, createdAt: Date.now() })
  }
  return projects
}

export function projectSlug(name, existingIds) {
  const base = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    || 'project'
  let id = base
  while (!isSafeProjectId(id) || existingIds.has(id)) {
    const suffix = Math.random().toString(36).slice(2, 8)
    id = `${base.slice(0, Math.max(1, 63 - suffix.length))}-${suffix}`.slice(0, 64)
  }
  return id
}

export async function deleteStorageTree(storage, prefix) {
  if (!prefix) throw new Error('deleteStorageTree: refusing empty prefix (would wipe app root)')
  const entries = await storage.list(prefix)
  for (const entry of entries) {
    if (entry.type === 'directory') await deleteStorageTree(storage, entry.path)
    else if (entry.type === 'file') await storage.remove(entry.path)
  }
  await storage.removeFolder(prefix.replace(/\/+$/, '')).catch(() => {})
}

// ----------------------------------------------------------------------
