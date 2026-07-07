// Shared scalar constants for Web Studio storage, previews, chat, and polling.
export const NAME_RE = /^[\w.\-/]+$/
export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
export const BINARY_FILE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'pdf', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'mp4', 'webm'])
export const LONG_PRESS_MS = 500
export const LONG_PRESS_SLOP = 10
export const FILE_CONTENT_CACHE_LIMIT = 20
export const FILE_CACHE_VERSION = 1
export const CHAT_OPEN_VERSION = 1
export const CHAT_RATIO_VERSION = 1
export const DEFAULT_PROJECT = { id: 'default', name: 'Project 1' }
export const CHAT_PILL_MIN_PX = 64
export const CHAT_DIVIDER_PX = 10
export const CHAT_PANE_MIN_PX = CHAT_PILL_MIN_PX + CHAT_DIVIDER_PX
export const BUILD_POLL_MS = 2000
export const BUILD_TIMEOUT_MS = 120000
// How long to let a freshly-written dispatch claim settle before reading it
// back to confirm we won the single build slot (see useBuild.build).
export const BUILD_CLAIM_SETTLE_MS = 150
export const SOURCE_AUTOSAVE_MS = 700
export const SOURCE_SYNC_MS = 3500
export const PROJECT_SYNC_MS = 5000
