import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const modal = readFileSync(new URL('../ui/ModalView.jsx', import.meta.url), 'utf8')

test('prompt modal gives its response field an accessible name', () => {
  assert.match(modal, /aria-label=\{state\.title\}/)
  assert.match(modal, /name="modal_response"/)
})
