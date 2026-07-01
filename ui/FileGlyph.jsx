import { fileKind } from '../domain.js'

export function FileGlyph({ name, size = 16 }) {
  const kind = fileKind(name)
  // Shared document outline (a page with a dog-eared corner) for non-image
  // kinds; the image kind draws a picture frame instead.
  const sharedProps = {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
    strokeLinejoin: 'round', 'aria-hidden': true,
  }
  if (kind === 'image') {
    return (
      <svg {...sharedProps}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <path d="m21 16-5-5L5 20" />
      </svg>
    )
  }
  const page = <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
  const fold = <path d="M14 3v5h5" />
  return (
    <svg {...sharedProps}>
      {page}
      {fold}
      {/* Inner mark distinguishes the file type while staying inside the page. */}
      {kind === 'code' && <path d="m10 13-2 2 2 2M14 13l2 2-2 2" />}
      {kind === 'json' && <path d="M11 12c-1 0-1.5.5-1.5 1.5S9 15 8 15c1 0 1.5.5 1.5 1.5S10 18 11 18M13 12c1 0 1.5.5 1.5 1.5S15 15 16 15c-1 0-1.5.5-1.5 1.5S14 18 13 18" />}
      {kind === 'html' && <path d="M9 13.5 7.5 15 9 16.5M15 13.5 16.5 15 15 16.5M13 12.5l-2 5" />}
      {kind === 'css' && <path d="M9 17c.5.6 1.4 1 2.3 1 1.2 0 2.2-.7 2.2-1.6 0-2-4.2-1.3-4.2-3.2 0-.9 1-1.5 2.1-1.5.8 0 1.6.3 2 .9" />}
      {kind === 'file' && <path d="M9 14h6M9 17h4" />}
    </svg>
  )
}
