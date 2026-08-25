// Shared scalar constants for Web Studio storage, previews, chat, and polling.
export const NAME_RE = /^[\w.\-/]+$/
export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
export const BINARY_FILE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'pdf', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'mp4', 'webm'])
export const LONG_PRESS_MS = 500
export const LONG_PRESS_SLOP = 10
export const FILE_CONTENT_CACHE_LIMIT = 20
export const CHAT_OPEN_VERSION = 1
export const CHAT_RATIO_VERSION = 1
export const DEFAULT_PROJECT = { id: 'default', name: 'Project 1' }
export const CHAT_PILL_MIN_PX = 64
export const CHAT_DIVIDER_PX = 10
export const CHAT_PANE_MIN_PX = CHAT_PILL_MIN_PX + CHAT_DIVIDER_PX
export const WORKSPACE_PANE_MIN_PX = 220
export const BUILD_POLL_MS = 2000
export const BUILD_TIMEOUT_MS = 120000
// How long to let a freshly-written dispatch claim settle before reading it
// back to confirm we won the single build slot (see useBuild.build).
export const BUILD_CLAIM_SETTLE_MS = 150
export const SOURCE_AUTOSAVE_MS = 700
export const SOURCE_SYNC_MS = 3500
export const PROJECT_SYNC_MS = 5000
// Ceiling on directories walked when fingerprinting files/ for the turn-end
// auto-build. A site nests a handful of folders deep; this only exists so a
// malformed listing can't spin the walk forever.
export const AUTO_BUILD_MAX_DIRS = 200

// ---- Page notes (comment-on-the-page steering) -------------------------
// Notes the user pins to elements in the Preview, batched and sent to the
// embedded agent as one instruction set. Stored per project.
export const NOTES_PATH = 'comments.json'
// Postmessage types across the sandboxed preview boundary. Namespaced the
// same way WS_PREVIEW_NAV_TYPE is, so a stray message from the site's own
// script can't be mistaken for one of ours.
export const WS_NOTE_MODE_TYPE = 'ws-preview-note-mode'
export const WS_NOTE_PICK_TYPE = 'ws-preview-note-pick'
// A note is a short steering instruction, not a document. The cap keeps one
// pin readable in the composed agent message and bounds comments.json.
export const NOTE_MAX_CHARS = 280
// Ceiling on pins per project. Past this the batch stops being one coherent
// instruction set and the agent does better with a typed request.
export const NOTES_MAX = 20
// Longest element text snippet carried into the agent message. Enough to
// identify the element, short enough that 20 notes stay scannable.
export const NOTE_LABEL_MAX_CHARS = 60

// Extensions renderMain shows with ImagePreview instead of the editor/preview
// split. Shared with domain.annotatablePreview so the "is the preview on
// screen?" predicate can never drift from the branch that actually renders it.
export const IMAGE_PREVIEW_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico',
])

// After handing notes to the agent we actively watch for its edits instead of
// relying only on the chat's turn-done event: the panel can be mounted mid-turn
// (or remounted) and miss it, which would leave the page edited but never
// rebuilt. Bounded so a turn that never lands stops costing polls.
export const AGENT_WATCH_MS = 240000
export const AGENT_WATCH_POLL_MS = 6000
