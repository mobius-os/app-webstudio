import { useEffect, useRef } from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, keymap } from '@codemirror/view'
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands'
import { sourceKind, sourceTokens } from '../source-syntax.js'

const cmThemePlain = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)', lineHeight: '1.6', fontSize: '13.5px' },
  '.cm-content': { padding: '14px 16px 30vh', caretColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)' },
  '.cm-syn-comment': { color: 'var(--code-comment)', fontStyle: 'italic' },
  '.cm-syn-string': { color: 'var(--code-string)' },
  '.cm-syn-keyword': { color: 'var(--code-keyword)', fontWeight: '650' },
  '.cm-syn-literal': { color: 'var(--code-literal)' },
  '.cm-syn-number': { color: 'var(--code-number)' },
  '.cm-syn-tag': { color: 'var(--code-tag)' },
})

function sourceHighlight(path) {
  if (!sourceKind(path)) return []
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view) }
    update(update) {
      if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view)
    }
    build(view) {
      const marks = []
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.sliceDoc(from, to)
        for (const token of sourceTokens(path, text)) {
          marks.push(Decoration.mark({ class: token.className }).range(from + token.from, from + token.to))
        }
      }
      return Decoration.set(marks, true)
    }
  }, { decorations: (plugin) => plugin.decorations })
}

function buildPlainExtensions(onDocChange, path) {
  return [
    history(),
    sourceHighlight(path),
    EditorView.lineWrapping,
    keymap.of([indentWithTab, ...historyKeymap, ...defaultKeymap]),
    cmThemePlain,
    EditorView.updateListener.of((u) => { if (u.docChanged) onDocChange(u.state.doc.toString()) }),
  ]
}

// ----------------------------------------------------------------------
// CodeMirror React wrapper. Mounts an EditorView whose extension stack is
// chosen by `markdown` (live-preview vs plain monospace). `value` seeds the
// doc; an EXTERNAL change (open a different file, or the agent edited the file
// and a SWR revalidation re-read it) replaces the whole doc — but only when the
// user isn't the one who just typed it. We track the last value emitted by
// local typing in `lastEmitted` so a parent re-render that echoes our own
// onChange back as `value` does NOT reset the cursor (this is what fixes Web
// Studio's old cursor-jump on each SWR poll). The view is rebuilt only when
// `markdown`/`docKey` change (different file or syntax mode), because the
// extension stack differs. `readOnly` is NOT a rebuild trigger: a transient
// readOnly flip (meta briefly null on agent reload) would tear down the view
// and reset the caret to position 0. Instead read-only is reconfigured live
// through a Compartment, leaving the view (and cursor) intact.
//
// Web Studio passes markdown={false} always — buildMarkdownExtensions is not
// imported here, so the markdown branch is unreachable and intentionally absent.
// ----------------------------------------------------------------------
export function CodeEditor({ value, markdown: isMd, readOnly, docKey, onChange }) {
  const host = useRef(null)
  const view = useRef(null)
  const onChangeRef = useRef(onChange)
  const lastEmitted = useRef(value)
  const roCompartment = useRef(null)
  if (roCompartment.current === null) roCompartment.current = new Compartment()
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  // Rebuild the view when the file (docKey) or the syntax mode (markdown)
  // changes. Read-only lives in a compartment (reconfigured below), so a
  // readOnly flip does NOT rebuild. Editing the same file just dispatches doc
  // changes (effect further below).
  useEffect(() => {
    const emit = (text) => {
      lastEmitted.current = text
      if (onChangeRef.current) onChangeRef.current(text)
    }
    const base = buildPlainExtensions(emit, docKey)
    const extensions = [
      ...base,
      roCompartment.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    ]
    const state = EditorState.create({ doc: value || '', extensions })
    const v = new EditorView({ state, parent: host.current })
    view.current = v
    lastEmitted.current = value || ''
    return () => { v.destroy(); view.current = null }
    // value/readOnly are intentionally omitted: a docKey change carries the new
    // file's value (reacting to value would rebuild on every keystroke), and
    // readOnly is reconfigured via the compartment effect below, not a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, isMd])

  // Read-only toggled for the SAME view (meta resolved/cleared on reload) —
  // reconfigure the compartment in place. No view rebuild, so the cursor stays.
  useEffect(() => {
    const v = view.current
    if (!v) return
    v.dispatch({
      effects: roCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    })
  }, [readOnly])

  // External value change for the SAME file (agent edit re-read, or a
  // revalidation) — replace the doc, but skip our own echo so typing isn't
  // interrupted and the cursor doesn't jump.
  useEffect(() => {
    const v = view.current
    if (!v) return
    if (value == null) return
    if (value === lastEmitted.current) return
    const cur = v.state.doc.toString()
    if (value === cur) return
    v.dispatch({ changes: { from: 0, to: cur.length, insert: value } })
    lastEmitted.current = value
  }, [value])

  return <div ref={host} className="ws-cm-host" />
}
