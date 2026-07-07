import { useCallback, useEffect, useRef, useState } from 'react'
import { signal } from '../analytics.js'
import { BUILD_CLAIM_SETTLE_MS, BUILD_POLL_MS, BUILD_TIMEOUT_MS } from '../constants.js'
import {
  buildTargetSuperseded,
  claimIsOurs,
  entryFromBuildStatusForDoc,
  entryPathForHtmlDoc,
  foreignClaimBlocks,
  isHtmlDoc,
} from '../domain.js'

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
  // True while THIS instance holds the app-wide dispatch claim (build/
  // dispatch.json) — see build() for why builds are serialized app-wide.
  const claimedRef = useRef(false)
  // Start time of the in-flight build, for build_completed's duration_ms. Only
  // a real build() sets it; a restore (rememberEntry) never emits the signal.
  const buildStartRef = useRef(0)

  // Emit build_completed with the elapsed time — build failures are the most
  // actionable Web Studio friction, so Reflection tracks status + duration.
  const signalBuildCompleted = useCallback((status) => {
    const started = buildStartRef.current
    buildStartRef.current = 0
    if (!started) return
    signal('build_completed', { status, duration_ms: Date.now() - started })
  }, [])

  const releaseClaim = useCallback(() => {
    if (!claimedRef.current) return
    claimedRef.current = false
    // Best-effort: drop our dispatch claim the moment the build settles so a
    // legitimate next build (here or on another device) isn't blocked for the
    // full timeout window waiting for the claim to age out.
    rootStorage.remove('build/dispatch.json').catch(() => {})
  }, [rootStorage])

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
    releaseClaim()
    buildingRef.current = false
    setBuildStatus('idle')
    setBuildLog('')
    setBuildDoc(null)
    setEntryByDoc({})
  }, [prefix, clearPoll, releaseClaim])

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
      releaseClaim()
      signalBuildCompleted('error')
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
        releaseClaim()
        signalBuildCompleted('done')
        finishDone(doc, entry)
        if (typeof onDone === 'function' && entry) onDone(doc, entry)
        return
      }
      releaseClaim()
      signalBuildCompleted('error')
      finishError(status.log || 'Build failed.')
      return
    }
    // No verdict yet. /run-job's build.sh reads a single shared ROOT
    // build/target.txt; once it no longer names OUR target, a concurrent build
    // has taken the one build slot and this verdict will never land. Fail fast
    // with an actionable message rather than waiting out the full 2-minute
    // timeout (the silent-timeout symptom). A transient read failure (offline
    // blip) is ignored — the deadline above still bounds the wait.
    try {
      const rootTarget = await rootStorage.getFresh('build/target.txt')
      if (generation !== buildGenerationRef.current) return
      if (buildTargetSuperseded(rootTarget, `${prefix || ''}${doc}`)) {
        releaseClaim()
        signalBuildCompleted('error')
        finishError('Another build superseded this one — retry when it finishes.')
        return
      }
    } catch (e) {
      // Keep polling; the deadline is the backstop.
    }
    pollRef.current = setTimeout(() => poll(doc, onDone, generation), BUILD_POLL_MS)
  }, [storage, rootStorage, prefix, finishDone, finishError, releaseClaim, signalBuildCompleted])

  // Kick a build for `doc` (a "files/<entry>.html" path). onDone fires once the
  // site is assembled. Guards against concurrent builds + offline.
  const build = useCallback(async (doc, onDone) => {
    if (buildingRef.current) return
    if (!isHtmlDoc(doc)) return
    if (!online) {
      finishError('You are offline. Building needs a connection — reconnect and try again.')
      return
    }
    const myTarget = `${prefix || ''}${doc}`
    // Serialize builds app-wide. /run-job carries no project context, so build.sh
    // reads a single shared ROOT build/target.txt — there is exactly one build
    // slot per app. Two near-simultaneous builds (another tab/device) must not
    // both write that target, or build.sh builds the later one while the first
    // poller waits for a verdict that never lands and then times out (the silent
    // 2-minute symptom). Two guards, in order:
    //   1. Pre-check (below): a fresh claim for a DIFFERENT target already in
    //      flight → refuse now, WITHOUT touching that live claim.
    //   2. Claim-first-then-read-back (in the try): write our own claim BEFORE
    //      the shared root target, settle, then read it back — last-writer-wins
    //      means exactly one of two simultaneous starters reads its own target
    //      back; the other refuses before it can strand the winner's poller.
    // Best-effort still: a start that slips past the settle window is caught by
    // the poller's fail-fast on the root target (see poll), which turns a would-
    // be silent timeout into an actionable "superseded" message. A fully race-
    // free fix needs per-project dispatch through the run-job API (backend).
    try {
      const claim = await rootStorage.getFresh('build/dispatch.json')
      if (foreignClaimBlocks(claim, myTarget, Date.now(), BUILD_TIMEOUT_MS)) {
        finishError('Another page is building right now (possibly on another '
          + 'device). Wait for it to finish, then Build again.')
        return
      }
    } catch {
      // Couldn't read the claim — proceed rather than block a legitimate build.
    }
    clearPoll()
    buildingRef.current = true
    buildStartRef.current = Date.now()
    const generation = buildGenerationRef.current
    setBuildDoc(doc)
    setBuildStatus('building')
    setBuildLog('')
    try {
      // 0. Clear any verdict from a PRIOR build so the first poll sees 404
      // (still building) until the new run lands a fresh verdict.
      await storage.remove('build/status.json')
      // 1. Record the per-project target (durable app state). build.sh itself
      // reads the shared ROOT target written in step 3, only after we confirm we
      // hold the slot — so this per-project write is bookkeeping, not the trigger.
      await storage.setText('build/target.txt', doc)
      // 2. Claim the dispatch slot FIRST, then confirm by reading it back after a
      // short settle. Writing the claim before the shared root target is what
      // closes the read-then-write race: if another instance overwrote our claim
      // in the settle window, the read-back names ITS target and we refuse here —
      // before writing the root target that would strand its poller.
      claimedRef.current = true
      await rootStorage.setJSON('build/dispatch.json', { target: myTarget, at: Date.now() })
      await new Promise((resolve) => setTimeout(resolve, BUILD_CLAIM_SETTLE_MS))
      const readback = await rootStorage.getFresh('build/dispatch.json')
      if (!claimIsOurs(readback, myTarget)) {
        // Another instance won the slot. Refuse cleanly — do NOT releaseClaim()
        // (that would delete THEIR live claim); just drop our own intent and
        // reset the transient build state, mirroring the pre-check refuse.
        claimedRef.current = false
        buildStartRef.current = 0
        finishError('Another page is building right now (possibly on another '
          + 'device). Wait for it to finish, then Build again.')
        return
      }
      // 3. We hold the slot: point the shared ROOT target (what build.sh reads,
      // possibly a projects/<id>/ subtree) at us, then kick the job.
      await rootStorage.setText('build/target.txt', myTarget)
      // 4. Kick the server-side job. 202 = accepted; anything else is fatal.
      const r = await fetch(`/api/apps/${appId}/run-job`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (r.status !== 202) {
        let detail = ''
        try { detail = (await r.json()).detail || '' } catch { /* non-JSON body */ }
        releaseClaim()
        signal('error', { message: `run-job → ${r.status}`, source: 'build-start' })
        signalBuildCompleted('error')
        finishError(
          `Could not start the build (server returned ${r.status}${detail ? `: ${detail}` : ''}).`,
        )
        return
      }
      // 5. Poll status.json until the script writes its verdict (or a concurrent
      // build supersedes our root target — poll() fails fast on that).
      deadlineRef.current = Date.now() + BUILD_TIMEOUT_MS
      pollRef.current = setTimeout(() => poll(doc, onDone, generation), BUILD_POLL_MS)
    } catch (e) {
      releaseClaim()
      signal('error', { message: String((e && e.message) || e), source: 'build-start' })
      signalBuildCompleted('error')
      finishError((e && e.message) ? e.message : 'Build failed to start.')
    }
  }, [appId, token, storage, rootStorage, prefix, online, clearPoll, finishError, poll, releaseClaim, signalBuildCompleted])

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
        let changed = false
        const next = {}
        for (const [doc, rec] of Object.entries(prev)) {
          const nextDoc = rewrite(doc)
          // An UNCHANGED doc keeps its built entry. A renamed/moved doc's built
          // output still sits at the OLD build/site path — the source moved but
          // no rebuild ran — so remapping the key to build/site/<new> would
          // point the preview at a file that does not exist. Drop the entry
          // instead so the preview asks for a fresh Build, not a phantom fetch.
          if (nextDoc === doc) next[doc] = rec
          else changed = true
        }
        return changed ? next : prev
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
