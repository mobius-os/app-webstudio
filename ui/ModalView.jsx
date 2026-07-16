import { useEffect, useMemo, useRef, useState } from 'react'

// Each open modal needs a stable, unique id to wire aria-labelledby from the
// dialog container to its title node. A module counter (not useId, which the
// pinned React build here doesn't export) keeps the id stable across renders.
let wsModalTitleSeq = 0

export function ModalView({ state }) {
  const [value, setValue] = useState(state.kind === 'prompt' ? (state.defaultValue || '') : '')
  const inputRef = useRef(null)
  const dialogRef = useRef(null)
  // Capture the opener once, at mount, before focus moves into the dialog —
  // this is the element focus returns to on close. A ref (not state) because it
  // must survive every render without being a dependency.
  const openerRef = useRef(null)
  const titleId = useMemo(() => `ws-modal-title-${wsModalTitleSeq++}`, [])

  function cancel() {
    // Escape / scrim / shell-back must resolve the SAME back-value the Cancel
    // button and useModal's own back-value use for each kind: undefined for
    // alert, null for prompt AND choose (a dismissed choose picked nothing),
    // false only for confirm. Collapsing choose into the confirm branch made
    // Escape resolve false while Cancel resolved null — an inconsistent verdict.
    if (state.kind === 'alert') state.resolve()
    else if (state.kind === 'prompt' || state.kind === 'choose') state.resolve(null)
    else state.resolve(false)
  }

  // A custom dialog has to carry its own focus contract — role="dialog" alone
  // does not move focus in on open, trap Tab, close on Escape, or restore the
  // opener on close. We own all four here.
  useEffect(() => {
    openerRef.current = document.activeElement
    if (state.kind === 'prompt' && inputRef.current) {
      // Autofocus + select-all so the user can replace any prefilled value
      // with a single keypress.
      inputRef.current.focus()
      inputRef.current.select()
    } else {
      // Land focus inside the dialog so keyboard/AT users aren't stranded on
      // the inert content behind the scrim.
      dialogRef.current?.querySelector(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )?.focus()
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        cancel()
        return
      }
      if (e.key !== 'Tab') return
      // Trap Tab/Shift+Tab to the dialog's focusable set so focus can't wander
      // to the inert editor behind the scrim. Computed per-keydown because the
      // prompt input and action labels change which nodes are focusable.
      const focusable = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const opener = openerRef.current
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus()
      }
    }
  }, [state])
  function onSubmit(e) {
    e.preventDefault()
    if (state.kind === 'prompt') state.resolve(value)
    else if (state.kind === 'confirm') state.resolve(true)
    else if (state.kind === 'choose') state.resolve(null)
    else state.resolve()
  }
  return (
    <div className="ws-modal-scrim" onClick={cancel}>
      <div className="ws-modal" ref={dialogRef} onClick={(e) => e.stopPropagation()}
           role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <form onSubmit={onSubmit}>
          <div className="ws-modal-title" id={titleId}>{state.title}</div>
          <div className="ws-modal-body">{state.body}</div>
          {state.kind === 'prompt' && (
            <input
              ref={inputRef}
              className="ws-modal-input"
              type="text"
              aria-label={state.title}
              name="modal_response"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={state.placeholder}
            />
          )}
          {state.kind === 'choose' && (
            <div className="ws-modal-options">
              {(state.actions || []).map((action) => (
                <button
                  key={String(action.value ?? action.label)}
                  type="button"
                  className={`ws-modal-option ${action.danger ? 'ws-modal-option--danger' : ''}`}
                  disabled={!!action.disabled}
                  onClick={() => state.resolve(action.value)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
          <div className="ws-modal-actions">
            {(state.kind === 'confirm' || state.kind === 'prompt' || state.kind === 'choose') && (
              <button
                type="button"
                className="ws-modal-btn ws-modal-btn--secondary"
                onClick={() => state.resolve(state.kind === 'confirm' ? false : null)}
              >
                Cancel
              </button>
            )}
            {state.kind !== 'choose' && (
              <button
                type="submit"
                className={`ws-modal-btn ${state.danger ? 'ws-modal-btn--danger' : 'ws-modal-btn--primary'}`}
              >
                {state.kind === 'confirm' ? (state.danger ? 'Delete' : 'OK') : 'OK'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------
// localStorage snapshot of the file index + recently-viewed file contents
// so an offline reload paints SOMETHING. Same shape as the LaTeX/news
// read-cache: small, per-app, deliberately not a write store.
