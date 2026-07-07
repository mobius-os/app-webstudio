// Web Studio — thin app shell. The module tree is declared in mobius.json's
// source_files; the multi-file installer fetches each path and esbuild bundles
// from this entry, resolving the relative imports below at compile time.
//
//   constants.js              — shared scalar constants for storage, preview, chat, and polling
//   theme.js                  — the single app stylesheet (CSS)
//   domain.js                 — pure + DOM-level path, project, tree, build-entry, and chat helpers
//   storage.js                — storage shim, project wrapper, online signal, and local snapshots
//   preview/previewDomain.js  — pure preview URL policy, injected nav script, and retry helper
//   preview/HtmlPreview.jsx   — sandboxed iframe preview renderer
//   build/useBuild.js         — source-to-site build state machine and poll loop
//   ui/*.jsx                  — one React component or icon per file
//
// Only App lives here: it owns top-level project/file/editor/build/chat state,
// persistence wiring, and mounts the source/preview/file/chat UI.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { signal } from './analytics.js'
import {
  CHAT_PANE_MIN_PX,
  DEFAULT_PROJECT,
  PROJECT_SYNC_MS,
  SOURCE_AUTOSAVE_MS,
  SOURCE_SYNC_MS,
} from './constants.js'
import { CSS } from './theme.js'
import {
  cleanIndexPaths,
  clampChatRatio,
  deleteStorageTree,
  entryPathForHtmlDoc,
  extensionFor,
  isBinaryProjectPath,
  isHtmlDoc,
  isManagedJsonPath,
  isSafeProjectId,
  isSafeRelPath,
  isSafeStoragePath,
  isTextProjectPath,
  normalizeProjects,
  pickAutoSelectPath,
  projectPrefix,
  projectSlug,
} from './domain.js'
import {
  chatOpenKey,
  chatRatioKey,
  makeStorage,
  readActiveProject,
  readChatOpen,
  readChatRatio,
  readFileCache,
  removeFileCache,
  scopedStorage,
  useOnline,
  writeActiveProject,
  writeFileCache,
} from './storage.js'
import { useBuild } from './build/useBuild.js'
import { HtmlPreview } from './preview/HtmlPreview.jsx'
import { BuildingIndicator } from './ui/BuildingIndicator.jsx'
import { ChatBubbleIcon } from './ui/ChatBubbleIcon.jsx'
import { ChatPanel } from './ui/ChatPanel.jsx'
import { CodeEditor } from './ui/CodeEditor.jsx'
import { CodeIcon } from './ui/CodeIcon.jsx'
import { EyeIcon } from './ui/EyeIcon.jsx'
import { FileNavPanel } from './ui/FileNavPanel.jsx'
import { ImagePreview } from './ui/ImagePreview.jsx'
import { PlayIcon } from './ui/PlayIcon.jsx'
import { SyncPill } from './ui/SyncPill.jsx'
import { useModal } from './ui/useModal.jsx'

export {
  clampChatRatio,
  entryFromBuildStatusForDoc,
  entryPathForHtmlDoc,
  isHtmlDoc,
  isManagedJsonPath,
  isSafeRelPath,
  isSafeStoragePath,
  normalizeFileCacheSnapshot,
  pickAutoSelectPath,
  projectPrefix,
} from './domain.js'
export {
  anchorActionFor,
  readWithRetry,
  resolveSiteAsset,
  WS_PREVIEW_NAV_SCRIPT,
} from './preview/previewDomain.js'

export default function App({ appId, token }) {
  const rootStorage = useMemo(() => makeStorage(appId, token), [appId, token])
  const [activeProjectId, setActiveProjectId] = useState(() => readActiveProject(appId))
  const activePrefix = useMemo(() => projectPrefix(activeProjectId), [activeProjectId])
  const storage = useMemo(() => scopedStorage(rootStorage, activePrefix), [rootStorage, activePrefix])
  const online = useOnline()
  const rawModal = useModal()
  const bodyRef = useRef(null)
  const cached = useMemo(() => readFileCache(appId, activeProjectId), [appId, activeProjectId])
  const [projects, setProjects] = useState([])
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [files, setFiles] = useState(() => cached?.index || [])
  const filesRef = useRef(files)
  const [fileCache, setFileCache] = useState(() => cached?.contents || {})
  const [indexLoaded, setIndexLoaded] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const navHandleRef = useRef(null)
  const navOpenRef = useRef(false)
  useEffect(() => { navOpenRef.current = navOpen }, [navOpen])
  const openNavRef = useRef(null)
  // Modals ride the shell's single-surface nav, which closes the drawer when a
  // modal opens. Wrap the modal API once so any prompt/confirm/alert/choose
  // re-opens the drawer afterward if it was open — e.g. cancelling a rename
  // returns to the drawer instead of leaving it closed.
  const modal = useMemo(() => {
    const wrap = (name) => (...args) => {
      const wasOpen = navOpenRef.current
      return Promise.resolve(rawModal[name](...args)).finally(() => {
        if (wasOpen && openNavRef.current) openNavRef.current()
      })
    }
    return { node: rawModal.node, alert: wrap('alert'), confirm: wrap('confirm'), prompt: wrap('prompt'), choose: wrap('choose') }
  }, [rawModal])
  const navToggleRef = useRef(null)
  const [selectedPath, setSelectedPath] = useState(() => cached?.lastPath || null)
  const selectedPathRef = useRef(selectedPath)
  useEffect(() => { selectedPathRef.current = selectedPath }, [selectedPath])
  const [fileContent, setFileContent] = useState('')
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState(null)
  const [fileDirty, setFileDirty] = useState(false)
  const [fileSaving, setFileSaving] = useState(false)
  const fileContentRef = useRef(fileContent)
  const fileDirtyRef = useRef(fileDirty)
  const fileSavingRef = useRef(fileSaving)
  // The in-flight autosave write, so flushDirtyEdits can AWAIT it (not poll a flag).
  const savePromiseRef = useRef(null)
  // Holds the armed autosave setTimeout id so discardAndSelect can CANCEL it
  // synchronously — deleting the open file must not let a pending autosave fire
  // storage.setText and RECREATE the file we just removed.
  const autosaveTimerRef = useRef(null)
  // Forward handle to switchFile (defined far below, after its flush deps). Lets
  // the earlier create handler route selection through the one canonical
  // flush-then-select path without a temporal-dead-zone reference.
  const switchFileRef = useRef(null)
  useEffect(() => { fileContentRef.current = fileContent }, [fileContent])
  useEffect(() => { fileDirtyRef.current = fileDirty }, [fileDirty])
  useEffect(() => { fileSavingRef.current = fileSaving }, [fileSaving])
  // Select `path` while DISCARDING the outgoing file's pending edits — the
  // mirror of switchFile for the DELETE case. switchFile flushes the old buffer
  // (saves it); a just-deleted file must NOT be flushed (that would recreate
  // it). Cancel the armed autosave and drop the dirty/saving flags (refs +
  // state) synchronously so neither the load effect nor a stray timer writes the
  // dead buffer under the newly-selected path, then select.
  const discardAndSelect = useCallback((path) => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
    fileDirtyRef.current = false
    fileSavingRef.current = false
    setFileDirty(false)
    setFileSaving(false)
    setSelectedPath(path)
  }, [])
  const [chatOpen, setChatOpen] = useState(() => readChatOpen(appId))
  const [chatRatio, setChatRatio] = useState(() => readChatRatio(appId))
  const [publishedUrl, setPublishedUrl] = useState(null)
  const [publishing, setPublishing] = useState(false)
  const publishingRef = useRef(false)
  // Bumped on every publish/unpublish; the restore effect captures it and skips
  // its async setState if a newer publish/unpublish landed meanwhile (#7).
  const publishEpochRef = useRef(0)
  useEffect(() => { publishingRef.current = publishing }, [publishing])
  // Viewer mode, toggled by the [Source | Preview] segmented control. 'source'
  // shows the editable CodeMirror source; 'preview' shows the MAIN page's built site.
  const [viewMode, setViewMode] = useState('source')
  // The designated MAIN page — the HTML the Preview renders. Persisted in
  // main.json and defaulted (below) to the first .html (preferring
  // files/index.html). null until the index loads + a default is resolved.
  const [mainPath, setMainPath] = useState(null)
  const [mainReady, setMainReady] = useState(false)
  const mainPathRef = useRef(null)
  useEffect(() => { mainPathRef.current = mainPath }, [mainPath])
  const mainResolvedRef = useRef(false)
  const build = useBuild({ appId, token, storage, rootStorage, prefix: activePrefix, online })
  const clearBuildPoll = build.clearPoll
  const seenBuildStatusRef = useRef('')
  const hydratedProjectRef = useRef(activeProjectId)
  // Fires app_ready exactly once, after the first real hydration completes.
  const appReadyRef = useRef(false)
  const readFreshProjects = useCallback(async () => {
    try {
      const stored = await rootStorage.getFresh('projects.json')
      const fresh = normalizeProjects(stored)
      if (fresh && fresh.length > 0) return fresh
    } catch {
      // Fall through to the in-memory list, then the seeded default.
    }
    const fallback = normalizeProjects(projects)
    if (fallback && fallback.length > 0) return fallback
    return [{ id: DEFAULT_PROJECT.id, name: DEFAULT_PROJECT.name, createdAt: Date.now() }]
  }, [projects, rootStorage])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(chatOpenKey(appId), JSON.stringify(chatOpen)) } catch {}
  }, [appId, chatOpen])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(chatRatioKey(appId), String(chatRatio)) } catch {}
  }, [appId, chatRatio])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stored = await rootStorage.get('projects.json')
        let next = normalizeProjects(stored)
        if (!next || next.length === 0) {
          next = [{ id: DEFAULT_PROJECT.id, name: DEFAULT_PROJECT.name, createdAt: Date.now() }]
        }
        if (cancelled) return
        setProjects(next)
        setProjectsLoaded(true)
        if (!next.some((p) => p.id === activeProjectId)) {
          setActiveProjectId('default')
          writeActiveProject(appId, 'default')
        }
        if (!stored || !Array.isArray(stored) || next.length !== stored.length) {
          rootStorage.setJSON('projects.json', next).catch(() => {})
        }
      } catch {
        if (!cancelled) {
          const fallback = [{ id: DEFAULT_PROJECT.id, name: DEFAULT_PROJECT.name, createdAt: Date.now() }]
          setProjects(fallback)
          setProjectsLoaded(true)
        }
      }
    })()
    return () => { cancelled = true }
  }, [appId, activeProjectId, rootStorage])

  useEffect(() => {
    clearBuildPoll()
    hydratedProjectRef.current = activeProjectId
    // Read the DESTINATION project's own localStorage cache (keyed by the new
    // activeProjectId) so a project switch paints its cached tree immediately —
    // forcing this to null blanked the tree until refreshFiles landed, which
    // shows nothing at all offline (list() has no offline mirror).
    const snapshot = readFileCache(appId, activeProjectId)
    const nextFiles = snapshot?.index || []
    filesRef.current = nextFiles
    selectedPathRef.current = snapshot?.lastPath || null
    mainResolvedRef.current = false
    seenBuildStatusRef.current = ''
    mainPathRef.current = null
    fileContentRef.current = ''
    fileDirtyRef.current = false
    fileSavingRef.current = false
    setFiles(nextFiles)
    setFileCache(snapshot?.contents || {})
    setIndexLoaded(false)
    setSelectedPath(snapshot?.lastPath || null)
    setFileContent('')
    setFileLoading(false)
    setFileError(null)
    setFileDirty(false)
    setFileSaving(false)
    setMainPath(null)
    setMainReady(false)
    setViewMode('source')
    setPublishedUrl(null)
    try { navHandleRef.current?.close?.() } catch {}
    navHandleRef.current = null
    setNavOpen(false)
  }, [appId, activeProjectId, clearBuildPoll])

  useEffect(() => {
    let cancelled = false
    const epoch = publishEpochRef.current
    const projectParam = activeProjectId === 'default' ? '' : activeProjectId
    ;(async () => {
      try {
        const r = await fetch(`/api/apps/${appId}/publish?project_id=${encodeURIComponent(projectParam)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!cancelled && r.ok) {
          const data = await r.json()
          if (cancelled || epoch !== publishEpochRef.current) return
          const url = data.url || data.published_url || data.publishedUrl || null
          setPublishedUrl(url ? new URL(url, window.location.origin).href : null)
          return
        }
      } catch {
        // Fall back to app storage below.
      }
      try {
        const toPublishedUrl = (value) => {
          const clean = String(value || '').trim()
          if (!clean) return null
          if (/^https?:\/\//i.test(clean) || clean.startsWith('/')) {
            return new URL(clean, window.location.origin).href
          }
          return new URL(`/apps/${appId}/published/${clean}`, window.location.origin).href
        }
        let stored = null
        for (const path of ['publish-url.txt', 'published-url.txt', 'publish-token.txt']) {
          stored = await storage.getText(path)
          if (stored) break
        }
        if (cancelled || epoch !== publishEpochRef.current) return
        setPublishedUrl(toPublishedUrl(stored))
      } catch {
        if (!cancelled && epoch === publishEpochRef.current) setPublishedUrl(null)
      }
    })()
    return () => { cancelled = true }
  }, [activeProjectId, appId, storage, token])

  const toggleChat = useCallback(() => {
    setChatOpen((open) => {
      // Turning on always spawns a 50/50 split — the divider in the middle —
      // regardless of where a previous drag left it (owner spec).
      if (!open) {
        setChatRatio(0.5)
        signal('chat_opened', {})
      }
      return !open
    })
  }, [])

  const beginChatResize = useCallback((event) => {
    event.preventDefault()
    const body = bodyRef.current
    if (!body) return
    const total = body.getBoundingClientRect().height
    if (!total) return

    const startY = event.clientY
    const startRatioPx = total * chatRatio
    const divider = event.currentTarget
    const pointerId = event.pointerId

    // Capture the pointer so the drag survives crossing the preview iframe.
    divider.setPointerCapture?.(pointerId)

    const onMove = (moveEvent) => {
      // Px-bounded, not fractional: dragging all the way down collapses the
      // chat to exactly the composer pill (CHAT_PANE_MIN_PX) and no smaller;
      // dragging all the way up leaves at least one pill of editor/preview.
      const desiredPx = startRatioPx + startY - moveEvent.clientY
      setChatRatio(clampChatRatio(desiredPx, total, CHAT_PANE_MIN_PX))
    }

    // One teardown for every way the drag can end. pointerup is the normal
    // case, but an interrupted drag (incoming notification, system gesture
    // cancel, focus steal) fires pointercancel / lostpointercapture instead;
    // without handling those the move listener and the pointer capture leak.
    const endDrag = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      divider.removeEventListener('lostpointercapture', endDrag)
      try { divider.releasePointerCapture?.(pointerId) } catch {}
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    divider.addEventListener('lostpointercapture', endDrag)
  }, [chatRatio])

  const handleResizeKey = useCallback((event) => {
    const total = bodyRef.current?.getBoundingClientRect().height || 0
    if (!total) return
    // Same px floor as the drag path: Home collapses the chat to exactly the
    // composer pill, End leaves one pill of editor/preview; Arrows step by ~6%
    // but can never cross either floor (clampChatRatio enforces both ends).
    const step = total * 0.06
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setChatRatio((r) => clampChatRatio(r * total + step, total, CHAT_PANE_MIN_PX))
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setChatRatio((r) => clampChatRatio(r * total - step, total, CHAT_PANE_MIN_PX))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setChatRatio(clampChatRatio(0, total, CHAT_PANE_MIN_PX))
    } else if (event.key === 'End') {
      event.preventDefault()
      setChatRatio(clampChatRatio(total, total, CHAT_PANE_MIN_PX))
    }
  }, [])

  useEffect(() => {
    writeFileCache(appId, activeProjectId, files, fileCache, selectedPath)
  }, [appId, activeProjectId, files, fileCache, selectedPath])

  useEffect(() => { filesRef.current = files }, [files])

  // app_ready: emitted once the project list and the file index have both
  // hydrated, so Reflection can distinguish a real open (and its project/file
  // scale) from the platform's own iframe-load event.
  useEffect(() => {
    if (appReadyRef.current || !projectsLoaded || !indexLoaded) return
    appReadyRef.current = true
    signal('app_ready', {
      item_count: files.length,
      file_count: files.length,
      project_count: projects.length,
    })
  }, [projectsLoaded, indexLoaded, files.length, projects.length])

  const closeNav = useCallback(() => {
    try { navHandleRef.current?.close?.() } catch {}
    navHandleRef.current = null
    setNavOpen(false)
  }, [])

  const openNav = useCallback(async () => {
    if (navOpenRef.current) return
    navOpenRef.current = true
    if (window.mobius?.nav?.open) {
      const handle = window.mobius.nav.open('webstudio-drawer', () => {
        navHandleRef.current = null
        setNavOpen(false)
      })
      navHandleRef.current = handle
      await handle.ready?.catch(() => false)
      if (navHandleRef.current !== handle) return
    }
    setNavOpen(true)
  }, [])
  useEffect(() => { openNavRef.current = openNav }, [openNav])

  const toggleNav = useCallback(() => {
    if (navOpen) closeNav()
    else openNav()
  }, [closeNav, navOpen, openNav])

  useEffect(() => () => {
    try { navHandleRef.current?.close?.() } catch {}
    navHandleRef.current = null
  }, [])

  // Pull the canonical file list out of files-index.json. Falls back to
  // ["files/index.html"] when the index doesn't exist. When offline,
  // storage.get returns null — we keep the localStorage snapshot.
  const refreshFiles = useCallback(async () => {
    try {
      const idx = await (online ? storage.getFresh('files-index.json') : storage.get('files-index.json'))
      if (Array.isArray(idx)) {
        const cleaned = cleanIndexPaths(idx)
        filesRef.current = cleaned
        setFiles(cleaned)
        setIndexLoaded(true)
        if (selectedPath && !cleaned.includes(selectedPath)) {
          setSelectedPath(null)
          setFileContent('')
          setFileCache((prev) => {
            if (!(selectedPath in prev)) return prev
            const next = { ...prev }
            delete next[selectedPath]
            return next
          })
        }
      } else if (idx === null && !online) {
        return
      } else {
        if (!online) return
        const probe = await (online ? storage.getFresh('files/index.html') : storage.get('files/index.html'))
        const seed = probe ? ['files/index.html'] : []
        await storage.setJSON('files-index.json', seed)
        filesRef.current = seed
        setFiles(seed)
        setIndexLoaded(true)
      }
    } catch (e) {
      // Don't blank the UI on a transient read failure — keep the prior list.
    }
  }, [storage, selectedPath, online])

  useEffect(() => {
    refreshFiles()
  }, [activeProjectId, refreshFiles])

  // Pick a sensible default main page: files/index.html if present, else the
  // first .html alphabetically, else null.
  const defaultMain = useCallback((list) => {
    if (list.includes('files/index.html')) return 'files/index.html'
    return list.find((p) => isHtmlDoc(p)) || null
  }, [])

  useEffect(() => {
    if (!indexLoaded || mainResolvedRef.current) return
    let cancelled = false
    ;(async () => {
      let stored = null
      try {
        const m = await (online ? storage.getFresh('main.json') : storage.get('main.json'))
        if (m && typeof m === 'object' && typeof m.path === 'string') stored = m.path
      } catch { /* offline / transient — fall through to default */ }
      // A connectivity flip mid-flight re-runs this effect. We mark resolved
      // only AFTER a non-cancelled completion (not at effect entry), so an
      // interrupted first pass doesn't permanently strip mainPath — and thus
      // the Build/Preview controls — by leaving mainReady false forever.
      if (cancelled) return
      mainResolvedRef.current = true
      const list = filesRef.current
      if (stored && list.includes(stored)) {
        setMainPath(stored)
      } else {
        const fallback = defaultMain(list)
        setMainPath(fallback)
        if (fallback && online) {
          storage.setJSON('main.json', { path: fallback }).catch(() => {})
        }
      }
      setMainReady(true)
    })()
    return () => { cancelled = true }
  }, [indexLoaded, storage, online, defaultMain])

  // Auto-select the first file once we have one — deferred until main.json
  // has resolved so pickAutoSelectPath can prefer the main page. files/
  // lands before main.json, so an undeferred pick would grab whatever HTML
  // file sorts first and hide the Build/Preview controls on first load.
  useEffect(() => {
    if (selectedPath || !mainReady || files.length === 0) return
    const firstReal = pickAutoSelectPath(files, mainPath)
    if (firstReal) setSelectedPath(firstReal)
  }, [files, selectedPath, mainPath, mainReady])

  // Keep the main page valid as the file list changes.
  useEffect(() => {
    if (!mainReady) return
    if (mainPath && !files.includes(mainPath)) {
      const fallback = defaultMain(files)
      setMainPath(fallback)
      if (online) {
        if (fallback) storage.setJSON('main.json', { path: fallback }).catch(() => {})
        else storage.remove('main.json').catch(() => {})
      }
    } else if (!mainPath && files.some((p) => isHtmlDoc(p))) {
      const fallback = defaultMain(files)
      setMainPath(fallback)
      if (fallback && online) storage.setJSON('main.json', { path: fallback }).catch(() => {})
    }
  }, [files, mainPath, mainReady, online, storage, defaultMain])

  // Restore the previous successful build on app entry. A built site is durable
  // storage, but entryByDoc is React state and starts empty on every mount.
  useEffect(() => {
    if (!mainReady || !indexLoaded || !mainPath) return undefined
    if (build.buildStatus === 'building' || build.entryByDoc[mainPath]) return undefined
    let cancelled = false
    ;(async () => {
      let entryPath = null
      try {
        const status = await (online ? storage.getFresh('build/status.json') : storage.get('build/status.json'))
        if (cancelled) return
        entryPath = entryFromBuildStatusForDoc(status, mainPath)
      } catch {
        // Fall through to probing the deterministic entry path.
      }

      if (!entryPath) {
        const candidate = entryPathForHtmlDoc(mainPath)
        if (candidate) {
          try {
            const built = await storage.getText(candidate)
            if (cancelled) return
            if (typeof built === 'string') entryPath = candidate
          } catch {
            // Missing built page: leave the view in "No preview yet".
          }
        }
      }

      if (!cancelled && entryPath) build.rememberEntry(mainPath, entryPath)
    })()
    return () => { cancelled = true }
  }, [
    mainReady,
    indexLoaded,
    mainPath,
    files,
    storage,
    build.buildStatus,
    build.entryByDoc,
    build.rememberEntry,
    online,
  ])

  const syncProjectFromStorage = useCallback(async () => {
    if (!online) return
    await refreshFiles()
    const list = filesRef.current

    try {
      const stored = await storage.getFresh('main.json')
      if (stored && typeof stored === 'object' && typeof stored.path === 'string') {
        if (stored.path !== mainPathRef.current && list.includes(stored.path)) {
          setMainPath(stored.path)
        }
      }
    } catch {
      // Best-effort convergence; the next loop/focus retries.
    }

    try {
      const status = await storage.getFresh('build/status.json')
      const doc = (status && typeof status.target === 'string')
        ? status.target
        : mainPathRef.current
      const entry = entryFromBuildStatusForDoc(status, doc)
      if (doc && entry) {
        const buildKey = `${doc}|${entry}|${status?.built_at || status?.log || ''}`
        if (seenBuildStatusRef.current !== buildKey) {
          seenBuildStatusRef.current = buildKey
          build.rememberEntry(doc, entry)
        }
      }
    } catch {
      // Best-effort; a missing status file just means no successful build yet.
    }
  }, [
    online,
    refreshFiles,
    storage,
    build.rememberEntry,
  ])

  useEffect(() => {
    if (!online) return undefined
    syncProjectFromStorage()
    const interval = setInterval(syncProjectFromStorage, PROJECT_SYNC_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') syncProjectFromStorage()
    }
    window.addEventListener('focus', syncProjectFromStorage)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', syncProjectFromStorage)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [online, syncProjectFromStorage])

  // Set an .html file as the main page (from the drawer context menu).
  const handleSetMain = useCallback(async (path) => {
    if (!isHtmlDoc(path)) return
    setMainPath(path)
    try {
      await storage.setJSON('main.json', { path })
      signal('item_updated', { type: 'main' })
    } catch (e) {
      signal('error', { message: String(e.message || e), source: 'save' })
      await modal.alert(e.message || String(e), { title: 'Could not set main page' })
    }
  }, [storage, modal])

  // Load the selected file's content. Cache-first for first paint, then
  // stale-while-revalidate while online.
  useEffect(() => {
    if (!selectedPath) {
      setFileContent('')
      setFileError(null)
      setFileLoading(false)
      setFileDirty(false)
      return
    }
    if (isBinaryProjectPath(selectedPath)) {
      setFileContent('')
      setFileLoading(false)
      setFileError(null)
      setFileDirty(false)
      return
    }
    let cancelled = false
    const path = selectedPath

    const applyBody = (body) => {
      if (cancelled || selectedPathRef.current !== path) return
      if (fileDirtyRef.current || fileSavingRef.current) return
      setFileContent(body)
      setFileError(null)
      setFileDirty(false)
      setFileCache((prev) => (prev[path] === body ? prev : { ...prev, [path]: body }))
    }

    const applyMissing = () => {
      if (cancelled || selectedPathRef.current !== path) return
      if (fileDirtyRef.current || fileSavingRef.current) return
      setFileContent('')
      setFileError('File not found — was it deleted?')
      setFileDirty(false)
      setFileCache((prev) => {
        if (!(path in prev)) return prev
        const next = { ...prev }
        delete next[path]
        return next
      })
    }

    // subscribeText is a TEXT-kind read; a managed .json path holds JSON and
    // must be read with the JSON getter (assertReadKind throws on a wrong-kind
    // subscribe). For .json we skip the live subscription and rely on the
    // readLatest() poll below, which uses storage.get + JSON.stringify.
    const unsubscribe = isManagedJsonPath(path)
      ? () => {}
      : storage.subscribeText(path, (body) => {
        if (typeof body === 'string') applyBody(body)
        else if (body == null) applyMissing()
      })

    const cachedBody = fileCache[selectedPath]
    let painted = typeof cachedBody === 'string'
    if (typeof cachedBody === 'string') {
      setFileContent(cachedBody)
      setFileError(null)
      setFileLoading(false)
      setFileDirty(false)
    }

    if (!online && typeof cachedBody !== 'string') {
      setFileContent('')
      setFileError('Not available offline. Open this file once online to cache it.')
      setFileLoading(false)
      setFileDirty(false)
    }

    const readLatest = () => {
      if (!online) return
      if (fileDirtyRef.current || fileSavingRef.current) return
      if (!painted) setFileLoading(true)
      setFileError(null)
      storage.get(path).then((data) => {
        if (cancelled) return
        if (data == null) applyMissing()
        else if (typeof data === 'string') applyBody(data)
        else applyBody(JSON.stringify(data, null, 2))
        painted = true
        setFileLoading(false)
      }).catch((e) => {
        if (!cancelled) {
          signal('error', { message: String(e.message || e), source: 'load' })
          setFileError(e.message || 'Could not load file.')
          setFileLoading(false)
          setFileDirty(false)
        }
      })
    }

    readLatest()
    const interval = online
      ? setInterval(() => { readLatest() }, SOURCE_SYNC_MS)
      : null
    const onVisible = () => {
      if (document.visibilityState === 'visible') readLatest()
    }
    window.addEventListener('focus', readLatest)
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      if (interval) clearInterval(interval)
      window.removeEventListener('focus', readLatest)
      document.removeEventListener('visibilitychange', onVisible)
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, storage, online])

  useEffect(() => {
    if (!navOpen) return
    refreshFiles()
  }, [navOpen, refreshFiles])

  const onFilesMaybeChanged = useCallback(async () => {
    await syncProjectFromStorage()
    // The embedded agent finished a turn and we just re-synced the tree/index —
    // tells Reflection the user+agent creation loop is actually being exercised.
    signal('agent_files_changed', {})
    const path = selectedPathRef.current
    if (path && online && isTextProjectPath(path)) {
      storage.get(path).catch(() => {})
    }
  }, [syncProjectFromStorage, storage, online])

  const ensureIndexWritable = useCallback(async () => {
    if (indexLoaded) return true
    await modal.alert(
      'Your file list hasn’t loaded yet. Reconnect (or wait for it to '
        + 'sync) before adding or deleting files, so this doesn’t '
        + 'overwrite work that’s already saved.',
      { title: 'File list not ready' },
    )
    return false
  }, [indexLoaded, modal])

  const handleCreateFile = useCallback(async () => {
    if (!(await ensureIndexWritable())) return
    const name = await modal.prompt(
      'File path — e.g. about.html or css/site.css',
      { title: 'New file', placeholder: 'about.html' },
    )
    if (!name) return
    const clean = name.replace(/^\/+/, '').trim()
    if (!isSafeRelPath(clean)) {
      await modal.alert('Use letters, digits, . - _ / only.', { title: 'Invalid name' })
      return
    }
    const path = `files/${clean}`
    if (filesRef.current.includes(path)) {
      await modal.alert(`“${path}” already exists.`, { title: 'Name taken' })
      return
    }
    // A path can't be both a file and a folder. If a folder already uses this
    // name (some file lives under `${path}/`), say so clearly instead of letting
    // the backend reject the write with an opaque error.
    if (filesRef.current.some((p) => p.startsWith(`${path}/`))) {
      await modal.alert(`A folder named “${clean.split('/').pop()}” already exists here — a file and a folder can’t share a name.`, { title: 'Name taken' })
      return
    }
    // Reject when an INTERMEDIATE segment is itself an existing FILE: with a file
    // at "files/css", creating "css/site.css" would write it BEHIND the file
    // node (orphaned). Walk every ancestor prefix (excluding the leaf, already
    // checked above) and refuse if it's an exact file entry.
    const segs = path.split('/')
    const fileSet = new Set(filesRef.current)
    for (let i = 2; i < segs.length; i++) {
      const ancestor = segs.slice(0, i).join('/')
      if (fileSet.has(ancestor)) {
        await modal.alert(`A file named “${segs[i - 1]}” already exists here — a file and a folder can’t share a name.`, { title: 'Name taken' })
        return
      }
    }
    try {
      await storage.setText(path, '')
      // Merge into the SERVER's current index, not the in-memory snapshot: a
      // concurrent create/delete (another device, or this app's own rapid
      // second mutation before filesRef syncs) could otherwise be clobbered by
      // a whole-array PUT derived from a stale list.
      const fresh = await storage.getFresh('files-index.json')
      const base = Array.isArray(fresh) ? fresh : filesRef.current
      const next = [...new Set([...base, path])].sort()
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      setFileCache((prev) => ({ ...prev, [path]: '' }))
      signal('item_created', { type: 'file' })
      closeNav()
      // Select the new file through switchFile so the CURRENTLY-OPEN file's dirty
      // buffer is FLUSHED (saved) before we move on. Setting the path directly
      // armed the autosave for the NEW path with the OLD file's buffer — the same
      // dirty-switch data-loss class the file-tree selection already guards.
      if (switchFileRef.current) await switchFileRef.current(path)
      else setSelectedPath(path)
    } catch (e) {
      signal('error', { message: String(e.message || e), source: 'save' })
      await modal.alert(e.message || String(e), { title: 'Could not create file' })
    }
  }, [storage, modal, closeNav, ensureIndexWritable])

  const handleCreateFolder = useCallback(async () => {
    if (!(await ensureIndexWritable())) return
    const name = await modal.prompt(
      'Folder name — e.g. css or img/icons',
      { title: 'New folder', placeholder: 'css' },
    )
    if (!name) return
    const clean = name.replace(/^\/+/, '').replace(/\/+$/, '').trim()
    if (!isSafeRelPath(clean)) {
      await modal.alert('Use letters, digits, . - _ / only.', { title: 'Invalid name' })
      return
    }
    const dir = `files/${clean}`
    // A path can't be both a file and a folder. Mirror handleCreateFile's guard:
    // if a file already uses this name, refuse instead of letting the backend
    // reject the .keep write with an opaque error.
    if (filesRef.current.includes(dir)) {
      await modal.alert(`A file named “${clean.split('/').pop()}” already exists here — a file and a folder can’t share a name.`, { title: 'Name taken' })
      return
    }
    // If the folder already exists (its .keep, or any file under it), say so.
    if (filesRef.current.some((p) => p === `${dir}/.keep` || p.startsWith(`${dir}/`))) {
      await modal.alert(`A folder named “${clean.split('/').pop()}” already exists here.`, { title: 'Name taken' })
      return
    }
    // Reject when an INTERMEDIATE segment is itself an existing FILE: with a file
    // at "files/css", creating folder "css/icons" would write "files/css/icons/
    // .keep" BEHIND the file node (orphaned). Walk every ancestor prefix
    // (excluding `dir` itself, already checked) and refuse if it's a file entry.
    const dirSegs = dir.split('/')
    const dirFileSet = new Set(filesRef.current)
    for (let i = 2; i < dirSegs.length; i++) {
      const ancestor = dirSegs.slice(0, i).join('/')
      if (dirFileSet.has(ancestor)) {
        await modal.alert(`A file named “${dirSegs[i - 1]}” already exists here — a file and a folder can’t share a name.`, { title: 'Name taken' })
        return
      }
    }
    const path = `${dir}/.keep`
    try {
      await storage.setText(path, '')
      // Merge into the server's current index, not the stale in-memory list.
      const fresh = await storage.getFresh('files-index.json')
      const base = Array.isArray(fresh) ? fresh : filesRef.current
      const next = [...new Set([...base, path])].sort()
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      signal('item_created', { type: 'folder' })
    } catch (e) {
      signal('error', { message: String(e.message || e), source: 'save' })
      await modal.alert(e.message || String(e), { title: 'Could not create folder' })
    }
  }, [storage, modal, ensureIndexWritable])

  const handleDeleteFile = useCallback(async (path) => {
    if (!(await ensureIndexWritable())) return
    if (!isSafeStoragePath(path)) {
      await modal.alert('That file path is not valid.', { title: 'Invalid path' })
      return
    }
    const ok = await modal.confirm(
      `Delete “${path}”? This cannot be undone.`,
      { title: 'Delete file', danger: true },
    )
    if (!ok) return
    try {
      await storage.remove(path)
      // Remove from the server's current index, not the stale in-memory list, so
      // a concurrent mutation isn't clobbered by a whole-array PUT.
      const fresh = await storage.getFresh('files-index.json')
      const base = Array.isArray(fresh) ? fresh : filesRef.current
      const next = base.filter((p) => p !== path)
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      setFileCache((prev) => {
        if (!(path in prev)) return prev
        const ncache = { ...prev }
        delete ncache[path]
        return ncache
      })
      build.forgetDoc(path)
      if (selectedPath === path) {
        const nextReal = next.find((p) => !p.endsWith('/.keep'))
        // DISCARD, don't flush: the file we just removed must not have its dirty
        // buffer flushed back — that would recreate it. discardAndSelect cancels
        // the armed autosave and clears the dirty/saving flags before selecting.
        discardAndSelect(nextReal || null)
      }
      signal('item_deleted', { type: 'file' })
    } catch (e) {
      signal('error', { message: String(e.message || e), source: 'delete' })
      await modal.alert(e.message || String(e), { title: 'Could not delete' })
    }
  }, [selectedPath, storage, modal, ensureIndexWritable, build, discardAndSelect])

  // ---- Upload (files + whole folders) ------------------------------------
  const uploadFiles = useCallback(async (fileList, { asFolder } = {}) => {
    if (!(await ensureIndexWritable())) return
    const items = Array.from(fileList || [])
    if (items.length === 0) return
    const added = []
    const failed = []
    // An upload writes to files/<rel> directly; without a guard it silently
    // overwrites an existing same-named file (New file refuses a collision, so
    // Upload was the only blind clobber). Detect collisions up front and ask
    // once before overwriting; on decline, skip the colliding paths.
    const existing = new Set(filesRef.current)
    const collisions = items
      .map((f) => `files/${((asFolder && f.webkitRelativePath) || f.name || '').replace(/^\/+/, '').trim()}`)
      .filter((p) => existing.has(p))
    let overwrite = true
    if (collisions.length) {
      const sample = collisions.slice(0, 6).map((p) => p.replace(/^files\//, ''))
      overwrite = await modal.confirm(
        `${collisions.length} file(s) already exist and will be replaced: `
          + `${sample.join(', ')}${collisions.length > 6 ? '…' : ''}. Overwrite them?`,
        { title: 'Replace existing files?', danger: true },
      )
    }
    const collisionSet = new Set(collisions)
    for (const f of items) {
      const rel = ((asFolder && f.webkitRelativePath) || f.name || '')
        .replace(/^\/+/, '')
        .trim()
      if (!isSafeRelPath(rel)) {
        failed.push(f.name || rel || '(unnamed)')
        continue
      }
      const path = `files/${rel}`
      // Skip a colliding path when the user chose not to overwrite.
      if (!overwrite && collisionSet.has(path)) continue
      try {
        // Classify text vs binary by the SAME predicate the editor + preview
        // use (isBinaryProjectPath / BINARY_FILE_EXTS). A divergent regex here
        // stored .svg as text yet ImagePreview read it back via getBlob — a
        // wrong-kind read that left SVG uploads unrenderable.
        const isText = isTextProjectPath(path)
        if (isText) {
          const text = await f.text()
          await storage.setText(path, text)
          setFileCache((prev) => ({ ...prev, [path]: text }))
        } else {
          await storage.setBlob(path, f, { contentType: f.type || 'application/octet-stream' })
        }
        added.push(path)
      } catch (e) {
        failed.push(rel)
      }
    }
    if (added.length) {
      try {
        // Merge the uploaded paths into the server's current index, not the
        // stale in-memory list, so a concurrent mutation isn't clobbered.
        const fresh = await storage.getFresh('files-index.json')
        const base = Array.isArray(fresh) ? fresh : filesRef.current
        const next = [...new Set([...base, ...added])].sort()
        await storage.setJSON('files-index.json', next)
        setFiles(next)
        signal('item_created', { type: 'upload' })
      } catch (e) {
        signal('error', { message: String(e.message || e), source: 'upload' })
        await modal.alert(e.message || String(e), { title: 'Upload saved but index update failed' })
      }
    }
    if (failed.length) {
      await modal.alert(
        `Couldn't upload ${failed.length} item(s): ${failed.slice(0, 6).join(', ')}`
          + (failed.length > 6 ? '…' : ''),
        { title: 'Some uploads failed' },
      )
    }
  }, [storage, modal, ensureIndexWritable])

  // ---- Move / rename (drag-to-move + context-menu rename) ----------------
  const movePath = useCallback(async (from, to) => {
    if (from === to) return
    if (!(await ensureIndexWritable())) return
    if (!isSafeStoragePath(from) || !isSafeStoragePath(to)) {
      await modal.alert('Use letters, digits, . - _ / only.', { title: 'Invalid name' })
      return
    }
    if (to === from || to.startsWith(`${from}/`)) {
      await modal.alert('Cannot move an item into itself.', { title: 'Invalid move' })
      return
    }
    try {
      await storage.move(from, to)
      const rewrite = (p) => {
        if (p === from) return to
        if (p.startsWith(`${from}/`)) return to + p.slice(from.length)
        return p
      }
      // Apply the rename to the server's current index, not the stale in-memory
      // list, so a concurrent mutation isn't clobbered by a whole-array PUT.
      const fresh = await storage.getFresh('files-index.json')
      const base = Array.isArray(fresh) ? fresh : filesRef.current
      const next = [...new Set(base.map(rewrite))].sort()
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      setFileCache((prev) => {
        const out = {}
        for (const [p, v] of Object.entries(prev)) out[rewrite(p)] = v
        return out
      })
      setSelectedPath((cur) => (cur ? rewrite(cur) : cur))
      build.rewriteDocs(rewrite)
      if (mainPathRef.current) {
        const nextMain = rewrite(mainPathRef.current)
        if (nextMain !== mainPathRef.current) {
          setMainPath(nextMain)
          storage.setJSON('main.json', { path: nextMain }).catch(() => {})
        }
      }
    } catch (e) {
      signal('error', { message: String(e.message || e), source: 'move' })
      if (e.status === 409) {
        await modal.alert('Something already exists at the destination.', { title: 'Move failed' })
      } else {
        await modal.alert(e.message || String(e), { title: 'Move failed' })
      }
    }
  }, [storage, modal, ensureIndexWritable, build])

  const handleRename = useCallback(async (path) => {
    const parts = path.split('/')
    const leaf = parts[parts.length - 1]
    const parent = parts.slice(0, -1).join('/')
    const nextLeaf = await modal.prompt(
      'New name',
      { title: 'Rename', placeholder: leaf, defaultValue: leaf },
    )
    if (!nextLeaf) return
    const clean = nextLeaf.replace(/^\/+/, '').replace(/\/+$/, '').trim()
    if (!clean || clean === leaf) return
    if (clean.includes('/')) {
      await modal.alert('A name can’t contain “/”. Drag the item to move it.', { title: 'Invalid name' })
      return
    }
    const to = parent ? `${parent}/${clean}` : clean
    await movePath(path, to)
  }, [modal, movePath])

  // ---- Folder delete (recursive) -----------------------------------------
  const handleDeleteFolder = useCallback(async (folderPath) => {
    if (!(await ensureIndexWritable())) return
    if (!isSafeStoragePath(folderPath)) {
      await modal.alert('That folder path is not valid.', { title: 'Invalid path' })
      return
    }
    const ok = await modal.confirm(
      `Delete the folder “${folderPath}” and everything inside it? This cannot be undone.`,
      { title: 'Delete folder', danger: true },
    )
    if (!ok) return
    try {
      await storage.removeFolder(folderPath)
      const under = (p) => p === folderPath || p.startsWith(`${folderPath}/`)
      // Remove from the server's current index, not the stale in-memory list, so
      // a concurrent mutation isn't clobbered by a whole-array PUT.
      const fresh = await storage.getFresh('files-index.json')
      const base = Array.isArray(fresh) ? fresh : filesRef.current
      const next = base.filter((p) => !under(p))
      await storage.setJSON('files-index.json', next)
      setFiles(next)
      setFileCache((prev) => {
        const out = {}
        for (const [p, v] of Object.entries(prev)) if (!under(p)) out[p] = v
        return out
      })
      // If the OPEN file lived under the deleted folder, DISCARD its buffer and
      // fall back — flushing would recreate a file inside the folder we removed.
      // If the open file is elsewhere, leave the selection untouched.
      const openPath = selectedPathRef.current
      if (openPath && under(openPath)) {
        discardAndSelect(next.find((p) => !p.endsWith('/.keep')) || null)
      }
      build.forgetUnder(folderPath)
      signal('item_deleted', { type: 'folder' })
    } catch (e) {
      signal('error', { message: String(e.message || e), source: 'delete' })
      await modal.alert(e.message || String(e), { title: 'Delete failed' })
    }
  }, [storage, modal, ensureIndexWritable, build, discardAndSelect])

  const selectedExt = selectedPath ? extensionFor(selectedPath) : ''
  const selectedIsBinary = selectedPath ? isBinaryProjectPath(selectedPath) : false
  const canEditSelected = !!selectedPath && !selectedIsBinary && !fileLoading && !fileError
  const selectedIsHtml = selectedPath ? isHtmlDoc(selectedPath) : false
  // Whether there is a buildable main page. The [Source | Preview] toggle and
  // the Build button track the MAIN page (the preview always renders it),
  // not the currently-open file.
  const hasMain = !!mainPath
  // The site entry built from the MAIN page this session, if any: a
  // { entry, ver } record (ver is the build token).
  const entryForMain = (mainPath && build.entryByDoc[mainPath]) || null
  const mainBuilding = build.buildStatus === 'building' && build.buildDoc === mainPath
  const mainBuildError = build.buildStatus === 'error' && build.buildDoc === mainPath

  // Reset the viewer to source whenever the user switches files.
  useEffect(() => {
    setViewMode('source')
  }, [selectedPath])

  // When the MAIN page's build finishes, flip the viewer to Preview.
  const onBuildDone = useCallback(async (doc) => {
    if (doc === mainPathRef.current) {
      setViewMode('preview')
      signal('preview_page_viewed', { via: 'build' })
    }
    // The built site lives under build/site/, NOT files/, so it is deliberately
    // NOT added to the file tree — the tree shows source, the Preview shows the
    // assembled output. (LaTeX added the .pdf to the tree; a website's build is
    // a whole directory mirror, so surfacing it as tree nodes would be noise.)
  }, [])

  const handleEditorChange = useCallback((value) => {
    setFileContent(value)
    setFileDirty(true)
    if (selectedPath) {
      setFileCache((prev) => ({ ...prev, [selectedPath]: value }))
    }
  }, [selectedPath])

  useEffect(() => {
    if (!selectedPath || selectedIsBinary || isManagedJsonPath(selectedPath) || !fileDirty) return undefined
    const path = selectedPath
    const body = fileContent
    const timer = setTimeout(() => {
      autosaveTimerRef.current = null
      if (selectedPathRef.current !== path) return
      setFileSaving(true)
      // Publish the in-flight write so flushDirtyEdits can await it before a
      // project switch/create resets the buffer — otherwise keystrokes typed
      // during this 700ms-debounced write are lost (the flush would resolve
      // against a stale snapshot).
      const p = storage.setText(path, body).then(() => {
        if (selectedPathRef.current !== path) return
        setFileCache((prev) => ({ ...prev, [path]: body }))
        if (fileContentRef.current === body) setFileDirty(false)
        signal('item_updated', { type: 'file' })
      }).catch((e) => {
        signal('error', { message: String(e.message || e), source: 'save' })
        if (selectedPathRef.current === path) {
          setFileError(e.message || 'Could not save file.')
        }
      }).finally(() => {
        if (selectedPathRef.current === path) setFileSaving(false)
        if (savePromiseRef.current === p) savePromiseRef.current = null
      })
      savePromiseRef.current = p
    }, SOURCE_AUTOSAVE_MS)
    autosaveTimerRef.current = timer
    return () => {
      clearTimeout(timer)
      if (autosaveTimerRef.current === timer) autosaveTimerRef.current = null
    }
  }, [
    selectedPath,
    selectedIsBinary,
    fileDirty,
    fileContent,
    storage,
  ])

  const handleSaveFile = useCallback(async () => {
    if (!selectedPath || selectedIsBinary || isManagedJsonPath(selectedPath) || fileSaving) {
      return savePromiseRef.current
    }
    setFileSaving(true)
    setFileError(null)
    const p = (async () => {
      try {
        await storage.setText(selectedPath, fileContent)
        setFileDirty(false)
        setFileCache((prev) => ({ ...prev, [selectedPath]: fileContent }))
      } catch (e) {
        signal('error', { message: String(e.message || e), source: 'save' })
        setFileError(e.message || 'Could not save file.')
      } finally {
        setFileSaving(false)
        savePromiseRef.current = null
      }
    })()
    savePromiseRef.current = p
    return p
  }, [selectedPath, selectedIsBinary, fileSaving, storage, fileContent])

  // Persist the editor's LATEST text before a reset (project switch/create)
  // throws away the dirty buffer. A debounced autosave may have a write in
  // flight; BOTH it and handleSaveFile publish their write to savePromiseRef,
  // so we await that, THEN write fileContentRef.current DIRECTLY. We do not
  // route through handleSaveFile here: it no-ops while fileSaving and captures a
  // possibly-stale fileContent closure, whereas the in-flight autosave only
  // persisted its 700ms-old snapshot — anything typed since lives in
  // fileContentRef.current and must be saved before resetFileUi wipes it.
  const flushDirtyEdits = useCallback(async () => {
    if (!canEditSelected) return
    const path = selectedPathRef.current
    if (!path || selectedIsBinary || isManagedJsonPath(path)) return
    if (savePromiseRef.current) { try { await savePromiseRef.current } catch { /* error surfaced by the in-flight write */ } }
    if (fileDirtyRef.current) {
      await storage.setText(path, fileContentRef.current)
      setFileCache((prev) => ({ ...prev, [path]: fileContentRef.current }))
      setFileDirty(false)
    }
  }, [canEditSelected, selectedIsBinary, storage])

  // Switch the open file, closing the dirty-file-switch data-loss path: picking
  // file B while A's 700ms autosave is still armed used to leave fileDirty=true,
  // which both BLOCKED B's load (readLatest bails while dirty) and let the
  // pending timer fire storage.setText(B, A's-buffer) — writing A's edits into
  // B. We flush A first (awaiting any in-flight autosave), then reset the
  // dirty/saving flags SYNCHRONOUSLY for the new path so neither the load effect
  // nor the autosave timer can act on A's stale buffer under B's path. The
  // timer's own selectedPath guard stays as the second line of defense.
  const switchFile = useCallback(async (path) => {
    if (path === selectedPathRef.current) return
    await flushDirtyEdits()
    fileDirtyRef.current = false
    fileSavingRef.current = false
    setFileDirty(false)
    setFileSaving(false)
    setSelectedPath(path)
    if (path) signal('item_opened', { type: 'file' })
  }, [flushDirtyEdits])
  // Mirror switchFile onto a ref so handlers defined ABOVE it (handleCreateFile)
  // can flush-then-select through it without a temporal-dead-zone reference.
  useEffect(() => { switchFileRef.current = switchFile }, [switchFile])

  const resetFileUi = useCallback(() => {
    clearBuildPoll()
    filesRef.current = []
    selectedPathRef.current = null
    mainResolvedRef.current = false
    seenBuildStatusRef.current = ''
    mainPathRef.current = null
    fileContentRef.current = ''
    fileDirtyRef.current = false
    fileSavingRef.current = false
    setFiles([])
    setFileCache({})
    setIndexLoaded(false)
    setSelectedPath(null)
    setFileContent('')
    setFileLoading(false)
    setFileError(null)
    setFileDirty(false)
    setFileSaving(false)
    setMainPath(null)
    setMainReady(false)
    setViewMode('source')
    setPublishedUrl(null)
    try { navHandleRef.current?.close?.() } catch {}
    navHandleRef.current = null
    setNavOpen(false)
  }, [clearBuildPoll])

  const switchProject = useCallback(async (id) => {
    if (publishingRef.current) return
    if (!isSafeProjectId(id) || id === activeProjectId) return
    // Flush dirty edits (awaiting any in-flight autosave) before resetFileUi
    // discards the buffer — otherwise keystrokes typed during an in-flight
    // autosave are lost.
    await flushDirtyEdits()
    resetFileUi()
    writeActiveProject(appId, id)
    setActiveProjectId(id)
  }, [activeProjectId, appId, flushDirtyEdits, resetFileUi])

  const startRenameProject = useCallback((id) => setRenamingId(id), [])
  const cancelRenameProject = useCallback(() => setRenamingId(null), [])

  const commitRenameProject = useCallback(async (targetId, rawName) => {
    const clean = String(rawName || '').trim()
    try {
      const fresh = await readFreshProjects()
      const current = fresh.find((p) => p.id === targetId)
      if (!current || !clean || clean === current.name) return
      const next = fresh.map((p) => (p.id === targetId ? { ...p, name: clean } : p))
      await rootStorage.setJSON('projects.json', next)
      setProjects(next)
      signal('item_updated', { type: 'project' })
    } catch (e) {
      signal('error', { message: String(e.message || e), source: 'save' })
      await modal.alert(e.message || String(e), { title: 'Could not rename project' })
    } finally {
      setRenamingId(null)
    }
  }, [modal, readFreshProjects, rootStorage])

  const createAndRenameProject = useCallback(async () => {
    if (!projectsLoaded) {
      await modal.alert('Projects are still loading.', { title: 'Projects' })
      return
    }
    if (publishingRef.current) {
      await modal.alert('Finish publishing before creating a project.', { title: 'Publishing' })
      return
    }
    const name = `Project ${projects.length + 1}`
    try {
      const fresh = await readFreshProjects()
      const id = projectSlug(name, new Set(fresh.map((p) => p.id)))
      const next = [...fresh, { id, name, createdAt: Date.now() }]
      await rootStorage.setJSON('projects.json', next)
      setProjects(next)
      signal('item_created', { type: 'project' })
      await switchProject(id)
      // switchProject early-returns (without making `id` active) if the user
      // tapped Publish during the await window. Only open the inline rename if
      // the switch actually took effect — otherwise we'd open a rename on a
      // non-active project. The project still exists and is recoverable.
      if (!publishingRef.current) {
        setRenamingId(id)
        openNavRef.current?.()
      }
    } catch (e) {
      signal('error', { message: String(e.message || e), source: 'save' })
      await modal.alert(e.message || String(e), { title: 'Could not create project' })
    }
  }, [modal, projects.length, projectsLoaded, readFreshProjects, rootStorage, switchProject])

  const handleDeleteProject = useCallback(async (targetId) => {
    if (!projectsLoaded) {
      await modal.alert('Projects are still loading.', { title: 'Projects' })
      return
    }
    try {
      const fresh = await readFreshProjects()
      const target = fresh.find((p) => p.id === targetId)
      if (!target) {
        await modal.alert('That project no longer exists.', { title: 'Cannot delete project' })
        return
      }
      if (targetId === 'default' || fresh.length <= 1) {
        await modal.alert('The default project and the last remaining project cannot be deleted.', { title: 'Cannot delete project' })
        return
      }
      const ok = await modal.confirm(
        `Delete “${target.name}” and all of its files, builds, and chat history? This cannot be undone.`,
        { title: 'Delete Project', danger: true },
      )
      if (!ok) return
      const latest = await readFreshProjects()
      const current = latest.find((p) => p.id === targetId)
      if (!current) {
        await modal.alert('That project no longer exists.', { title: 'Cannot delete project' })
        return
      }
      if (targetId === 'default' || latest.length <= 1) {
        await modal.alert('The default project and the last remaining project cannot be deleted.', { title: 'Cannot delete project' })
        return
      }
      const fallback = latest.find((p) => p.id !== targetId)?.id || 'default'
      const next = latest.filter((p) => p.id !== targetId)
      try {
        await fetch(`/api/apps/${appId}/publish?project_id=${encodeURIComponent(targetId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        })
      } catch {
        // Best-effort cleanup only.
      }
      await deleteStorageTree(rootStorage, projectPrefix(targetId))
      await rootStorage.setJSON('projects.json', next)
      setProjects(next)
      signal('item_deleted', { type: 'project' })
      removeFileCache(appId, targetId)
      if (targetId === activeProjectId) {
        resetFileUi()
        writeActiveProject(appId, fallback)
        setActiveProjectId(fallback)
      }
    } catch (e) {
      signal('error', { message: String(e.message || e), source: 'delete' })
      await modal.alert(e.message || String(e), { title: 'Could not delete project' })
    }
  }, [
    activeProjectId,
    appId,
    modal,
    projectsLoaded,
    readFreshProjects,
    resetFileUi,
    rootStorage,
    token,
  ])

  const handlePublish = useCallback(async () => {
    if (publishingRef.current) return
    const builtEntry = mainPath ? build.entryByDoc[mainPath]?.entry : null
    if (build.buildStatus !== 'done' || !builtEntry) {
      await modal.alert('No built site found — please Build first', { title: 'Publish failed' })
      return
    }
    publishingRef.current = true
    setPublishing(true)
    try {
      const r = await fetch(`/api/apps/${appId}/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: activeProjectId === 'default' ? null : activeProjectId }),
      })
      if (r.ok) {
        const data = await r.json()
        const fullUrl = new URL(data.url, window.location.origin).href
        setPublishedUrl(fullUrl)
        publishEpochRef.current += 1
        signal('site_published', {})
        try { await storage.setText('publish-url.txt', fullUrl) } catch { /* best-effort persist */ }
        // No blocking modal — opening one rides the shell nav stack and closes
        // the drawer. The drawer's publish row now shows the URL + Copy/Open/
        // Unpublish inline, so the drawer stays open with the result visible.
        return
      }
      if (r.status === 400) {
        await modal.alert('No built site found — please Build first', { title: 'Publish failed' })
        return
      }
      let detail = ''
      try {
        const data = await r.json()
        detail = data.detail || data.error || ''
      } catch { /* non-JSON */ }
      // A non-throw HTTP failure is still a failure Reflection should see — the
      // throw path signals, so this branch must too, or a 500 goes untracked.
      signal('error', { message: detail || `publish → ${r.status}`, source: 'publish' })
      await modal.alert(detail || `Publish failed (${r.status}).`, { title: 'Publish failed' })
    } catch (e) {
      signal('error', { message: String(e.message || e), source: 'publish' })
      await modal.alert(e.message || String(e), { title: 'Publish failed' })
    } finally {
      publishingRef.current = false
      setPublishing(false)
    }
  }, [activeProjectId, appId, build.buildStatus, build.entryByDoc, mainPath, modal, storage, token])

  const handleUnpublish = useCallback(async () => {
    if (publishingRef.current) return
    publishingRef.current = true
    setPublishing(true)
    try {
      const projectParam = activeProjectId === 'default' ? '' : activeProjectId
      const r = await fetch(`/api/apps/${appId}/publish?project_id=${encodeURIComponent(projectParam)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (r.ok) {
        setPublishedUrl(null)
        publishEpochRef.current += 1
        signal('site_unpublished', {})
        try { await storage.remove('publish-url.txt') } catch { /* best-effort clear */ }
        return
      }
      let detail = ''
      try {
        const data = await r.json()
        detail = data.detail || data.error || ''
      } catch { /* non-JSON */ }
      // Signal the non-throw HTTP failure too — same reason as publish above.
      signal('error', { message: detail || `unpublish → ${r.status}`, source: 'unpublish' })
      await modal.alert(detail || `Unpublish failed (${r.status}).`, { title: 'Unpublish failed' })
    } catch (e) {
      signal('error', { message: String(e.message || e), source: 'publish' })
      await modal.alert(e.message || String(e), { title: 'Unpublish failed' })
    } finally {
      publishingRef.current = false
      setPublishing(false)
    }
  }, [activeProjectId, appId, modal, storage, token])

  const handleBuild = useCallback(() => {
    // Build always assembles the site for the MAIN page (the preview renders
    // it). useBuild writes build/target.txt = mainPath so build.sh knows which
    // page is the entry.
    if (!mainPath || build.buildStatus === 'building') return
    // Save the currently-open file's unsaved edits first so the build picks up
    // on-screen changes.
    const kick = () => build.build(mainPath, onBuildDone)
    if (fileDirty && !fileSaving && canEditSelected) {
      handleSaveFile().then(kick, kick)
    } else {
      kick()
    }
  }, [mainPath, fileDirty, fileSaving, canEditSelected, build, onBuildDone, handleSaveFile])

  // The Preview view: the MAIN page's built site (with running / failed states).
  function renderPreviewView() {
    if (!mainPath) {
      return (
        <div className="ws-preview-note">
          No main page set yet. Open the file drawer, tap an .html file’s ⋯
          menu, and choose “Set as main page”, then Build.
        </div>
      )
    }
    if (mainBuilding) {
      return (
        <div className="ws-preview-note ws-build-note">
          Building <b>{mainPath.replace(/^files\//, '')}</b>…
        </div>
      )
    }
    if (mainBuildError) {
      return (
        <div className="ws-build-error">
          <div className="ws-build-error-title">Build failed</div>
          <pre className="ws-build-log">{build.buildLog}</pre>
        </div>
      )
    }
    if (entryForMain) {
      return <HtmlPreview storage={storage} entryPath={entryForMain.entry} version={entryForMain.ver} />
    }
    return (
      <div className="ws-preview-note ws-build-note">
        No preview yet. Tap <b>Build</b> to assemble + render <b>{mainPath.replace(/^files\//, '')}</b>.
      </div>
    )
  }

  // The main content area — source editor OR a viewer, toggled.
  function renderMain() {
    if (!selectedPath) {
      return (
        <div className="ws-preview-empty">
          <div className="ws-preview-empty-title">Web Studio</div>
          <div className="ws-preview-empty-body">
            Open the file drawer to pick a file.
          </div>
        </div>
      )
    }
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(selectedExt)) {
      return <ImagePreview storage={storage} path={selectedPath} />
    }
    // Preview mode shows the MAIN page's built site, so it is only rendered
    // when the OPEN file IS the main page — matching showHtmlControls, so the
    // preview never paints a different page than the one on screen.
    if (selectedPath === mainPath && viewMode === 'preview') {
      return renderPreviewView()
    }
    if (fileLoading) return <div className="ws-preview-note">Loading source…</div>
    if (fileError) return <div className="ws-preview-note">{fileError}</div>
    // Managed .json files are shown read-only.
    if (isManagedJsonPath(selectedPath)) {
      return (
        <div className="ws-editor-readonly">
          <div className="ws-readonly-note">
            Managed file — edit via the app, not the source.
          </div>
          <CodeEditor
            value={fileContent}
            markdown={false}
            readOnly
            docKey={selectedPath}
            onChange={handleEditorChange}
          />
        </div>
      )
    }
    return (
      <CodeEditor
        value={fileContent}
        markdown={false}
        readOnly={false}
        docKey={selectedPath}
        onChange={handleEditorChange}
      />
    )
  }

  // The Preview view + Build always operate on the MAIN page. We therefore
  // only offer the [Source | Preview] toggle and Build when the OPEN file IS
  // the main page — otherwise "Show preview" on a non-main .html would render
  // a DIFFERENT page than the one on screen (the misleading affordance the
  // reviewer flagged). For a non-main .html the user picks "Set as main page"
  // from the drawer first. (selectedPath === mainPath implies html + hasMain,
  // since mainPath is only ever set to an isHtmlDoc path.)
  const showHtmlControls = !!mainPath && selectedPath === mainPath
  const openName = selectedPath ? selectedPath.replace(/^files\//, '') : null

  const quickActions = useMemo(() => {
    const actions = []
    if (build.buildStatus === 'error') {
      actions.push({ label: 'Fix the build', prompt: 'Fix the build errors.' })
    }
    actions.push({ label: 'Improve the design', prompt: 'Improve the visual design of the site.' })
    actions.push({ label: 'Add a page', prompt: 'Add a new page to the site.' })
    return actions
  }, [build.buildStatus])

  const getContext = useCallback(() => {
    return Promise.resolve({
      openFile: selectedPath || null,
      viewMode: viewMode || null,
      buildStatus: build.buildStatus || null,
      mainFile: mainPath || null,
      projectId: activeProjectId,
    })
  }, [selectedPath, viewMode, build.buildStatus, mainPath, activeProjectId])

  return (
    <div className="ws-root">
      <style>{CSS}</style>
      {/* Two-zone top bar: left = drawer toggle + project/open filename,
          right = Build + [Source/Preview toggle]. The grid is 1fr | auto so the left zone
          flexes/truncates and the right zone sizes to its controls.
          Identical structure in app-latex (unprefixed classes). */}
      <header className="ws-top-bar">
        <div className="ws-top-zone ws-top-zone--left">
          {/* The app's own glossy icon is the drawer toggle, mirroring the
              Möbius shell header where the logo (not a hamburger) opens the
              drawer. The real icon image — the backend serves a downscaled
              copy at ?size=128 (cached 1h), kept crisp at the 34px render
              without the old full-res PNG cost; the accent-dot fallback shows
              when an install has no custom icon (the route 404s). */}
          <button
            ref={navToggleRef}
            className="ws-nav-toggle"
            onClick={toggleNav}
            aria-label={navOpen ? 'Close file drawer' : 'Open file drawer'}
            aria-expanded={navOpen}
          >
            <img
              src={`/api/apps/${appId}/icon?size=128`}
              alt=""
              width={34}
              height={34}
              className="ws-brand-icon"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
                const f = e.currentTarget.nextElementSibling
                if (f) f.style.display = 'flex'
              }}
            />
            <span className="ws-brand-fallback" style={{ display: 'none' }} aria-hidden="true" />
          </button>
          <div className="ws-top-title">
            {openName
              ? <span className="ws-top-path" title={selectedPath}>{openName}</span>
              : <span className="ws-top-path ws-top-path--muted">No file open</span>}
          </div>
        </div>
        <div className="ws-top-zone ws-top-zone--right">
          {showHtmlControls && (
            <>
              <button
                className="ws-toolbar-btn ws-toolbar-btn--primary"
                onClick={handleBuild}
                disabled={build.buildStatus === 'building'}
                aria-label={build.buildStatus === 'building' ? 'Building…' : 'Build'}
                title={build.buildStatus === 'building'
                  ? 'Building…'
                  : `Build ${mainPath.replace(/^files\//, '')}`}
              >
                {build.buildStatus === 'building'
                  ? <BuildingIndicator size={20} />
                  : <PlayIcon size={20} />}
              </button>
              {/* Icon-only [Source | Preview] toggle. role=group + aria-pressed exposes
                  the active segment to assistive tech; title + aria-label name the action. */}
              <div className="ws-seg-toggle" role="group" aria-label="View">
                <button
                  type="button"
                  className={`ws-seg-btn ${viewMode !== 'preview' ? 'ws-seg-btn--active' : ''}`}
                  aria-pressed={viewMode !== 'preview'}
                  aria-label="Source"
                  title="Source"
                  onClick={() => setViewMode('source')}
                >
                  <CodeIcon size={20} />
                </button>
                <button
                  type="button"
                  className={`ws-seg-btn ${viewMode === 'preview' ? 'ws-seg-btn--active' : ''}`}
                  aria-pressed={viewMode === 'preview'}
                  aria-label="Preview"
                  title="Preview"
                  onClick={() => setViewMode('preview')}
                >
                  <EyeIcon size={20} />
                </button>
              </div>
            </>
          )}
          {/* Chat toggle — the embedded agent chat is core, always available
              (not project-specific, so it stays in the bar, not the drawer). */}
          <button
            type="button"
            className="ws-toolbar-btn ws-chat-toggle-btn"
            aria-label={chatOpen ? 'Close chat' : 'Open chat'}
            aria-pressed={chatOpen}
            title={chatOpen ? 'Close chat' : 'Open chat'}
            onClick={toggleChat}
          >
            <ChatBubbleIcon size={20} />
          </button>
        </div>
      </header>

      <div
        ref={bodyRef}
        className={chatOpen ? 'ws-body ws-body--chat-open' : 'ws-body'}
        style={chatOpen ? { '--ws-chat-ratio': chatRatio } : undefined}
      >
        <FileNavPanel
          appId={appId}
          open={navOpen}
          onClose={closeNav}
          files={files}
          selectedPath={selectedPath}
          onSelect={switchFile}
          canMutate={indexLoaded}
          onCreateFile={handleCreateFile}
          onCreateFolder={handleCreateFolder}
          onDeleteFile={handleDeleteFile}
          onDeleteFolder={handleDeleteFolder}
          onUpload={uploadFiles}
          onMove={movePath}
          onRename={handleRename}
          mainPath={mainPath}
          onSetMain={handleSetMain}
          returnFocusRef={navToggleRef}
          projects={projects}
          projectsLoaded={projectsLoaded}
          activeProjectId={activeProjectId}
          onSwitchProject={switchProject}
          onNewProject={createAndRenameProject}
          onRenameProject={startRenameProject}
          onDeleteProject={handleDeleteProject}
          renamingId={renamingId}
          onCommitProjectRename={commitRenameProject}
          onCancelProjectRename={cancelRenameProject}
          publishedUrl={publishedUrl}
          publishing={publishing}
          buildStatus={build.buildStatus}
          canPublish={build.buildStatus === 'done' && !!(mainPath && build.entryByDoc[mainPath]?.entry)}
          onPublish={handlePublish}
          onUnpublish={handleUnpublish}
        />
        {/* ws-content (its sandboxed preview iframe + CodeMirror) MUST render
            unconditionally at this stable position — never inside a conditional
            or ternary branch. Remounting it reloads the sandboxed iframe (black
            flash) and resets the editor (lost scroll/undo/cursor). The chat
            divider + panel are conditional SIBLINGS *after* it; never wrap this. */}
        <main className="ws-content">{renderMain()}</main>
        {chatOpen && (
          <>
            <div
              className="ws-chat-divider"
              role="separator"
              aria-label="Resize chat and editor areas"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(chatRatio * 100)}
              tabIndex={0}
              onPointerDown={beginChatResize}
              onKeyDown={handleResizeKey}
            >
              <span className="ws-chat-divider-bar" aria-hidden="true" />
            </div>
            <ChatPanel
              key={activeProjectId}
              appId={appId}
              token={token}
              storage={storage}
              projectId={activeProjectId}
              persistKey={`${activePrefix}chat_id.json`}
              onFilesMaybeChanged={onFilesMaybeChanged}
              quickActions={quickActions}
              getContext={getContext}
            />
          </>
        )}
      </div>
      {/* Silent when healthy — appears only offline with a plain "Offline". */}
      <SyncPill online={online} />
      {modal.node}
    </div>
  )
}

// ----------------------------------------------------------------------
// Styles. Inline so the app is single-file (per spec) and the CSS vars
// resolve against whatever theme the Möbius shell is painting. All colors
// come from theme tokens; no hard-coded brand colors. Shape copied from
// app-latex with a `ws-` prefix (keep in sync where divergence isn't needed).
