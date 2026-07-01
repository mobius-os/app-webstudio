import { useEffect, useState } from 'react'

export function ImagePreview({ storage, path }) {
  const [url, setUrl] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let live = true
    let revoke = null
    setUrl(null); setErr(null)
    storage.getBlob(path).then((blob) => {
      if (!live || !blob) {
        if (live) setErr('Image could not be loaded.')
        return
      }
      const u = URL.createObjectURL(blob)
      revoke = u
      setUrl(u)
    }).catch((e) => {
      if (live) setErr(e.message || 'Image load failed.')
    })
    return () => {
      live = false
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [storage, path])
  if (err) return <div className="ws-preview-note">{err}</div>
  if (!url) return <div className="ws-preview-note">Loading image…</div>
  return <img className="ws-img-preview" src={url} alt={path} />
}

// ----------------------------------------------------------------------
// HTML preview — the in-app browser (replaces LaTeX's pdf.js canvas).
//
// After a successful build we render the built page inside a SANDBOXED
// iframe via `srcdoc`. The sandbox grants `allow-scripts allow-popups
// allow-popups-to-escape-sandbox` only — NOT allow-same-origin (so the
// generated site can't read this app's localStorage / token or hit /api),
// NOT allow-modals (untrusted generated HTML shouldn't be able to
// alert/confirm-spam). allow-popups-to-escape-sandbox exists for external
// links: without it a target=_blank tab would INHERIT the sandbox and the
// external site would load with no same-origin (broken cookies/storage).
//
// Because there's no same-origin and no server route for build/site/,
// a plain `<a href>`/`<link href>`/`<script src>` inside the srcdoc has
// no base to resolve against. So we INLINE the page's same-build assets:
// fetch each referenced file that lives under build/site/ via storage and
// rewrite the reference to a blob:/data: URL the iframe can load without
// any origin. CSS is inlined into a <style>; JS into a blob-URL <script>;
// images/fonts into blob URLs; url() refs inside inline styles rewritten.
//
// Links inside the preview:
//   - same-site links to another BUILT PAGE (about.html, sub/, /pricing.html,
//     and the site root itself — "/" or "../" — which serves index.html)
//     navigate WITHIN the preview: a tiny injected script preventDefaults the
//     click and postMessages the resolved build/site/ path up to this
//     component, which re-renders the preview at that page (srcdoc can't
//     resolve relative navigation natively — there is no base URL).
//   - external links (http/https or //) get target=_blank rel=noopener
//     injected so they open in a NEW TAB instead of navigating (and killing)
//     the srcdoc preview.
//   - every OTHER schemeless link — a non-page asset, a ref that escapes the
//     site, anything unresolvable — is neutralised (href removed, inert
//     click) rather than left to natively navigate the frame away. Only
//     #anchors and ALLOWLISTED schemes (mailto:, tel:) keep native behavior;
//     dangerous schemes (javascript:, data:, vbscript:, …) are neutralised.
// The full policy is anchorActionFor below.
//
// `version` (the build token) is in the deps so a rebuild that produces
// the SAME deterministic entry path still refetches + re-renders the
// fresh bytes (and resets any in-preview navigation back to the entry).
// ----------------------------------------------------------------------

// Resolve an asset reference (possibly relative, ./ or bare) against the
// directory of the page being previewed, returning a storage path under
// build/site/ — or null if it escapes the site, is absolute (http/data),
