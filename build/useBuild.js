import { useCallback, useEffect, useRef, useState } from 'react'
import { BUILD_POLL_MS, BUILD_TIMEOUT_MS } from '../constants.js'
import { entryFromBuildStatusForDoc, entryPathForHtmlDoc, isHtmlDoc } from '../domain.js'

export function useBuild({ appId, token, storage, rootStorage, prefix, online }) {
  const [buildStatus, setBuildStatus] = useState('idle') // idle|building|done|error
  const [buildLog, setBuildLog] = useState('')
  // Which page the current/last build is FOR. The hook tracks one build at a
  // time; this lets the viewer scope "Building…" / "Build failed" to the doc
  // that's actually compiling.
  const [buildDoc, setBuildDoc] = useState(null)
  // doc path → { entry, ver }. `ver` is a monotonic per-build token (see
  // finishDone) so the viewer refetches even when the entry path is unchanged.
  const [entryByDoc, setEntryByDoc] = useState({})
  const pollRef = useRef(null)
  const deadlineRef = useRef(0)
  const buildSeqRef = useRef(0)
  const buildGenerationRef = useRef(0)
  const buildingRef = useRef(false)

  const clearPoll = useCallback(() => {
    buildGenerationRef.current += 1
    if (pollRef.current) {
      clearTimeout(pollRef.current)
      pollRef.current = null
    }
    deadlineRef.current = 0
    // An orphaned in-flight build's poll will never reach finishDone/Error
    // (its generation is now stale), so its buildingRef would stay stuck true
    // and block all future builds. Release it here.
    buildingRef.current = false
  }, [])

  useEffect(() => clearPoll, [clearPoll])

  useEffect(() => {
    clearPoll()
    buildingRef.current = false
    setBuildStatus('idle')
    setBuildLog('')
    setBuildDoc(null)
    setEntryByDoc({})
  }, [prefix, clearPoll])

  const finishDone = useCallback((doc, entry) => {
    clearPoll()
    buildingRef.current = false
    setBuildStatus('done')
    setBuildLog('')
    if (doc && entry) {
      // Stamp a fresh token on every successful build. The entry path is
      // deterministic per doc, so a rebuild yields the identical string;
      // the token gives each build a new value identity so HtmlPreview
      // refetches the fresh bytes.
      const ver = (buildSeqRef.current += 1)
      setEntryByDoc((prev) => ({ ...prev, [doc]: { entry, ver } }))
    }
  }, [clearPoll])

  const finishError = useCallback((log) => {
    clearPoll()
    buildingRef.current = false
    setBuildStatus('error')
    setBuildLog(log || 'Build failed.')
  }, [clearPoll])

  // One poll tick: read build/status.json. 404/null → still building (or the
  // cap elapsed → error). A verdict object → done/error.
  const poll = useCallback(async (doc, onDone, generation) => {
    if (generation !== buildGenerationRef.current) return
    if (Date.now() > deadlineRef.current) {
      finishError('Build timed out (over 2 minutes). Try again, or check the '
        + 'files are valid.')
      return
    }
    let status = null
    try {
      status = await storage.get('build/status.json')
    } catch (e) {
      status = null
    }
    if (generation !== buildGenerationRef.current) return
    if (status && typeof status === 'object' && status.status) {
      // The verdict echoes the target it was built FROM. build/target.txt +
      // build/status.json are one shared pair per app, so a build kicked from
      // another tab/device for a DIFFERENT doc can land its verdict here. If
      // it isn't the doc we're waiting on, ignore it and keep polling.
      if (status.target && status.target !== doc) {
        pollRef.current = setTimeout(() => poll(doc, onDone, generation), BUILD_POLL_MS)
        return
      }
      if (status.status === 'done') {
        const entry = entryFromBuildStatusForDoc(status, doc) || entryPathForHtmlDoc(doc)
        finishDone(doc, entry)
        if (typeof onDone === 'function' && entry) onDone(doc, entry)
        return
      }
      finishError(status.log || 'Build failed.')
      return
    }
    pollRef.current = setTimeout(() => poll(doc, onDone, generation), BUILD_POLL_MS)
  }, [storage, finishDone, finishError])

  // Kick a build for `doc` (a "files/<entry>.html" path). onDone fires once the
  // site is assembled. Guards against concurrent builds + offline.
  const build = useCallback(async (doc, onDone) => {
    if (buildingRef.current) return
    if (!isHtmlDoc(doc)) return
    if (!online) {
      finishError('You are offline. Building needs a connection — reconnect and try again.')
      return
    }
    clearPoll()
    buildingRef.current = true
    const generation = buildGenerationRef.current
    setBuildDoc(doc)
    setBuildStatus('building')
    setBuildLog('')
    try {
      // 0. Clear any verdict from a PRIOR build so the first poll sees 404
      // (still building) until the new run lands a fresh verdict.
      await storage.remove('build/status.json')
      // 1. Tell the build script which page is the entry.
      await storage.setText('build/target.txt', doc)
      // 1b. /run-job invokes build.sh with only appId, so the script reads a
      // root dispatch target that can point at either the legacy root project
      // or a projects/<id>/ subtree. The actual per-project target above is
      // still the durable storage key used by the app.
      await rootStorage.setText('build/target.txt', `${prefix || ''}${doc}`)
      // 2. Kick the server-side job. 202 = accepted; anything else is fatal.
      const r = await fetch(`/api/apps/${appId}/run-job`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (r.status !== 202) {
        let detail = ''
        try { detail = (await r.json()).detail || '' } catch { /* non-JSON body */ }
        finishError(
          `Could not start the build (server returned ${r.status}${detail ? `: ${detail}` : ''}).`,
        )
        return
      }
      // 3. Poll status.json until the script writes its verdict.
      deadlineRef.current = Date.now() + BUILD_TIMEOUT_MS
      pollRef.current = setTimeout(() => poll(doc, onDone, generation), BUILD_POLL_MS)
    } catch (e) {
      finishError((e && e.message) ? e.message : 'Build failed to start.')
    }
  }, [appId, token, storage, rootStorage, prefix, online, clearPoll, finishError, poll])

  const rememberEntry = useCallback((doc, entry) => {
    if (buildingRef.current) return
    if (!doc || !entry) return
    setBuildDoc(doc)
    finishDone(doc, entry)
  }, [finishDone])

  return {
    buildStatus, buildLog, buildDoc, entryByDoc, build, rememberEntry, clearPoll,
    forgetDoc: useCallback((doc) => {
      setEntryByDoc((prev) => {
        if (!(doc in prev)) return prev
        const next = { ...prev }
        delete next[doc]
        return next
      })
    }, []),
    rewriteDocs: useCallback((rewrite) => {
      setEntryByDoc((prev) => {
        const next = {}
        for (const [doc, rec] of Object.entries(prev)) {
          // The doc key follows the rename; the built entry lives under
          // build/site/ keyed by the source-relative path, so it also moves.
          const movedEntry = `build/site/${rewrite(doc).slice('files/'.length)}`
          next[rewrite(doc)] = { ...rec, entry: movedEntry }
        }
        return next
      })
    }, []),
    forgetUnder: useCallback((prefix) => {
      setEntryByDoc((prev) => {
        let changed = false
        const next = {}
        for (const [doc, rec] of Object.entries(prev)) {
          if (doc === prefix || doc.startsWith(`${prefix}/`)) { changed = true; continue }
          next[doc] = rec
        }
        return changed ? next : prev
      })
    }, []),
  }
}

// ----------------------------------------------------------------------
// Top-level app.
