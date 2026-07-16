import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const modal = readFileSync(new URL('../ui/ModalView.jsx', import.meta.url), 'utf8')
const nav = readFileSync(new URL('../ui/FileNavPanel.jsx', import.meta.url), 'utf8')

test('prompt modal gives its response field an accessible name', () => {
  assert.match(modal, /aria-label=\{state\.title\}/)
  assert.match(modal, /name="modal_response"/)
})

test('closed file navigation is removed from keyboard and accessibility navigation', () => {
  assert.match(nav, /aria-hidden=\{!shown\}/)
  assert.match(nav, /inert=\{!shown \? true : undefined\}/)
})

test('the file tree role is only exposed when it owns tree items', () => {
  assert.match(nav, /role=\{files\.length > 0 \? 'tree' : undefined\}/)
  assert.match(nav, /tabIndex=\{files\.length > 0 \? 0 : undefined\}/)
})
