export function SyncPill({ online, pending, hasRuntime }) {
  if (!hasRuntime) return null
  if (online && pending === 0) return null
  const label = !online
    ? (pending > 0 ? `Offline · ${pending} pending` : 'Offline')
    : null
  if (!label) return null
  return (
    <div
      className="ws-sync-pill ws-sync-pill--offline"
      role="status"
      aria-live="polite"
      title="Changes save locally and sync when you're back online."
    >
      <span className="ws-sync-pill-dot" aria-hidden="true" />
      {label}
    </div>
  )
}

// ----------------------------------------------------------------------
// CodeMirror source editor — a parallel copy of the plain editor in the Editor
// app (app-editor/index.jsx), kept VERBATIM so both apps stay consistent. Web
// Studio edits HTML/CSS/JS source, so only the plain-text path is used (no
// markdown live-preview, no KaTeX, no syntax highlighting): `markdown` is
// always false and `buildPlainExtensions` is the only stack.
//
// A plain-text theme for source — monospace, no markdown highlighting, no live
