// Web Studio — thin app shell. The module tree is declared in mobius.json's
// source_files; the multi-file installer fetches each path and Rolldown bundles
// from this entry, resolving the relative imports below at compile time.
//
//   constants.js              — shared scalar constants for storage, preview, chat, and polling
//   theme.js                  — the single app stylesheet (CSS)
//   domain.js                 — pure + DOM-level path, project, tree, build-entry, and chat helpers
//   storage.js                — typed storage, guarded shared-document updates, and online signal
//   preview/previewDomain.js  — pure preview URL policy, injected nav script, and retry helper
//   preview/HtmlPreview.jsx   — sandboxed iframe preview renderer
//   build/useBuild.js         — source-to-site build state machine and poll loop
//   ui/*.jsx                  — one React component or icon per file
//
// Only App lives here: it owns top-level project/file/editor/build/chat state,
// persistence wiring, and mounts the source/preview/file/chat UI.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { signal } from './analytics.js'
import {
  AGENT_WATCH_MS,
  AGENT_WATCH_POLL_MS,
  AUTO_BUILD_MAX_DIRS,
  NOTES_MAX,
  NOTES_PATH,
  CHAT_PANE_MIN_PX,
  DEFAULT_PROJECT,
  FILE_CONTENT_CACHE_LIMIT,
  IMAGE_PREVIEW_EXTS,
  PROJECT_SYNC_MS,
  SOURCE_AUTOSAVE_MS,
  SOURCE_SYNC_MS,
  WORKSPACE_PANE_MIN_PX,
} from './constants.js'
import { CSS } from './theme.js'
import {
  annotatablePreview,
  cleanIndexPaths,
  composeNotesMessage,
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
  makeNote,
  normalizeNotes,
  normalizeProjects,
  pickAutoSelectPath,
  projectPrefix,
  projectSlug,
  sourceFingerprint,
  sourceNeedsBuild,
} from './domain.js'
import {
  chatOpenKey,
  chatRatioKey,
  makeStorage,
  readActiveProject,
  readChatOpen,
  readChatRatio,
  scopedStorage,
  useOnline,
  writeActiveProject,
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
import { PencilIcon } from './ui/PencilIcon.jsx'
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
  pickAutoSelectPath,
  projectPrefix,
} from './domain.js'
export {
  anchorActionFor,
  readWithRetry,
  resolveSiteAsset,
  WS_PREVIEW_NAV_SCRIPT,
} from './preview/previewDomain.js'

function rememberFileBody(cache, path, body) {
  if (!path || typeof body !== 'string') return cache
  if (cache[path] === body) return cache
  const next = { ...cache }
  delete next[path]
  next[path] = body
  const keys = Object.keys(next)
  if (keys.length > FILE_CONTENT_CACHE_LIMIT) delete next[keys[0]]
  return next
}

export default function App({ appId, token }) {
  const rootStorage = useMemo(() => makeStorage(appId, token), [appId, token])
  const [activeProjectId, setActiveProjectId] = useState(() => readActiveProject(appId))
  const activePrefix = useMemo(() => projectPrefix(activeProjectId), [activeProjectId])
  const storage = useMemo(() => scopedStorage(rootStorage, activePrefix), [rootStorage, activePrefix])
  const online = useOnline()
  const rawModal = useModal()
  const bodyRef = useRef(null)
  const [projects, setProjects] = useState([])
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [files, setFiles] = useState([])
  const filesRef = useRef(files)
  const [fileCache, setFileCache] = useState({})
  const [indexLoaded, setIndexLoaded] = useState(false)
  const [navOpen, setNavOpen] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 860px)').matches
      : false
  )
  const navHandleRef = useRef(null)
  const navOpenRef = useRef(false)
  const chatNavRef = useRef(null)
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
  const [selectedPath, setSelectedPath] = useState(null)
  const selectedPathRef = useRef(selectedPath)
  useEffect(() => { selectedPathRef.current = selectedPath }, [selectedPath])
  const [fileContent, setFileContent] = useState('')
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState(null)
  const [saveError, setSaveError] = useState(null)
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
  // Fire the source_edited activation signal at most ONCE per session — the
  // first real editor keystroke, distinct from the 700ms-debounced item_updated
  // autosave that fires on every save rather than on the activating edit.
  const sourceEditedRef = useRef(false)
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
    setSaveError(null)
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
  // Match LaTeX's responsive workspace: phones keep the single-pane toggle,
  // while larger screens dock the toggleable file rail and show source +
  // preview together across a draggable divider.
  const [isWide, setIsWide] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 860px)').matches
      : false
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(min-width: 860px)')
    const onChange = (event) => setIsWide(event.matches)
    setIsWide(mq.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  const previousWideRef = useRef(isWide)
  useEffect(() => {
    if (previousWideRef.current === isWide) return
    previousWideRef.current = isWide
    const handle = navHandleRef.current
    navHandleRef.current = null
    try { handle?.close?.() } catch {}
    navOpenRef.current = isWide
    setNavOpen(isWide)
  }, [isWide])
  const workspaceRef = useRef(null)
  const [workspaceRatio, setWorkspaceRatio] = useState(() => {
    try {
      const value = Number(localStorage.getItem(`webstudio:workspace-ratio:${appId}`))
      if (value > 0 && value < 1) return value
    } catch {}
    return 0.5
  })
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
  // The source fingerprint as of the build currently backing the preview.
  // null = nothing built for this project yet. Compared against a fresh walk
  // when an agent turn ends, to decide whether the preview went stale.
  const builtFingerprintRef = useRef(null)
  // Guards maybeAutoBuild against overlapping runs: the fingerprint walk is
  // several awaits long, and a second turn landing mid-walk would otherwise
  // race the same build slot.
  const autoBuildingRef = useRef(false)
  // maybeAutoBuild is declared after onBuildDone (which it needs), so the
  // turn-end handler above reaches it through this ref rather than forcing a
  // reorder of the whole component body.
  const maybeAutoBuildRef = useRef(null)
  // Page notes: short instructions the user pins to elements in the Preview,
  // batched into one agent turn. Persisted per project in comments.json.
  const [notes, setNotes] = useState([])
  const [noteMode, setNoteMode] = useState(false)
  const [sendingNotes, setSendingNotes] = useState(false)
  // A short line under the preview telling the user what just happened to
  // their notes. Sending used to be silent, which read as "nothing happened".
  const [noteStatus, setNoteStatus] = useState('')
  // True while we actively watch for the agent's edits after a send.
  const [watchingAgent, setWatchingAgent] = useState(false)
  const watchUntilRef = useRef(0)
  const notesRef = useRef(notes)
  useEffect(() => { notesRef.current = notes }, [notes])
  // Serializes note writes. Two quick pins would otherwise both read the same
  // array and the second would drop the first.
  const notesWriteRef = useRef(Promise.resolve())
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

  const updateProjects = useCallback(async (mutate) => {
    const { value } = await rootStorage.updateJSON('projects.json', (current) => {
      const normalized = normalizeProjects(current)
      const base = normalized.length
        ? normalized
        : [{ id: DEFAULT_PROJECT.id, name: DEFAULT_PROJECT.name, createdAt: Date.now() }]
      return normalizeProjects(mutate(base))
    })
    const next = normalizeProjects(value)
    setProjects(next)
    return next
  }, [rootStorage])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(chatOpenKey(appId), JSON.stringify(chatOpen)) } catch {}
  }, [appId, chatOpen])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(chatRatioKey(appId), String(chatRatio)) } catch {}
  }, [appId, chatRatio])

  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(`webstudio:workspace-ratio:${appId}`, String(workspaceRatio)) } catch {}
  }, [appId, workspaceRatio])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stored = await rootStorage.get('projects.json')
        let next = normalizeProjects(stored)
        if (!next || next.length === 0) {
          next = await updateProjects((base) => base)
        } else if (!Array.isArray(stored) || next.length !== stored.length) {
          next = await updateProjects((base) => base)
        }
        if (cancelled) return
        setProjects(next)
        setProjectsLoaded(true)
        if (!next.some((p) => p.id === activeProjectId)) {
          setActiveProjectId('default')
          writeActiveProject(appId, 'default')
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
  }, [appId, activeProjectId, rootStorage, updateProjects])

  useEffect(() => {
    clearBuildPoll()
    const nextFiles = []
    filesRef.current = nextFiles
    selectedPathRef.current = null
    mainResolvedRef.current = false
    seenBuildStatusRef.current = ''
    builtFingerprintRef.current = null
    autoBuildingRef.current = false
    notesRef.current = []
    setNotes([])
    setNoteMode(false)
    mainPathRef.current = null
    fileContentRef.current = ''
    fileDirtyRef.current = false
    fileSavingRef.current = false
    setFiles(nextFiles)
    setFileCache({})
    setIndexLoaded(false)
    setSelectedPath(null)
    setFileContent('')
    setFileLoading(false)
    setFileError(null)
    setSaveError(null)
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

  // The chat panel is a bottom-pinned sheet, so a shell back gesture with it open
  // must collapse the sheet, not exit Web Studio. Register the shell back target
  // in a layout effect (BEFORE paint) keyed on chatOpen so the target is owned
  // the moment the sheet is committed — including on mount when chatOpen was
  // restored true from a prior session — with no mount→effect frame in which a
  // back gesture could escape the overlay. onBack closes the chat and nulls the
  // ref so the cleanup's close is a no-op; the ready boolean never rejects
  // (RESOLVES true=owned / false=refused/timeout), we just consume it.
  useLayoutEffect(() => {
    if (!chatOpen || !(window.mobius?.nav?.open)) return undefined
    const handle = window.mobius.nav.open('webstudio-chat', () => {
      chatNavRef.current = null
      setChatOpen(false)
    })
    chatNavRef.current = handle
    Promise.resolve(handle.ready).catch(() => false)
    return () => {
      if (chatNavRef.current === handle) {
        try { handle.close?.() } catch {}
        chatNavRef.current = null
      }
    }
  }, [chatOpen])

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

  const beginWorkspaceResize = useCallback((event) => {
    event.preventDefault()
    const workspace = workspaceRef.current
    if (!workspace) return
    const total = workspace.getBoundingClientRect().width
    if (!total) return
    const startX = event.clientX
    const startPx = total * workspaceRatio
    const divider = event.currentTarget
    const pointerId = event.pointerId
    divider.setPointerCapture?.(pointerId)
    const onMove = (moveEvent) => {
      const desiredPx = startPx + moveEvent.clientX - startX
      setWorkspaceRatio(clampChatRatio(desiredPx, total, WORKSPACE_PANE_MIN_PX))
    }
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
  }, [workspaceRatio])

  const handleWorkspaceResizeKey = useCallback((event) => {
    const total = workspaceRef.current?.getBoundingClientRect().width || 0
    if (!total) return
    const step = total * 0.05
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setWorkspaceRatio((ratio) => clampChatRatio(
        ratio * total - step, total, WORKSPACE_PANE_MIN_PX,
      ))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setWorkspaceRatio((ratio) => clampChatRatio(
        ratio * total + step, total, WORKSPACE_PANE_MIN_PX,
      ))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setWorkspaceRatio(clampChatRatio(0, total, WORKSPACE_PANE_MIN_PX))
    } else if (event.key === 'End') {
      event.preventDefault()
      setWorkspaceRatio(clampChatRatio(total, total, WORKSPACE_PANE_MIN_PX))
    }
  }, [])

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
    const handle = navHandleRef.current
    navHandleRef.current = null
    navOpenRef.current = false
    try { handle?.close?.() } catch {}
    setNavOpen(false)
  }, [])

  const openNav = useCallback(async () => {
    if (navOpenRef.current) return
    navOpenRef.current = true
    if (isWide) {
      setNavOpen(true)
      return
    }
    if (window.mobius?.nav?.open) {
      const handle = window.mobius.nav.open('webstudio-drawer', () => {
        if (navHandleRef.current !== handle) return
        navHandleRef.current = null
        navOpenRef.current = false
        setNavOpen(false)
      })
      navHandleRef.current = handle
      await handle.ready?.catch(() => false)
      if (navHandleRef.current !== handle) return
    }
    setNavOpen(true)
  }, [isWide])
  useEffect(() => { openNavRef.current = openNav }, [openNav])

  const toggleNav = useCallback(() => {
    if (navOpen) closeNav()
    else openNav()
  }, [closeNav, navOpen, openNav])

  useEffect(() => () => {
    try { navHandleRef.current?.close?.() } catch {}
    navHandleRef.current = null
  }, [])

  // Pull the canonical file list out of files-index.json. If it is absent,
  // recover it from the actual files/ tree. Offline reads come from the
  // platform-owned durable mirror.
  const refreshFiles = useCallback(async () => {
    try {
      const idx = await (online ? storage.getFresh('files-index.json') : storage.get('files-index.json'))
      if (Array.isArray(idx)) {
        const cleaned = cleanIndexPaths(idx)
        filesRef.current = cleaned
        setFiles(cleaned)
        setIndexLoaded(true)
        const currentPath = selectedPathRef.current
        const editingSelected = fileDirtyRef.current || fileSavingRef.current
        if (currentPath && !cleaned.includes(currentPath) && !editingSelected) {
          setSelectedPath(null)
          setFileContent('')
          setFileCache((prev) => {
            if (!(currentPath in prev)) return prev
            const next = { ...prev }
            delete next[currentPath]
            return next
          })
        }
      } else if (idx === null && !online) {
        return
      } else {
        if (!online) return
        const discovered = cleanIndexPaths(await storage.listFiles('files/'))
        const { value: recovered } = await storage.updateJSON('files-index.json', (current) => (
          Array.isArray(current) ? cleanIndexPaths(current) : discovered
        ))
        const cleaned = cleanIndexPaths(recovered)
        filesRef.current = cleaned
        setFiles(cleaned)
        setIndexLoaded(true)
      }
    } catch (e) {
      // Don't blank the UI on a transient read failure — keep the prior list.
    }
  }, [storage, online])

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

  // Walk the project's files/ tree and return its apps-list entries with
  // project-relative paths. The listing API is per-directory, so this is one
  // request per folder — cheap for a site, and only ever called when a turn
  // ends or a new build verdict is adopted, never on the sync poll.
  const walkSourceEntries = useCallback(async () => {
    const scope = activePrefix || ''
    const strip = (path) => (scope && path.startsWith(scope) ? path.slice(scope.length) : path)
    const out = []
    const visited = new Set()
    const visit = async (dir) => {
      // A malformed listing that names its own parent would recurse forever;
      // the visited set plus a hard ceiling keep a bad response bounded.
      if (visited.has(dir) || visited.size >= AUTO_BUILD_MAX_DIRS) return
      visited.add(dir)
      const entries = await storage.list(dir)
      if (!Array.isArray(entries)) return
      for (const entry of entries) {
        if (!entry || typeof entry.path !== 'string') continue
        const rel = strip(entry.path)
        if (entry.type === 'directory') await visit(`${rel.replace(/\/+$/, '')}/`)
        else out.push({ ...entry, path: rel })
      }
    }
    await visit('files/')
    return out
  }, [storage, activePrefix])

  // null on any failure — sourceNeedsBuild reads null as "cannot tell" and
  // refuses to build on it, so a transient listing error never steals the
  // app-wide build slot from a real build.
  const currentSourceFingerprint = useCallback(async () => {
    try {
      return sourceFingerprint(await walkSourceEntries())
    } catch {
      return null
    }
  }, [walkSourceEntries])

  // Returns true when this sync observed a NEW successful build (a fresh
  // build/status.json verdict we hadn't seen yet), so callers can react —
  // e.g. flip the view to preview after the agent finishes a turn.
  const syncProjectFromStorage = useCallback(async () => {
    if (!online) return false
    let newBuild = false
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
          // Ignore the very first observation (mount/restore of an existing
          // build); only a change from an already-seen key is a NEW build.
          if (seenBuildStatusRef.current !== '') newBuild = true
          seenBuildStatusRef.current = buildKey
          build.rememberEntry(doc, entry)
          // This verdict is the build now backing the preview — it may be one
          // the agent kicked itself. Stamp the tree it covers so the auto-build
          // below doesn't immediately rebuild what the agent already built.
          const fingerprint = await currentSourceFingerprint()
          if (fingerprint !== null) builtFingerprintRef.current = fingerprint
        }
      }
    } catch {
      // Best-effort; a missing status file just means no successful build yet.
    }
    return newBuild
  }, [
    online,
    refreshFiles,
    storage,
    build.rememberEntry,
    currentSourceFingerprint,
  ])

  useEffect(() => {
    if (!online) return undefined
    syncProjectFromStorage()
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') syncProjectFromStorage()
    }, PROJECT_SYNC_MS)
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
    setSaveError(null)
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
      setFileCache((prev) => rememberFileBody(prev, path, body))
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
        else if (body == null && online) applyMissing()
      })

    const cachedBody = fileCache[selectedPath]
    let painted = typeof cachedBody === 'string'
    if (typeof cachedBody === 'string') {
      setFileContent(cachedBody)
      setFileError(null)
      setFileLoading(false)
      setFileDirty(false)
    }

    const readLatest = () => {
      if (fileDirtyRef.current || fileSavingRef.current) return
      if (!painted) setFileLoading(true)
      setFileError(null)
      storage.get(path).then((data) => {
        if (cancelled) return
        if (data == null && !online) {
          setFileContent('')
          setFileError('Not available offline. Open this file once online to cache it.')
          setFileDirty(false)
        } else if (data == null) applyMissing()
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
      ? setInterval(() => {
        if (document.visibilityState === 'visible') readLatest()
      }, SOURCE_SYNC_MS)
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
    const newBuild = await syncProjectFromStorage()
    // The embedded agent finished a turn and we just re-synced the tree/index —
    // tells Reflection the user+agent creation loop is actually being exercised.
    signal('agent_files_changed', {})
    // The agent rebuilt the site this turn — flip to the live preview so the
    // user sees the fresh page without hunting for the Preview toggle. The
    // preview reads FRESH bytes (see HtmlPreview), so the new build renders.
    if (newBuild) setViewMode('preview')
    const path = selectedPathRef.current
    if (path && online && isTextProjectPath(path)) {
      storage.get(path).catch(() => {})
    }
    // The agent edits files/ directly and the app is what owns the build slot,
    // so nothing rebuilds the site unless we do it here. Without this an agent
    // turn leaves the source changed and the preview showing the previous
    // build — to the user, "it changed nothing".
    await maybeAutoBuildRef.current?.()
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
      const { value } = await storage.updateJSON('files-index.json', (current) => (
        cleanIndexPaths([...(Array.isArray(current) ? current : filesRef.current), path])
      ))
      const next = cleanIndexPaths(value)
      setFiles(next)
      setFileCache((prev) => rememberFileBody(prev, path, ''))
      signal('item_created', { type: 'file' })
      if (!isWide) closeNav()
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
  }, [storage, modal, closeNav, isWide, ensureIndexWritable])

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
      const { value } = await storage.updateJSON('files-index.json', (current) => (
        cleanIndexPaths([...(Array.isArray(current) ? current : filesRef.current), path])
      ))
      const next = cleanIndexPaths(value)
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
      const { value } = await storage.updateJSON('files-index.json', (current) => (
        cleanIndexPaths((Array.isArray(current) ? current : filesRef.current).filter((p) => p !== path))
      ))
      const next = cleanIndexPaths(value)
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
          setFileCache((prev) => rememberFileBody(prev, path, text))
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
        const { value } = await storage.updateJSON('files-index.json', (current) => (
          cleanIndexPaths([...(Array.isArray(current) ? current : filesRef.current), ...added])
        ))
        const next = cleanIndexPaths(value)
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
      const { value } = await storage.updateJSON('files-index.json', (current) => (
        cleanIndexPaths((Array.isArray(current) ? current : filesRef.current).map(rewrite))
      ))
      const next = cleanIndexPaths(value)
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

  const handleMoveTo = useCallback(async (path) => {
    const leaf = path.split('/').pop()
    const currentParent = path.split('/').slice(1, -1).join('/')
    const dest = await modal.prompt(
      'Destination folder — use / for the project root',
      { title: 'Move to folder', placeholder: 'css', defaultValue: currentParent },
    )
    if (dest === null) return
    const clean = String(dest || '').replace(/^\/+/, '').replace(/\/+$/, '').trim()
    const base = (!clean || clean === '.') ? 'files' : `files/${clean}`
    if (base !== 'files' && !isSafeRelPath(clean)) {
      await modal.alert('Use letters, digits, . - _ / only.', { title: 'Invalid folder' })
      return
    }
    await movePath(path, `${base}/${leaf}`)
  }, [modal, movePath])

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
      const { value } = await storage.updateJSON('files-index.json', (current) => (
        cleanIndexPaths((Array.isArray(current) ? current : filesRef.current).filter((p) => !under(p)))
      ))
      const next = cleanIndexPaths(value)
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

  // Rebuild when an agent turn (or a pending autosave) left the built site
  // stale. Deliberately app-side: the auto-build contract also lives in the
  // agent's skill, but that is prose the agent may or may not follow, and the
  // app is the only party that holds the dispatch claim and the poller. The
  // fingerprint comparison is what keeps this from firing on a pure question
  // ("what does this file do?") that changed nothing.
  const maybeAutoBuild = useCallback(async () => {
    if (!online) return
    const main = mainPathRef.current
    if (!main || !isHtmlDoc(main)) return
    // build() no-ops while a build is in flight; bailing here keeps us from
    // spending a whole tree walk to discover that.
    if (autoBuildingRef.current || build.buildStatus === 'building') return
    autoBuildingRef.current = true
    try {
      const fingerprint = await currentSourceFingerprint()
      if (!sourceNeedsBuild(fingerprint, builtFingerprintRef.current)) return
      // Stamp the tree BEFORE kicking. The build about to start covers exactly
      // this fingerprint; re-walking after it lands would instead stamp a tree
      // that may already carry newer edits and mark them built. A build that
      // fails clears this back to null (see the effect below), so a failure
      // always retries rather than latching.
      builtFingerprintRef.current = fingerprint
      signal('auto_build_started', {})
      await build.build(main, onBuildDone)
    } finally {
      autoBuildingRef.current = false
    }
  }, [online, build, currentSourceFingerprint, onBuildDone])
  useEffect(() => { maybeAutoBuildRef.current = maybeAutoBuild }, [maybeAutoBuild])

  // A failed build leaves the preview stale, so forget the tree we optimistically
  // stamped: the next turn (typically the agent's fix) must build again, even if
  // it changed nothing else.
  useEffect(() => {
    if (build.buildStatus === 'error') builtFingerprintRef.current = null
  }, [build.buildStatus])


  // ---- Page notes -------------------------------------------------------

  const readNotes = useCallback(async () => {
    try {
      return normalizeNotes(await storage.get(NOTES_PATH))
    } catch {
      // No notes yet, or a transient read. An empty list is the safe reading:
      // it shows no pins rather than inventing them.
      return []
    }
  }, [storage])

  // Load this project's notes once the project settles. Not part of the sync
  // poll — notes only change when the user or this app writes them.
  useEffect(() => {
    if (!online) return undefined
    let cancelled = false
    readNotes().then((stored) => {
      if (cancelled) return
      notesRef.current = stored
      setNotes(stored)
    })
    return () => { cancelled = true }
  }, [online, readNotes, activePrefix])

  // Every note write goes through this queue so two fast pins can't both read
  // the same array and have the second clobber the first.
  const writeNotes = useCallback((mutate) => {
    const next = notesWriteRef.current.then(async () => {
      const current = notesRef.current
      const updated = normalizeNotes(mutate(current))
      notesRef.current = updated
      setNotes(updated)
      try {
        await storage.setJSON(NOTES_PATH, updated)
      } catch {
        // The pin is already on screen and in notesRef; a failed write means
        // it won't survive a reload, which is better than dropping it now.
      }
      return updated
    })
    notesWriteRef.current = next.catch(() => notesRef.current)
    return next
  }, [storage])

  // A click landed on an element in the Preview while note mode was on.
  const handleNotePick = useCallback(async (pick) => {
    if (notesRef.current.length >= NOTES_MAX) {
      await modal.alert(
        `You can pin ${NOTES_MAX} notes at a time. Send the ones you have, `
          + 'then keep going.',
        { title: 'Note limit reached' },
      )
      return
    }
    const text = await modal.prompt(
      'What should the agent change here?',
      { title: 'Note on this element', placeholder: 'e.g. make this heading bigger' },
    )
    if (!text || !text.trim()) return
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const note = makeNote(pick, text, id)
    if (!note) return
    signal('note_added', {})
    await writeNotes((current) => [...current, note])
  }, [modal, writeNotes])

  const toggleNoteMode = useCallback(() => {
    setNoteMode((on) => {
      if (!on) signal('note_mode_opened', {})
      return !on
    })
  }, [])

  // Send the batch as ONE message into the app's own embedded chat. An app
  // token may post to a chat it created, which is exactly this chat — so the
  // notes arrive as a normal user turn and the agent answers in the panel the
  // user is already looking at.
  const handleSendNotes = useCallback(async () => {
    const pending = notesRef.current
    if (pending.length === 0 || sendingNotes) return
    const content = composeNotesMessage(pending, mainPathRef.current)
    if (!content) return
    setSendingNotes(true)
    // Open the chat BEFORE the send, not after. Mounted first, the panel
    // streams the whole turn — the user sees the agent pick the notes up, and
    // the mount can't miss the turn-done event that drives the rebuild.
    if (!chatOpen) toggleChat()
    try {
      const stored = await storage.get('chat_id.json')
      const chatId = stored && typeof stored.id === 'string' ? stored.id : ''
      if (!chatId) {
        await modal.alert(
          'The agent chat has not started yet. Open the chat panel, then send '
            + 'your notes.',
          { title: 'Chat not ready' },
        )
        return
      }
      const r = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content,
          cid: (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : `cid-${Date.now()}`,
          timezone: (() => {
            try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
          })(),
        }),
      })
      if (!r.ok) {
        signal('error', { message: `notes send → ${r.status}`, source: 'notes' })
        await modal.alert(
          `Could not send your notes (server returned ${r.status}).`,
          { title: 'Send failed' },
        )
        return
      }
      signal('notes_sent', { count: pending.length })
      // Sent notes are cleared: a pin on the page means "not yet addressed",
      // so leaving them up after handing them over would misreport the state.
      await writeNotes(() => [])
      setNoteMode(false)
      setNoteStatus(pending.length === 1
        ? 'Sent your note — the agent is working on it…'
        : `Sent ${pending.length} notes — the agent is working on them…`)
      // Watch for the agent's edits ourselves. The turn-done event is the fast
      // path; this is the safety net that makes the rebuild actually happen
      // even when the panel was mounted mid-turn and never saw it.
      watchUntilRef.current = Date.now() + AGENT_WATCH_MS
      setWatchingAgent(true)
    } catch (e) {
      await modal.alert(
        (e && e.message) || 'Could not send your notes.',
        { title: 'Send failed' },
      )
    } finally {
      setSendingNotes(false)
    }
  }, [sendingNotes, storage, token, modal, writeNotes, chatOpen, toggleChat])

  // Poll for the agent's edits while a note batch is in flight, and rebuild as
  // soon as the source changes. maybeAutoBuild is idempotent and fingerprint-
  // gated, so a tick that finds nothing new costs one tree walk and stops.
  useEffect(() => {
    if (!watchingAgent || !online) return undefined
    const tick = async () => {
      if (Date.now() > watchUntilRef.current) {
        setWatchingAgent(false)
        setNoteStatus('')
        return
      }
      if (document.visibilityState !== 'visible') return
      await syncProjectFromStorage()
      await maybeAutoBuildRef.current?.()
    }
    const id = setInterval(() => { tick().catch(() => {}) }, AGENT_WATCH_POLL_MS)
    return () => clearInterval(id)
  }, [watchingAgent, online, syncProjectFromStorage])

  // A build starting is proof the agent's edits landed, so the status line has
  // done its job — the build indicator takes over from here.
  useEffect(() => {
    if (build.buildStatus === 'building' && noteStatus) setNoteStatus('')
  }, [build.buildStatus, noteStatus])

  const handleClearNotes = useCallback(async () => {
    if (notesRef.current.length === 0) return
    const ok = await modal.confirm(
      `Discard ${notesRef.current.length} note${notesRef.current.length === 1 ? '' : 's'}?`,
      { title: 'Discard notes' },
    )
    if (!ok) return
    await writeNotes(() => [])
  }, [modal, writeNotes])

  const handleEditorChange = useCallback((value) => {
    setFileContent(value)
    setFileDirty(true)
    if (!sourceEditedRef.current) {
      sourceEditedRef.current = true
      signal('source_edited', {})
    }
    if (selectedPath) {
      setFileCache((prev) => rememberFileBody(prev, selectedPath, value))
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
        setFileCache((prev) => rememberFileBody(prev, path, body))
        setSaveError(null)
        if (fileContentRef.current === body) setFileDirty(false)
        signal('item_updated', { type: 'file' })
      }).catch((e) => {
        signal('error', { message: String(e.message || e), source: 'save' })
        if (selectedPathRef.current === path) {
          setSaveError(e.message || 'Could not save file.')
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
    setSaveError(null)
    const p = (async () => {
      try {
        await storage.setText(selectedPath, fileContent)
        setFileDirty(false)
        setFileCache((prev) => rememberFileBody(prev, selectedPath, fileContent))
        setSaveError(null)
      } catch (e) {
        signal('error', { message: String(e.message || e), source: 'save' })
        setSaveError(e.message || 'Could not save file.')
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
      setFileCache((prev) => rememberFileBody(prev, path, fileContentRef.current))
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
    builtFingerprintRef.current = null
    autoBuildingRef.current = false
    notesRef.current = []
    setNotes([])
    setNoteMode(false)
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
    setSaveError(null)
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
      if (!clean) return
      await updateProjects((base) => base.map((project) => (
        project.id === targetId && project.name !== clean
          ? { ...project, name: clean }
          : project
      )))
      signal('item_updated', { type: 'project' })
    } catch (e) {
      signal('error', { message: String(e.message || e), source: 'save' })
      await modal.alert(e.message || String(e), { title: 'Could not rename project' })
    } finally {
      setRenamingId(null)
    }
  }, [modal, updateProjects])

  const createAndRenameProject = useCallback(async () => {
    if (!projectsLoaded) {
      await modal.alert('Projects are still loading.', { title: 'Projects' })
      return
    }
    if (publishingRef.current) {
      await modal.alert('Finish publishing before creating a project.', { title: 'Publishing' })
      return
    }
    let nextProject = null
    try {
      await updateProjects((base) => {
        const name = `Project ${base.length + 1}`
        const id = projectSlug(name, new Set(base.map((project) => project.id)))
        nextProject = { id, name, createdAt: Date.now() }
        return [...base, nextProject]
      })
      const id = nextProject.id
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
  }, [modal, projectsLoaded, switchProject, updateProjects])

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
      let fallback = latest.find((p) => p.id !== targetId)?.id || 'default'
      let removed = false
      try {
        await fetch(`/api/apps/${appId}/publish?project_id=${encodeURIComponent(targetId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        })
      } catch {
        // Best-effort cleanup only.
      }
      await deleteStorageTree(rootStorage, projectPrefix(targetId))
      await updateProjects((base) => {
        const live = base.find((project) => project.id === targetId)
        if (!live || live.id === 'default' || base.length <= 1) return base
        const next = base.filter((project) => project.id !== targetId)
        fallback = next.find((project) => project.id !== targetId)?.id || 'default'
        removed = true
        return next
      })
      if (!removed) throw new Error('That project changed before it could be deleted.')
      signal('item_deleted', { type: 'project' })
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
    updateProjects,
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
      return (
        <HtmlPreview
          storage={storage}
          entryPath={entryForMain.entry}
          version={entryForMain.ver}
          noteMode={noteMode}
          notes={notes}
          onNotePick={handleNotePick}
          status={noteStatus}
        />
      )
    }
    return (
      <div className="ws-preview-note ws-build-note">
        No preview yet. Tap <b>Build</b> to assemble + render <b>{mainPath.replace(/^files\//, '')}</b>.
      </div>
    )
  }

  function renderEditor() {
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
      <div className="ws-editor-with-status">
        {saveError ? (
          <div className="ws-save-error" role="alert">
            <span>{saveError}</span>
            <button type="button" onClick={handleSaveFile} disabled={fileSaving}>
              {fileSaving ? 'Saving…' : 'Retry'}
            </button>
          </div>
        ) : null}
        <CodeEditor
          value={fileContent}
          markdown={false}
          readOnly={false}
          docKey={selectedPath}
          onChange={handleEditorChange}
        />
      </div>
    )
  }

  // The main content area follows LaTeX's responsive contract. On desktop a
  // source file sits beside the main site's render; on mobile the main HTML
  // page keeps the compact Source / Preview toggle.
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
    if (IMAGE_PREVIEW_EXTS.has(selectedExt)) {
      return <ImagePreview storage={storage} path={selectedPath} />
    }
    if (isWide && mainPath && isTextProjectPath(selectedPath)) {
      return (
        <div
          ref={workspaceRef}
          className="ws-split"
          style={{ '--ws-workspace-editor-width': `${workspaceRatio * 100}%` }}
        >
          <div className="ws-split-editor">{renderEditor()}</div>
          <div
            className="ws-workspace-divider"
            role="separator"
            aria-label="Resize source and preview areas"
            aria-orientation="vertical"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(workspaceRatio * 100)}
            tabIndex={0}
            onPointerDown={beginWorkspaceResize}
            onKeyDown={handleWorkspaceResizeKey}
          >
            <span className="ws-workspace-divider-bar" aria-hidden="true" />
          </div>
          <div className="ws-split-preview">{renderPreviewView()}</div>
        </div>
      )
    }
    // On a phone, Preview is only offered while the main page is open, so the
    // single pane never silently swaps to a different file than the title says.
    if (selectedPath === mainPath && viewMode === 'preview') return renderPreviewView()
    return renderEditor()
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

  // Is the preview actually on screen right now? This mirrors renderMain's
  // branches exactly, because "the preview is visible" is NOT the same as
  // viewMode === 'preview': on a wide screen the split shows the preview
  // beside the editor while viewMode stays 'source' (the Source/Preview
  // toggle only exists on narrow screens). Gating annotation on viewMode
  // alone hid the note button on every desktop layout.
  const canAnnotate = annotatablePreview({
    selectedPath,
    selectedExt,
    isWide,
    mainPath,
    viewMode,
    hasBuiltEntry: !!entryForMain,
  })

  // Note mode is only meaningful over a rendered preview. Closing the preview
  // (switching to Source, opening an image, a build failing) leaves the toggle
  // unreachable, so drop the mode with it rather than stranding it on.
  // MUST stay below canAnnotate: a deps array is evaluated during render, so
  // reading a `const` declared further down throws before the app can paint.
  useEffect(() => {
    if (!canAnnotate) setNoteMode(false)
  }, [canAnnotate])

  // A short informational line for the embedded chat's empty state — what the
  // agent can do, calling out a failing build when there is one.
  const guidance = useMemo(() => (
    build.buildStatus === 'error'
      ? 'The build is failing. Ask the agent to fix it, or tell it how you want to change the site.'
      : 'Tell the agent how to build or change your site — improve the design, add a page, or restructure what you have.'
  ), [build.buildStatus])

  // The live view the embedded agent scopes its first action from: which file
  // the user is looking at, whether the build is currently failing, which page
  // is main. The shell appends this to the outgoing message; whether it also
  // hides it from the rendered bubble is the shell's business, not ours.
  // Unchanged here — page notes carry their own file and element context in
  // the message the app composes, so the feature does not depend on it.
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
      <h1 className="ws-sr-only">Web Studio</h1>
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
              className="ws-brand-icon" ref={(el) => el && window.mobius.immersive && window.mobius.immersive.holdToToggle(el)}
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
          {showHtmlControls && !isWide && (
            <>
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
          {/* Annotation controls ride with the Preview: a pin is a position on
              the rendered page, so offering them over the source editor would
              promise something the Source view can't deliver. */}
          {canAnnotate && (
            <button
              type="button"
              className={`ws-toolbar-btn ${noteMode ? 'ws-toolbar-btn--active' : ''}`}
                onClick={toggleNoteMode}
                aria-pressed={noteMode}
                aria-label={noteMode ? 'Stop adding notes' : 'Add a note to the page'}
              title={noteMode
                ? 'Stop adding notes'
                : 'Add a note — click an element on the page'}
            >
              <PencilIcon size={20} />
            </button>
          )}
          {/* Send follows the NOTES, not the preview: a batch pinned and then
              left while switching to Source must stay sendable, not stranded. */}
          {notes.length > 0 && (
            <button
              type="button"
              className="ws-toolbar-btn ws-notes-send"
              onClick={handleSendNotes}
              onContextMenu={(e) => { e.preventDefault(); handleClearNotes() }}
              disabled={sendingNotes}
              aria-label={`Send ${notes.length} note${notes.length === 1 ? '' : 's'} to the agent`}
              title={sendingNotes
                ? 'Sending…'
                : `Send ${notes.length} note${notes.length === 1 ? '' : 's'} to the agent (right-click to discard)`}
            >
              {sendingNotes ? '…' : `Send ${notes.length}`}
            </button>
          )}
          {mainPath && (isWide || showHtmlControls) && (
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
        className={`${chatOpen ? 'ws-body ws-body--chat-open' : 'ws-body'} ${navOpen ? 'ws-body--drawer-open' : ''}`}
        style={chatOpen ? {
          '--ws-chat-ratio': chatRatio,
          '--ws-chat-pane-min': `${CHAT_PANE_MIN_PX}px`,
        } : undefined}
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
          onMoveTo={handleMoveTo}
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
          pinned={isWide}
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
              guidance={guidance}
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
