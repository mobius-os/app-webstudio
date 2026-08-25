import {
  BINARY_FILE_EXTS,
  DEFAULT_PROJECT,
  IMAGE_PREVIEW_EXTS,
  NAME_RE,
  NOTE_LABEL_MAX_CHARS,
  NOTE_MAX_CHARS,
  NOTES_MAX,
  PROJECT_ID_RE,
} from './constants.js'

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
  'projects.json',
  // Page notes are written by the pin UI, not typed by hand — same class as
  // main.json. Leaving it editable would let a stray keystroke in the editor
  // desync the pins from what the agent is about to be told.
  'comments.json',
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

// ---- Auto-build change detection ----------------------------------------
// The embedded agent edits files/ directly; nothing about that write reaches
// this app except through storage. To decide whether an agent turn (or an
// autosave) left the preview stale we fingerprint the SOURCE tree and compare
// it against the fingerprint taken when the last build was adopted.
//
// `entries` are apps-list rows ({path, type, size, modified_at}). Directories
// carry no bytes, so only files contribute. Returns null when the tree cannot
// be fingerprinted — a file whose size AND modified_at are both missing (the
// offline-derived listing shape) makes the comparison meaningless, and a null
// fingerprint must be read as "cannot tell", never as "unchanged".
export function sourceFingerprint(entries) {
  if (!Array.isArray(entries)) return null
  const parts = []
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string') continue
    if (entry.type === 'directory') continue
    if (!isSafeStoragePath(entry.path)) continue
    const size = Number.isFinite(entry.size) ? entry.size : null
    const stamp = entry.modified_at == null ? null : String(entry.modified_at)
    if (size === null && stamp === null) return null
    parts.push(`${entry.path}|${size === null ? '' : size}|${stamp || ''}`)
  }
  // Listing order is per-directory and the walk order is not guaranteed stable
  // across calls; sort so an unchanged tree always fingerprints identically.
  return parts.sort().join('\n')
}

// Whether an agent turn (or a pending autosave) left the built site stale.
// `built` is the fingerprint captured when the current preview's build was
// adopted; null means nothing has been built for this project yet, which IS a
// reason to build. An unreadable current fingerprint is never a reason to
// build — we would be guessing, and a wrong guess takes the app-wide build
// slot away from a real build.
export function sourceNeedsBuild(current, built) {
  if (current === null) return false
  return current !== built
}

// ---- Build dispatch (app-wide single-slot serialization) ----------------
// /run-job carries no project context, so build.sh reads ONE shared root
// build/target.txt and there is one build slot per app. These predicates make
// the claim/supersede decisions pure and testable; useBuild wires them to
// fresh server reads.

// The pre-check that lets a build refuse when ANOTHER page is already building.
// A claim blocks only when it is a well-formed, still-fresh claim for a
// DIFFERENT target — a same-target claim is harmless (both builds converge on
// the same output) and a stale claim (older than the timeout) has aged out.
export function foreignClaimBlocks(claim, myTarget, now, timeoutMs) {
  if (!claim || typeof claim !== 'object') return false
  if (typeof claim.target !== 'string' || !claim.target || claim.target === myTarget) return false
  if (!Number.isFinite(claim.at)) return false
  return (now - claim.at) < timeoutMs
}

// After writing our own claim we read it back: it is OURS only when the
// read-back target still matches. A different target means another instance
// overwrote our claim in the settle window and won the slot (last write wins).
export function claimIsOurs(readback, myTarget) {
  return !!readback && typeof readback === 'object' && readback.target === myTarget
}

// The poller's fail-fast check: has the shared root build/target.txt stopped
// naming OUR build? A different, NON-EMPTY target means a concurrent build took
// the slot and our verdict will never land — stop now instead of waiting out
// the full timeout. An empty/missing/non-string target (never written yet, or a
// transient read) is NOT a supersede.
export function buildTargetSuperseded(rootTarget, myTarget) {
  if (typeof rootTarget !== 'string') return false
  const seen = rootTarget.trim()
  if (!seen) return false
  return seen !== myTarget
}

export function cleanIndexPaths(paths) {
  return [...new Set((paths || []).filter(isSafeStoragePath))].sort()
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

// ---- Page notes ---------------------------------------------------------
// A note is one short instruction the user pinned to an element in the
// Preview. It carries enough to find that element again in SOURCE: the
// selector the injected script derived from the built page, plus the tag and
// a text snippet as a human-readable fallback. The built site is a verbatim
// copy of files/, so a selector on the built page addresses the same element
// in the source file — that equivalence is what makes a pin actionable.

function cleanNoteText(value) {
  // Collapse whitespace: a note travels into a numbered list in the agent
  // message, and an embedded newline would break that list apart.
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return text.slice(0, NOTE_MAX_CHARS)
}

export function noteLabel(tag, text) {
  const name = String(tag || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20)
  const snippet = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  if (!name) return snippet.slice(0, NOTE_LABEL_MAX_CHARS)
  if (!snippet) return `<${name}>`
  const short = snippet.length > NOTE_LABEL_MAX_CHARS
    ? `${snippet.slice(0, NOTE_LABEL_MAX_CHARS - 1)}…`
    : snippet
  return `<${name}> "${short}"`
}

// One stored note, or null when the pick/text can't make a usable one. Never
// throws: this runs on a postMessage payload from the sandboxed preview,
// which is untrusted input even though we injected the script that sends it.
export function makeNote(pick, text, id) {
  const body = cleanNoteText(text)
  if (!body) return null
  const source = pick && typeof pick === 'object' ? pick : {}
  const selector = typeof source.selector === 'string' ? source.selector.slice(0, 400) : ''
  if (!selector) return null
  return {
    id: String(id || ''),
    selector,
    label: noteLabel(source.tag, source.text),
    // Collapsed here too, not just in the injected script: this arrives by
    // postMessage and is untrusted, and a newline would break the one-line-
    // per-note shape composeNotesMessage builds.
    html: typeof source.html === 'string'
      ? source.html.replace(/\s+/g, ' ').trim().slice(0, 300)
      : '',
    page: sourcePageForBuilt(source.page),
    note: body,
  }
}

// build/site/about.html -> files/about.html. The preview reports the BUILT
// path it navigated to; the agent edits source, so a note has to name the
// source file or a multi-page site sends it to edit the wrong one.
export function sourcePageForBuilt(page) {
  const value = typeof page === 'string' ? page : ''
  if (!value.startsWith('build/site/')) return ''
  const rel = value.slice('build/site/'.length)
  return rel ? `files/${rel}` : ''
}

// Drop anything malformed and enforce the cap. Used on every read of
// comments.json — the file is app metadata, but another tab or a hand-edit
// can still put junk in it, and a bad entry must not break the pin overlay.
export function normalizeNotes(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) continue
    if (typeof entry.selector !== 'string' || !entry.selector) continue
    const note = cleanNoteText(entry.note)
    if (!note) continue
    seen.add(entry.id)
    out.push({
      id: entry.id,
      selector: entry.selector.slice(0, 400),
      label: typeof entry.label === 'string' ? entry.label.slice(0, 200) : '',
      html: typeof entry.html === 'string'
        ? entry.html.replace(/\s+/g, ' ').trim().slice(0, 300) : '',
      page: typeof entry.page === 'string' ? entry.page : '',
      note,
    })
    if (out.length >= NOTES_MAX) break
  }
  return out
}

// The message the batch becomes. Numbered so the agent can work through it and
// report per item, and explicit that each note names a real element — a bare
// list of wishes reads as one vague request and gets one vague change.
export function composeNotesMessage(notes, mainPath) {
  const list = normalizeNotes(notes)
  if (list.length === 0) return ''
  // Only claim a single page when every note actually sits on it. A preview
  // can navigate between pages mid-session, and naming the wrong file is worse
  // than naming none — the agent would edit a page the user never annotated.
  const pages = new Set(list.map((entry) => entry.page).filter(Boolean))
  const single = pages.size === 1 ? [...pages][0] : (pages.size === 0 ? mainPath : '')
  const where = single ? ` on ${single}` : ''
  const head = list.length === 1
    ? `I left a note${where}. Apply it:`
    : `I left ${list.length} notes${where}. Apply each one:`
  const lines = list.map((entry, i) => {
    const label = entry.label ? `${entry.label} — ` : ''
    // Name the file per item when the batch spans pages.
    const file = (!single && entry.page) ? `\n   in: ${entry.page}` : ''
    // The markup is the primary locator. The selector follows only as a
    // fallback hint, explicitly demoted below, because a path derived from the
    // BUILT page goes stale as soon as the source gains a sibling element.
    const markup = entry.html ? `\n   element: ${entry.html}` : ''
    const hint = entry.html ? '' : `\n   selector hint: ${entry.selector}`
    return `${i + 1}. ${label}${entry.note}${file}${markup}${hint}`
  })
  return [
    head,
    '',
    ...lines,
    '',
    'Find each element yourself in the source file — by its markup or its text '
      + '— and make the change there. The `element:` line is the markup as it '
      + 'renders, so it may differ from the source if the page is generated; '
      + 'treat it as a description of what I clicked, not as an exact string to '
      + 'match. Then rebuild.',
  ].join('\n')
}

// Can the user pin a note right now? This MIRRORS renderMain's branches, and
// the mirroring is the whole point: "the preview is visible" is not the same
// as viewMode === 'preview'. On a wide screen the split renders the preview
// beside the editor while viewMode stays 'source' — the Source/Preview toggle
// only exists on narrow layouts. Gating on viewMode alone hides the note
// button on every desktop layout, which is exactly the bug this replaces.
//
// `hasBuiltEntry` is the last condition because a pin needs a rendered page:
// without a successful build the preview pane is a placeholder, and
// annotating a placeholder means nothing.
export function annotatablePreview({
  selectedPath,
  selectedExt,
  isWide,
  mainPath,
  viewMode,
  hasBuiltEntry,
}) {
  if (!selectedPath || !hasBuiltEntry) return false
  if (IMAGE_PREVIEW_EXTS.has(String(selectedExt || '').toLowerCase())) return false
  // Wide: editor + preview side by side for ANY text file, viewMode ignored.
  if (isWide && mainPath && isTextProjectPath(selectedPath)) return true
  // Narrow: one pane, and the preview is only offered on the main page.
  return selectedPath === mainPath && viewMode === 'preview'
}
