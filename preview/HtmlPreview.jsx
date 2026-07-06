import { useEffect, useRef, useState } from 'react'
import { signal } from '../analytics.js'
import { isSafeRelPath } from '../domain.js'
import {
  anchorActionFor,
  readWithRetry,
  resolveSiteAsset,
  WS_PREVIEW_NAV_SCRIPT,
  WS_PREVIEW_NAV_TYPE,
} from './previewDomain.js'

export function HtmlPreview({ storage, entryPath, version }) {
  const [srcDoc, setSrcDoc] = useState(null)
  const [err, setErr] = useState(null)
  const [loading, setLoading] = useState(true)
  // Bumped by the Retry button to re-run the render effect after a failed
  // load, so a flaky read doesn't permanently brick the preview frame.
  const [reloadTick, setReloadTick] = useState(0)
  const createdUrlsRef = useRef([])
  const frameRef = useRef(null)
  // The page currently shown — starts at the build's entry and changes when
  // the user follows a same-site page link inside the preview. A new build
  // (version) or a different entry resets it.
  const [pageEntry, setPageEntry] = useState(entryPath)
  useEffect(() => { setPageEntry(entryPath) }, [entryPath, version])

  // Accept navigation messages only from OUR iframe, and only to paths we
  // stamped at injection time (under build/site/, structurally safe).
  useEffect(() => {
    const onMessage = (event) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const data = event.data
      if (!data || data.type !== WS_PREVIEW_NAV_TYPE) return
      const next = typeof data.path === 'string' ? data.path : ''
      if (!next.startsWith('build/site/')) return
      if (!isSafeRelPath(next.slice('build/site/'.length))) return
      setPageEntry(next)
      signal('preview_page_viewed', { via: 'internal-nav' })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    let cancelled = false
    setErr(null); setLoading(true); setSrcDoc(null)
    // Revoke any blob URLs from the previous render before building new ones.
    for (const u of createdUrlsRef.current) URL.revokeObjectURL(u)
    createdUrlsRef.current = []

    const track = (url) => { createdUrlsRef.current.push(url); return url }

    // Fetch a same-build asset as a blob: URL (images/fonts/binary) or as
    // text (css/js) depending on extension. Memoised per path so a page that
    // references one stylesheet from multiple rules fetches it once.
    const assetCache = new Map()
    const blobUrlFor = async (sitePath) => {
      if (assetCache.has(sitePath)) return assetCache.get(sitePath)
      const p = (async () => {
        const blob = await storage.getBlob(sitePath)
        if (!blob) return null
        return track(URL.createObjectURL(blob))
      })()
      assetCache.set(sitePath, p)
      return p
    }
    const textFor = async (sitePath) => storage.getText(sitePath)

    // Rewrite url(...) references inside a CSS string to blob URLs so an
    // inlined stylesheet's background-images / @font-face still load.
    const rewriteCssUrls = async (css) => {
      const URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g
      const refs = new Set()
      let m
      while ((m = URL_RE.exec(css)) !== null) refs.add(m[2].trim())
      // Resolve each unique ref to a blob URL first, then replace ONLY the
      // exact url(...) token. A plain substring replace (split/join) would
      // also corrupt a longer ref that merely CONTAINS a shorter one — e.g.
      // rewriting img/a.png would also hit img/a.png.webp.
      const map = new Map()
      for (const ref of refs) {
        const sitePath = resolveSiteAsset(ref, pageEntry)
        if (!sitePath) continue
        try {
          const url = await blobUrlFor(sitePath)
          if (url) map.set(ref, url)
        } catch { /* leave the original ref; it just won't load */ }
      }
      if (!map.size) return css
      return css.replace(URL_RE, (whole, q, ref) => {
        const url = map.get(ref.trim())
        return url ? `url(${q}${url}${q})` : whole
      })
    }

    ;(async () => {
      try {
        // readWithRetry (module level) holds the retry contract — the main
        // page is the one read whose failure bricks the whole frame.
        const html = await readWithRetry(
          () => storage.getText(pageEntry),
          { isCancelled: () => cancelled },
        )
        if (cancelled) return
        if (html == null) throw new Error('Built page could not be loaded. Try Build again.')

        // Parse in a detached document so we can walk + rewrite refs without
        // ever attaching (and thus executing) anything in THIS document.
        const doc = new DOMParser().parseFromString(html, 'text/html')

        // <link rel="stylesheet" href="..."> → inline <style> (with its own
        // url() refs rewritten). Same-build only; external CDN links stay.
        for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
          const sitePath = resolveSiteAsset(link.getAttribute('href'), pageEntry)
          if (!sitePath) continue
          try {
            const css = await textFor(sitePath)
            if (cancelled) return
            if (css == null) continue
            const style = doc.createElement('style')
            style.textContent = await rewriteCssUrls(css)
            link.replaceWith(style)
          } catch { /* keep the original link */ }
        }

        // <style> blocks already in the page: rewrite their url() refs.
        for (const style of Array.from(doc.querySelectorAll('style'))) {
          if (!style.textContent) continue
          try { style.textContent = await rewriteCssUrls(style.textContent) } catch { /* keep as-is */ }
        }

        // <script src="..."> → fetch the JS and inline it AS TEXT (drop the
        // src), exactly like <link rel=stylesheet> is inlined into a <style>
        // above. A blob: URL src is the obvious move but it is silently broken
        // here: the preview is a sandboxed srcdoc with NO allow-same-origin, so
        // its document origin is opaque/null and the browser FORBIDS loading a
        // blob: (or any) URL from a null-origin document ("Not allowed to load
        // local resource: blob:… @ about:srcdoc"). The site's JS — and every
        // link/interaction it wires up — then never runs in the preview. Inline
        // <script> text executes under allow-scripts with no origin needed, so
        // setting textContent and removing src restores the site's behavior.
        for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
          const sitePath = resolveSiteAsset(script.getAttribute('src'), pageEntry)
          if (!sitePath) continue
          try {
            const js = await textFor(sitePath)
            if (cancelled) return
            if (js == null) continue
            script.textContent = js
            script.removeAttribute('src')
          } catch { /* keep the original src */ }
        }

        // <img src>, <source src>, <video poster>, <audio src>, <use href> …
        // → blob URLs. Covers the common same-build media refs.
        const mediaSelectors = [
          ['img', 'src'], ['source', 'src'], ['source', 'srcset'],
          ['video', 'poster'], ['video', 'src'], ['audio', 'src'],
          ['image', 'href'], ['use', 'href'],
        ]
        for (const [sel, attr] of mediaSelectors) {
          for (const el of Array.from(doc.querySelectorAll(`${sel}[${attr}]`))) {
            const val = el.getAttribute(attr)
            // srcset is a comma-separated list; only single refs are handled
            // here (best-effort — a multi-candidate srcset is left untouched).
            if (attr === 'srcset' && val && val.includes(',')) continue
            const sitePath = resolveSiteAsset(val, pageEntry)
            if (!sitePath) continue
            try {
              const url = await blobUrlFor(sitePath)
              if (cancelled) return
              if (url) el.setAttribute(attr, url)
            } catch { /* keep the original ref */ }
          }
        }

        // <a href> handling — anchorActionFor (module level) holds the policy
        // and its contract; this loop just applies the action to the detached
        // DOM. Internal links keep their href so they still style as links;
        // the injected script preventDefaults + postMessages the stamped path.
        for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
          const href = (a.getAttribute('href') || '').trim()
          const action = anchorActionFor(href, pageEntry)
          if (action.kind === 'external') {
            a.setAttribute('target', '_blank')
            a.setAttribute('rel', 'noopener noreferrer')
          } else if (action.kind === 'internal') {
            a.setAttribute('data-ws-internal', action.target)
          } else if (action.kind === 'neutralise') {
            a.setAttribute('data-ws-asset', href)
            a.removeAttribute('href')
          }
        }
        // The click interceptor for data-ws-internal links (see above).
        const navScript = doc.createElement('script')
        navScript.textContent = WS_PREVIEW_NAV_SCRIPT
        ;(doc.body || doc.documentElement).appendChild(navScript)

        if (cancelled) return
        const serialized = `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
        setSrcDoc(serialized)
        setLoading(false)
      } catch (e) {
        if (!cancelled) {
          setErr((e && e.message) || 'Preview failed to render.')
          setLoading(false)
        }
      }
    })()

    return () => { cancelled = true }
  }, [storage, pageEntry, version, reloadTick])

  // Revoke blob URLs on unmount.
  useEffect(() => () => {
    for (const u of createdUrlsRef.current) URL.revokeObjectURL(u)
    createdUrlsRef.current = []
  }, [])

  if (err) {
    return (
      <div className="ws-preview-note">
        <p style={{ margin: '0 0 14px' }}>{err}</p>
        <button
          type="button"
          className="ws-preview-retry"
          onClick={() => { setErr(null); setLoading(true); setReloadTick((t) => t + 1) }}
        >
          Retry
        </button>
      </div>
    )
  }
  return (
    <div className="ws-preview">
      {loading && <div className="ws-preview-note">Rendering preview…</div>}
      {srcDoc != null && (
        <iframe
          ref={frameRef}
          className="ws-preview-frame"
          title="Site preview"
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          srcDoc={srcDoc}
        />
      )}
    </div>
  )
}

// ----------------------------------------------------------------------
// File tree. We maintain files-index.json as the canonical list of
// paths, because the storage API doesn't expose a per-app listing
// endpoint. The agent is told (via the system prompt) to keep the
// index up to date when it creates/deletes files; the UI also writes
// to it whenever the user adds or removes a file from inside the app.
// ----------------------------------------------------------------------
