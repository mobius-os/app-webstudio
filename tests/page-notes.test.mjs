import test from 'node:test'
import assert from 'node:assert/strict'
import { composeNotesMessage, makeNote, normalizeNotes, noteLabel } from '../domain.js'
import { noteScript } from '../preview/previewDomain.js'
import { NOTES_MAX, NOTE_MAX_CHARS } from '../constants.js'

const pick = (over = {}) => ({
  selector: 'body:nth-of-type(1) > h1:nth-of-type(1)',
  tag: 'H1',
  text: 'Welcome to my site',
  html: '<h1 class="hero">Welcome to my site</h1>',
  page: 'build/site/index.html',
  ...over,
})

test('makeNote keeps the selector and builds a readable label', () => {
  const note = makeNote(pick(), 'make this bigger', 'n1')
  assert.equal(note.id, 'n1')
  assert.equal(note.selector, 'body:nth-of-type(1) > h1:nth-of-type(1)')
  assert.equal(note.label, '<h1> "Welcome to my site"')
  assert.equal(note.note, 'make this bigger')
})

test('makeNote refuses a pick with no selector or no text', () => {
  // The pick arrives by postMessage from the sandboxed preview — untrusted
  // even though we injected the script that sends it.
  assert.equal(makeNote(pick({ selector: '' }), 'do a thing', 'n1'), null)
  assert.equal(makeNote(pick(), '   ', 'n1'), null)
  assert.equal(makeNote(null, 'do a thing', 'n1'), null)
})

test('makeNote collapses newlines so one note stays one list item', () => {
  const note = makeNote(pick(), 'make this\n\nbigger   and   bold', 'n1')
  assert.equal(note.note, 'make this bigger and bold')
})

test('makeNote caps note length', () => {
  const note = makeNote(pick(), 'x'.repeat(NOTE_MAX_CHARS + 50), 'n1')
  assert.equal(note.note.length, NOTE_MAX_CHARS)
})

test('noteLabel degrades gracefully with no text or no tag', () => {
  assert.equal(noteLabel('div', ''), '<div>')
  assert.equal(noteLabel('', 'just text'), 'just text')
})

test('normalizeNotes drops malformed entries, dedupes ids, and caps', () => {
  const raw = [
    { id: 'a', selector: 'h1', note: 'one' },
    { id: 'a', selector: 'h2', note: 'duplicate id' },
    { id: 'b', selector: '', note: 'no selector' },
    { id: 'c', selector: 'h3', note: '   ' },
    null,
    'nonsense',
  ]
  const out = normalizeNotes(raw)
  assert.deepEqual(out.map((n) => n.id), ['a'])
  assert.equal(normalizeNotes(null).length, 0)
  const many = Array.from({ length: NOTES_MAX + 10 }, (_, i) => (
    { id: `id${i}`, selector: 'h1', note: 'x' }
  ))
  assert.equal(normalizeNotes(many).length, NOTES_MAX)
})

test('composeNotesMessage numbers each note and leads with the element markup', () => {
  const notes = [
    makeNote(pick(), 'make this bigger', 'n1'),
    makeNote(pick({
      tag: 'P', text: 'About us', html: '<p>About us</p>', selector: 'p:nth-of-type(2)',
    }), 'shorter', 'n2'),
  ]
  const msg = composeNotesMessage(notes, 'files/index.html')
  assert.match(msg, /I left 2 notes on files\/index\.html/)
  assert.match(msg, /1\. <h1> "Welcome to my site" — make this bigger/)
  // The markup is the locator; the brittle built-page selector is NOT shown.
  assert.match(msg, /element: <h1 class="hero">Welcome to my site<\/h1>/)
  assert.doesNotMatch(msg, /selector: body:nth-of-type/)
  assert.match(msg, /2\. <p> "About us" — shorter/)
  assert.match(msg, /Find each element yourself in the source file/)
})

test('composeNotesMessage falls back to the selector only when markup is missing', () => {
  const note = makeNote(pick({ html: '' }), 'tweak', 'n1')
  const msg = composeNotesMessage([note], 'files/index.html')
  assert.match(msg, /selector hint: body:nth-of-type\(1\) > h1:nth-of-type\(1\)/)
  assert.doesNotMatch(msg, /element: /)
})

test('composeNotesMessage uses the singular for one note and is empty for none', () => {
  const one = composeNotesMessage([makeNote(pick(), 'tweak', 'n1')], 'files/index.html')
  assert.match(one, /I left a note on files\/index\.html/)
  assert.equal(composeNotesMessage([], 'files/index.html'), '')
  assert.equal(composeNotesMessage(null, 'files/index.html'), '')
})

test('noteScript binds both message types so the two halves cannot drift', () => {
  const script = noteScript('mode-type', 'pick-type')
  assert.match(script, /var MODE = 'mode-type'/)
  assert.match(script, /var PICK = 'pick-type'/)
  // The pin overlay must survive the site's own CSS.
  assert.match(script, /all:initial/)
})

test('makeNote maps the built page back to its source file', () => {
  const note = makeNote(pick({ page: 'build/site/about.html' }), 'tweak', 'n1')
  assert.equal(note.page, 'files/about.html')
  // A page outside the build mirror is not a source file we can name.
  assert.equal(makeNote(pick({ page: 'elsewhere/x.html' }), 'tweak', 'n2').page, '')
})

test('composeNotesMessage only names a page when every note is on it', () => {
  const a = makeNote(pick({ page: 'build/site/about.html' }), 'bigger', 'n1')
  const b = makeNote(pick({ page: 'build/site/index.html' }), 'shorter', 'n2')
  // Mixed pages: no single page claimed, each item names its own file.
  const mixed = composeNotesMessage([a, b], 'files/index.html')
  assert.doesNotMatch(mixed, /I left 2 notes on /)
  assert.match(mixed, /in: files\/about\.html/)
  assert.match(mixed, /in: files\/index\.html/)
  // All on one page: named once in the header, not repeated per item.
  const same = composeNotesMessage([a], 'files/index.html')
  assert.match(same, /I left a note on files\/about\.html/)
  assert.doesNotMatch(same, /\n {3}in: /)
})

// --- annotation visibility ------------------------------------------------
// The first cut gated the note button on viewMode === 'preview', which is
// false on every desktop layout (the split shows the preview while viewMode
// stays 'source'). These lock the mirror to renderMain's actual branches.
import { annotatablePreview } from '../domain.js'

const surface = (over = {}) => ({
  selectedPath: 'files/index.html',
  selectedExt: 'html',
  isWide: true,
  mainPath: 'files/index.html',
  viewMode: 'source',
  hasBuiltEntry: true,
  ...over,
})

test('wide split allows annotation even while viewMode is source', () => {
  assert.equal(annotatablePreview(surface()), true)
})

test('wide split allows annotation while editing a NON-main text file', () => {
  // The split renders the main page's preview beside whatever file is open.
  assert.equal(annotatablePreview(surface({
    selectedPath: 'files/style.css', selectedExt: 'css',
  })), true)
})

test('narrow layout needs the main page open AND preview selected', () => {
  assert.equal(annotatablePreview(surface({ isWide: false })), false)
  assert.equal(annotatablePreview(surface({ isWide: false, viewMode: 'preview' })), true)
  assert.equal(annotatablePreview(surface({
    isWide: false, viewMode: 'preview',
    selectedPath: 'files/other.html', selectedExt: 'html',
  })), false)
})

test('no annotation without a built page to pin onto', () => {
  assert.equal(annotatablePreview(surface({ hasBuiltEntry: false })), false)
})

test('no annotation over an image or with nothing open', () => {
  assert.equal(annotatablePreview(surface({
    selectedPath: 'files/logo.png', selectedExt: 'png',
  })), false)
  assert.equal(annotatablePreview(surface({ selectedPath: null })), false)
})

test('no annotation when the project has no main page', () => {
  assert.equal(annotatablePreview(surface({ mainPath: null })), false)
})

test('makeNote keeps the element markup, collapsed and bounded', () => {
  const note = makeNote(pick({ html: '<h1>\n  Welcome\n</h1>' }), 'bigger', 'n1')
  assert.equal(note.html, '<h1> Welcome </h1>')
  const long = makeNote(pick({ html: '<p>' + 'x'.repeat(500) + '</p>' }), 'bigger', 'n2')
  assert.equal(long.html.length, 300)
})
