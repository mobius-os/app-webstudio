export const CSS = `
/* mobius-ui:Root v1 — keep in sync; library candidate. Diverge below the marker only. */
.ws-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  /* Overlay scrims + shadows as local tokens so the raw rgba(0,0,0,…) values
     live in one place (and read against the dark theme rather than being
     scattered literals). */
  --ws-scrim: rgba(0, 0, 0, 0.45);
  --ws-scrim-soft: rgba(0, 0, 0, 0.35);
  --ws-shadow: rgba(0, 0, 0, 0.3);
  background: var(--bg, #111614);
  color: var(--text, #eef7f1);
  font-family: var(--font, Inter, ui-sans-serif, system-ui, sans-serif);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
  overscroll-behavior: contain;
}
/* /mobius-ui:Root */

/* mobius-ui:Focus v1 -- shared keyboard focus ring (WCAG 2.4.7); never bare outline:none */
:where(button,a,input,textarea,select,summary,[role="button"],[tabindex]:not([tabindex="-1"])):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* /mobius-ui:Focus */

/* mobius-ui:Toolbar v1 — keep in sync with app-latex (unprefixed) */
/* Two-zone bar: minmax(0,1fr) | auto lets the left zone (drawer toggle +
   filename) flex + truncate while the right zone sizes to its action cluster
   ([Build][view toggle]). */
.ws-top-bar {
  position: relative;
  z-index: 11;
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  /* Top-pinned bar: clear the iPhone notch / Dynamic Island and pad the sides
     past the rounded-corner / gesture insets on a full-screen PWA. */
  padding: max(6px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) 6px max(10px, env(safe-area-inset-left));
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  user-select: none;
}
.ws-top-zone {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.ws-top-zone--left { justify-content: flex-start; }
.ws-top-zone--right { justify-content: flex-end; }
.ws-nav-toggle {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  min-height: 44px;
  padding: 0;
  border-radius: 8px;
  /* Bare like the shell's .shell__brand logo-toggle: no border, no
     background box, no focus ring. The always-visible bounding box that
     used to sit here (border + background) was the owner-reported
     highlight that lingered after closing the drawer. */
  border: none;
  background: none;
  color: var(--text);
  font-size: 16px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  -webkit-user-select: none;
  user-select: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
/* Suppress only the UA mouse-focus outline (the owner-reported lingering box
   after closing the drawer); keyboard focus still gets the shared :focus-visible
   ring so a tabbing user sees where they are. */
.ws-nav-toggle:focus:not(:focus-visible) { outline: none; }
.ws-nav-toggle:active { opacity: 0.7; }
/* Drawer-toggle box-highlight (feature 142): neutral wash on hover/focus,
   accent wash while the file drawer is open, on the rounded 8px button. */
@media (hover: hover) {
  .ws-nav-toggle:hover { background: var(--surface2, var(--bg-alt, var(--surface))); }
}
.ws-nav-toggle:focus-visible { background: var(--surface2, var(--bg-alt, var(--surface))); }
/* The real app icon as the brand mark inside the drawer toggle. Sized to the
   34px Möbius brand mark so every mini-app header icon matches the shell. */
.ws-brand-icon {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  object-fit: cover;
  flex-shrink: 0;
  display: block;
}
/* Accent-dot fallback shown when the install has no custom icon (route 404s). */
.ws-brand-fallback {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent, var(--text));
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.ws-top-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ws-project-label {
  flex: 0 1 auto;
  max-width: 140px;
  color: var(--text);
  font: 650 12px/1.2 var(--font);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ws-top-path {
  font-family: var(--font);
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ws-top-path--muted { color: var(--muted); font-weight: 400; }
/* Icon-only toolbar buttons: square 44x44 tap targets (same recipe as
   app-latex's .toolbar-btn). */
.ws-toolbar-btn {
  width: 44px;
  height: 44px;
  min-height: 44px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ws-toolbar-btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-fg);
}
.ws-toolbar-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.ws-toolbar-btn:active { background: var(--surface2, var(--surface)); }
.ws-toolbar-btn--primary:active { background: color-mix(in srgb, var(--accent) 80%, #000); }
@media (hover: hover) {
  .ws-toolbar-btn:hover:not(:disabled) { background: var(--surface2, var(--surface)); }
  .ws-toolbar-btn--primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 85%, #000); }
}
.ws-chat-toggle-btn[aria-pressed="true"] {
  background: color-mix(in srgb, var(--accent) 18%, var(--surface));
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}
/* Build-button spinner (BuildingIndicator) — same recipe as app-latex. */
@keyframes ws-building-spin { to { transform: rotate(360deg); } }
.ws-building-spin {
  animation: ws-building-spin 1.1s linear infinite;
  transform-origin: center;
}

/* ---- source/preview view toggle: ONE segmented pill (same recipe as
   app-latex's .seg-toggle). The WRAPPER carries the border + rounded
   outline + inset track; the two segments are borderless and the active
   one fills with a neutral raised surface (like an iOS segmented control),
   reserving the accent tint for the Build button. ---- */
.ws-seg-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg);
}
.ws-seg-btn {
  width: 44px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* Borderless segments inside the pill wrapper; the wrapper owns the
     outer border. Slightly tighter radius than the wrapper so the active
     fill nests cleanly inside the 2px track. */
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ws-seg-btn--active {
  background: var(--surface2, var(--surface));
  color: var(--text);
}
.ws-seg-btn:active { background: var(--surface2, var(--surface)); }
@media (hover: hover) {
  .ws-seg-btn:hover:not(.ws-seg-btn--active) { background: var(--surface); color: var(--text); }
}
/* /mobius-ui:Toolbar */

/* ---- body: content area + bounded chat, stacked ----
   position: relative so the absolutely-positioned file drawer + its backdrop
   resolve against THIS box — i.e. they overlay only the area below the top
   bar, leaving the logo drawer toggle always tappable. */
.ws-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  overflow: hidden;
}
.ws-content {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}
/* ---- source editor ----
   The CodeMirror EditorView mounts inside .ws-cm-host. The host is a flex child
   that fills the content area and clips its own overflow; CodeMirror's internal
   .cm-scroller does the scrolling (cmThemePlain sets the monospace font + the
   2px accent caret), so the host itself needs no padding or font. */
.ws-cm-host {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  overflow: hidden;
  background: var(--bg);
}

/* Managed .json files render read-only with an inline notice above the
   source — editing them as text/plain would corrupt them for typed-JSON
   readers, so the editor never autosaves them. */
.ws-editor-readonly {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.ws-readonly-note {
  flex: 0 0 auto;
  padding: 8px 16px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--muted);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.ws-editor-readonly .ws-cm-host { cursor: default; }

/* ---- empty / notes ---- */
.ws-preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  color: var(--muted);
  gap: 8px;
  padding: 24px;
}
.ws-preview-empty-title { font-size: 26px; font-weight: 700; color: var(--text); letter-spacing: 0; }
.ws-preview-empty-body { font-size: 14px; line-height: 1.5; max-width: 320px; }

.ws-preview-note {
  color: var(--muted);
  font-size: 13px;
  padding: 24px 18px;
  text-align: center;
  line-height: 1.55;
}
.ws-preview-note b { color: var(--text); }
.ws-preview-retry {
  min-height: 44px;
  padding: 10px 22px;
  border-radius: 10px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--accent-fg);
  font-family: var(--font);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.ws-preview-retry:active { transform: scale(0.97); }
.ws-build-note { padding: 32px 18px; }

/* ---- build failure ---- */
.ws-build-error {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
}
.ws-build-error-title {
  font-weight: 700;
  color: var(--danger, var(--accent));
  font-size: 14px;
}
.ws-build-log {
  max-height: 60vh;
  overflow: auto;
  overscroll-behavior: contain;
  margin: 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---- image preview ---- */
.ws-img-preview {
  display: block;
  max-width: 100%;
  margin: 18px auto;
  border-radius: 6px;
}

/* ---- html preview (in-app browser) ----
   The built site renders inside a sandboxed iframe via srcdoc. The iframe
   itself keeps a white backdrop (most generated pages assume a light page),
   but the area BEHIND it stays the calm dark --surface2 so there is no hard
   white slab between builds; the iframe fades in over it (see below). */
.ws-preview {
  position: relative;
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--surface2, var(--surface));
}
.ws-preview .ws-preview-note {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface2, var(--surface));
}
/* Gentle fade so the white page eases in over the dark chrome instead of
   popping on every Build/refresh (the reduced-motion guard neutralizes it). */
@keyframes ws-preview-in { from { opacity: 0; } to { opacity: 1; } }
.ws-preview-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
  animation: ws-preview-in 0.18s ease both;
}

/* mobius-ui:FileTree v1 — keep in sync; library candidate. Diverge below the marker only. */
/* ---- file drawer ---- */
.ws-drawer-scrim {
  position: absolute;
  inset: 0;
  background: var(--ws-scrim-soft);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
  z-index: 10;
}
.ws-drawer-scrim--open { opacity: 1; pointer-events: auto; }
.ws-file-drawer {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 78%;
  max-width: 320px;
  background: var(--surface);
  color: var(--text);
  border-right: 1px solid var(--border);
  transform: translateX(-100%);
  transition: transform 0.22s ease;
  z-index: 11;
  display: flex;
  flex-direction: column;
}
.ws-file-drawer--open { transform: translateX(0); }
/* While the finger drags, kill the transform-transition so the panel tracks
   the finger 1:1; removing the class lets the snap/close animate normally. */
.ws-file-drawer--dragging { transition: none; }
.ws-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 52px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  user-select: none;
}
.ws-drawer-head-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ws-drawer-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  line-height: 1.2;
}
.ws-project-picker {
  position: relative;
  flex: 0 1 auto;
  min-width: 0;
}
.ws-project-trigger {
  max-width: 170px;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font: 650 12px/1.2 var(--font);
  cursor: pointer;
}
.ws-project-trigger svg {
  flex: 0 0 auto;
  transform: rotate(90deg);
  color: var(--muted);
}
.ws-project-trigger-name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ws-project-trigger[aria-expanded="true"] {
  color: var(--accent);
  background: var(--accent-dim, color-mix(in srgb, var(--accent) 12%, transparent));
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}
.ws-project-trigger[aria-expanded="true"] svg {
  color: var(--accent);
}
.ws-project-rename-input {
  max-width: 170px;
  min-height: 36px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font: 650 12px/1.2 var(--font);
  outline: none;
}
.ws-project-rename-input:focus {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.ws-project-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 65;
  width: min(264px, 82vw);
  max-height: min(420px, 70vh);
  overflow: auto;
  padding: 5px;
  border: 1px solid var(--border-light, var(--border));
  border-radius: 12px;
  background: var(--bg);
  box-shadow: 0 8px 28px var(--ws-scrim-soft);
}
.ws-project-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ws-project-item,
.ws-project-action {
  width: 100%;
  min-height: 40px;
  padding: 7px 9px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--text);
  text-align: left;
  font: 550 13px/1.2 var(--font);
  cursor: pointer;
}
.ws-project-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-decoration: none;
}
.ws-project-item-name {
  display: block;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.3;
}
.ws-project-item--active {
  background: var(--accent-dim);
  color: var(--accent);
}
.ws-project-action--danger { color: var(--danger); }
.ws-project-action:disabled {
  opacity: 0.45;
  cursor: default;
}
.ws-project-item:active,
.ws-project-action:active:not(:disabled) {
  background: var(--surface2, var(--surface));
}
.ws-project-loading {
  min-height: 40px;
  display: flex;
  align-items: center;
  padding: 7px 9px;
  color: var(--muted);
  font-size: 13px;
}
.ws-drawer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2px;
  padding: 4px 6px 4px 12px;
  border-bottom: 1px solid var(--border);
}
.ws-files-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--muted);
}
.ws-files-actions { display: flex; gap: 2px; }
.ws-drawer-publish {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.ws-drawer-publish-actions {
  display: flex;
  gap: 6px;
}
.ws-drawer-publish-btn {
  flex: 1 1 0;
  min-width: 0;
  min-height: 40px;
  padding: 7px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font: 600 12px/1.2 var(--font);
  text-decoration: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ws-drawer-publish-btn--wide {
  width: 100%;
}
.ws-drawer-publish-btn:active:not(:disabled) {
  background: var(--surface2, var(--surface));
}
.ws-drawer-publish-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.ws-drawer-publish-link {
  justify-content: center;
}
.ws-drawer-publish-url {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--muted);
  font: 12px/1.45 var(--mono);
  overflow-wrap: anywhere;
}
.ws-drawer-btn {
  flex: 1 1 0;
  min-height: 44px;
  padding: 7px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ws-drawer-btn:active { background: var(--surface2, var(--surface)); }
.ws-drawer-btn:disabled { opacity: 0.45; cursor: default; }
.ws-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; padding: 0;
  border-radius: 7px; border: 1px solid transparent;
  background: transparent; color: var(--muted);
  cursor: pointer; -webkit-tap-highlight-color: transparent; touch-action: manipulation;
}
.ws-icon-btn:hover { background: var(--surface2, var(--surface)); color: var(--text); }
.ws-icon-btn:active:not(:disabled) { background: var(--surface3, var(--surface2)); transform: scale(0.94); }
.ws-icon-btn:disabled { opacity: 0.3; cursor: default; }
.ws-icon-btn--danger:hover { color: var(--danger, #f87171); }
.ws-project-row {
  display: flex; align-items: center; gap: 4px;
  padding: 7px 8px 7px 10px;
  border-bottom: 1px solid var(--border);
}
.ws-project-row .ws-project-picker { flex: 1 1 auto; min-width: 0; }
.ws-project-row .ws-project-trigger { width: 100%; max-width: none; justify-content: space-between; }
.ws-project-row .ws-project-rename-input { width: 100%; max-width: none; }
.ws-project-row-actions { display: flex; gap: 0; flex: 0 0 auto; }
.ws-drawer-syncing {
  padding: 8px 14px;
  font-size: 12px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}
.ws-drawer-tree {
  flex: 1 1 auto;
  overflow-y: auto;
  /* Side gutter so the rounded rows float as pills inset from the panel
     edge, matching the Möbius shell drawer (.drawer__body's 8px side
     padding) rather than sitting full-bleed against the border. */
  padding: 8px 6px;
  overscroll-behavior: contain;
  user-select: none;
}
.ws-drawer-empty {
  padding: 16px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
}
/* Each tree row pairs the (flex-growing) file/folder button with a trailing
   ⋯ menu button. The row is the hover unit so the menu button reveals with the
   row on a pointer device; on touch it is always visible (see below). */
.ws-tree-row {
  display: flex;
  align-items: stretch;
  width: 100%;
  gap: 2px;
}
.ws-tree-file, .ws-tree-folder {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 44px;
  padding: 7px 12px;
  /* Rounded pill like the shell drawer's .drawer__item (10px) — the row
     floats inside the .ws-drawer-tree side gutter rather than full-bleed. */
  border-radius: 10px;
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
  font-family: var(--font);
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
/* Mouse-focus only: keyboard focus keeps the custom inset-accent ring below. */
.ws-tree-file:focus:not(:focus-visible),
.ws-tree-folder:focus:not(:focus-visible) { outline: none; }
/* Per-file ⋯ actions button. Faint until the row is hovered/focused so it does
   not compete with the filename; on touch (no hover) it stays visible so the
   actions are discoverable without a long-press. */
.ws-tree-menu-btn {
  flex: 0 0 auto;
  width: 40px;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  /* Rounded hit area like the shell drawer's .drawer__more kebab (8px)
     so its hover/open/press washes read as a rounded chip, not square. */
  border-radius: 8px;
  background: none;
  color: var(--muted);
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.12s, color 0.12s, background 0.12s, transform 0.08s;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ws-tree-row:hover .ws-tree-menu-btn,
.ws-tree-menu-btn:focus-visible { opacity: 1; }
/* Hover is a NEUTRAL grey wash (same family as the press), not an accent
   tint — accent is reserved for the open state below. */
.ws-tree-menu-btn:hover {
  color: var(--text);
  background: var(--surface);
}
/* Pressed — NEUTRAL feedback. The press must not re-assert the open-state
   accent; it acknowledges the tap with a grey wash + scale (touch has no
   hover, and tap-highlight is suppressed), matching the shell kebab. */
.ws-tree-menu-btn:active {
  color: var(--text);
  background: var(--surface);
  transform: scale(0.92);
}
.ws-tree-menu-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* Open trigger — accent is reserved for the open menu only. While this row's
   action menu is open the kebab stays lit and accent-tinted (and fully
   opaque), the same treatment the shell drawer's kebab gets via
   data-state="open". Because background is in the transition, the wash fades
   in lockstep with the color instead of snapping (the #6 flash fix). */
.ws-tree-menu-btn[data-state="open"] {
  opacity: 1;
  color: var(--accent);
  background: var(--accent-dim, color-mix(in srgb, var(--accent) 12%, transparent));
}
@media (hover: none) {
  .ws-tree-menu-btn { opacity: 1; }
}
@media (hover: hover) {
  /* Hover is a NEUTRAL surface wash — same as the shell drawer's
     .drawer__item:hover (var(--surface)). Accent is reserved for the
     selected/active row, not for hover. */
  .ws-tree-file:hover, .ws-tree-folder:hover {
    background: var(--surface);
  }
}
/* Keyboard focus ring — matches the shell drawer's .drawer__item
   :focus-visible (2px accent outline, 2px offset). Replaces the old
   inset accent bar, which we dropped along with the square selection. */
.ws-tree-file:focus-visible, .ws-tree-folder:focus-visible {
  background: var(--surface);
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.ws-tree-file:active, .ws-tree-folder:active {
  background: var(--surface2, var(--bg));
}
/* Selected row: a rounded accent wash, matching the shell drawer's
   .drawer__item--active (var(--accent-dim) fill + accent text). No
   square fill and no left inset bar — the shell uses the wash alone. */
.ws-tree-file--selected {
  background: var(--accent-dim);
  color: var(--accent);
}
.ws-tree-file--selected .ws-tree-icon { color: var(--accent); }
/* Compact accent dot marking the main page row (no text chip). */
.ws-tree-main-dot {
  margin-left: auto;
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
/* Discoverable "set as main page" affordance: a muted accent dot on the right
   of every non-main HTML row, brightening on hover/focus. It's the visible
   twin of the context-menu's "Set as main page" item. A real <button> sibling
   of the row (next to the kebab), so it resets the UA button chrome the same
   way .ws-tree-menu-btn does. */
.ws-tree-set-main {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 7px;
  background: none;
  color: var(--muted);
  opacity: 0.55;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ws-tree-set-main:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.ws-tree-set-main-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--muted);
}
.ws-tree-set-main:hover,
.ws-tree-set-main:focus-visible {
  opacity: 1;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.ws-tree-set-main:hover .ws-tree-set-main-dot,
.ws-tree-set-main:focus-visible .ws-tree-set-main-dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.ws-tree-file[draggable="true"] { cursor: grab; }
/* Drop-target highlight while a drag hovers a folder or the root. */
.ws-tree-drop-active {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.ws-tree-root {
  min-height: 40px;
}
.ws-tree-group {
  display: block;
}
/* /mobius-ui:FileTree */

/* mobius-ui:ContextMenu v1 — keep in sync; library candidate. Diverge below the marker only. */
/* In-app context menu (right-click / long-press). position: fixed so its
   left/top (set from the pointer's viewport coords) land exactly under the
   finger regardless of which positioned ancestor it renders inside. */
.ws-ctx-menu {
  position: fixed;
  z-index: 60;
  min-width: 160px;
  padding: 4px;
  background: var(--bg);
  /* Match the shell drawer's .drawer__menu popover: softer outer radius
     (12px) over a hairline --border-light edge. */
  border: 1px solid var(--border-light);
  border-radius: 12px;
  box-shadow: 0 8px 28px var(--ws-scrim-soft);
  display: flex;
  flex-direction: column;
  gap: 2px;
  user-select: none;
}
.ws-ctx-item {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 8px 10px;
  text-align: left;
  border: none;
  /* Inner items match the shell drawer's .drawer__menu-item radius (8px)
     so a hovered item rhymes with the row's rounded selection. */
  border-radius: 8px;
  background: none;
  color: var(--text);
  font: 550 13px/1.2 var(--font);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ws-ctx-item:active { background: var(--surface2, var(--surface)); }
.ws-ctx-item--danger { color: var(--danger); }
/* /mobius-ui:ContextMenu */
/* Bare file/folder glyph — a lucide SVG with no bounding box, fill, or boxed
   padding (matches the shell's icons). It inherits the row's text color so it
   tints to --accent on the selected row exactly like the shell. */
.ws-tree-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  color: var(--muted);
  flex: 0 0 auto;
}
.ws-tree-icon svg { display: block; }
/* Folder chevron points right when collapsed, rotates down when expanded. */
.ws-tree-chevron {
  transition: transform 0.12s ease;
}
.ws-tree-chevron--open {
  transform: rotate(90deg);
}
.ws-tree-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/* mobius-ui:ChatEmbed v1 — keep in sync with app-latex (unprefixed) */
/* ---- chat panel (bottom half of the 50/50 split) ----
   The embedded shell chat runs inside an iframe (window.mobius.chat). The
   panel takes EXACTLY the height --ws-chat-ratio allots it (no internal
   min/max fighting the divider) and is a flex column; the embed fills it
   (flex:1 + min-height:0) and the iframe fills the embed, so the chat's
   composer is pinned to the bottom of the panel. */
.ws-chat-panel {
  flex: 0 0 auto;
  height: calc(var(--ws-chat-ratio, 0.5) * 100%);
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  overflow: hidden;
  overscroll-behavior: contain;
  /* Bottom-pinned sheet: lift the embedded chat composer above the iPhone
     home-indicator / Android gesture bar on a full-screen PWA. */
  padding-bottom: env(safe-area-inset-bottom);
}
/* The draggable divider ("glider") between content and chat: a SLIM 10px
   visual bar; the ::before overlay extends the pointer hit area to ~26px
   without adding visual weight. z-index keeps the overlay above the
   adjacent panes so the extra hit area actually receives the pointer. */
.ws-chat-divider {
  flex: 0 0 10px;
  height: 10px; /* explicit: keep in sync with app-latex (grid ignores flex-basis) */
  box-sizing: border-box;
  position: relative;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ns-resize;
  background: var(--surface);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  touch-action: none;
  user-select: none;
}
.ws-chat-divider::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -8px;
  bottom: -8px;
}
.ws-chat-divider:hover,
.ws-chat-divider:focus-visible {
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
}
.ws-chat-divider:focus-visible { outline-offset: -2px; }
.ws-chat-divider-bar {
  width: 44px;
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 65%, transparent);
  pointer-events: none;
}
.ws-chat-embed {
  flex: 1 1 auto;
  min-height: 0;          /* the flexbox overflow fix — lets the iframe scroll internally */
  overflow: hidden;
  background: var(--bg);
}
.ws-chat-embed iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
.ws-chat-error {
  flex: 0 0 auto;
  margin: 8px 14px 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--text);
  font-size: 12px;
}
/* /mobius-ui:ChatEmbed */

/* mobius-ui:Sheet v1 — keep in sync; library candidate. Diverge below the marker only. */
/* ---- modal ---- */
.ws-modal-scrim {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ws-scrim);
  z-index: 50;
  padding: 16px;
}
.ws-modal {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 32px var(--ws-shadow);
  width: 100%;
  max-width: 360px;
  padding: 18px 20px;
}
.ws-modal-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 8px;
}
.ws-modal-body {
  font-size: 14px;
  line-height: 1.5;
  color: var(--text);
  margin-bottom: 14px;
}
.ws-modal-input {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 9px 11px;
  font-size: 16px;
  font-family: var(--font);
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 14px;
  box-sizing: border-box;
}
/* Mouse/programmatic focus keeps just the accent border below; keyboard focus
   additionally gets the shared :focus-visible ring. */
.ws-modal-input:focus:not(:focus-visible) { outline: none; }
.ws-modal-input:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.ws-modal-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.ws-modal-option {
  min-height: 44px;
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font: 600 13px/1.2 var(--font);
  text-align: left;
  cursor: pointer;
}
.ws-modal-option:disabled {
  opacity: 0.45;
  cursor: default;
}
.ws-modal-option--danger { color: var(--danger); }
.ws-publish-url {
  padding: 10px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: 12px/1.45 var(--mono);
  overflow-wrap: anywhere;
}
.ws-publish-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.ws-publish-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
}
.ws-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.ws-modal-btn {
  min-height: 44px;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--font);
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
.ws-modal-btn:active { opacity: 0.8; }
.ws-modal-btn--primary {
  background: var(--accent);
  color: var(--accent-fg);
  border-color: var(--accent);
}
.ws-modal-btn--danger {
  background: var(--danger);
  color: var(--accent-fg);
  border-color: var(--danger);
}
.ws-modal-btn--secondary { background: var(--surface); }
/* /mobius-ui:Sheet */

/* mobius-ui:SyncPill v1 — keep in sync; library candidate. Diverge below the marker only. */
/* ---- sync pill ----
   Hidden in the steady state (online + 0 pending); only appears when there's
   something to say. Same shape as the latex + atlas apps so the platform
   feels coherent. */
.ws-sync-pill {
  position: absolute;
  /* Floating default (un-floated to static in the header below): keep the pill
     clear of the iPhone home-indicator / Android gesture bar. */
  right: max(12px, env(safe-area-inset-right));
  bottom: max(12px, env(safe-area-inset-bottom));
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  z-index: 40;
  box-shadow: 0 2px 8px var(--ws-shadow);
  pointer-events: auto;
}
.ws-sync-pill-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
}
.ws-sync-pill--pending .ws-sync-pill-dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
}
.ws-sync-pill--offline {
  border-color: var(--accent);
  color: var(--accent);
}
.ws-sync-pill--offline .ws-sync-pill-dot {
  background: var(--accent);
}

/* The SyncPill component defaults to a floating bottom-right pill. Here it
   lives inline in the header, so un-float it. */
.ws-top-zone--right .ws-sync-pill {
  position: static;
  right: auto;
  bottom: auto;
  z-index: auto;
  box-shadow: none;
  white-space: nowrap;
}
/* /mobius-ui:SyncPill */

/* mobius-ui:ReducedMotion v1 -- honor the OS reduce-motion setting */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
/* /mobius-ui:ReducedMotion */
`
