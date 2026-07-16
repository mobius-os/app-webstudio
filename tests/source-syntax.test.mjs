import test from 'node:test'
import assert from 'node:assert/strict'

import { sourceKind, sourceTokens } from '../source-syntax.js'

test('highlights common web source without treating CSS colours as comments', () => {
  assert.equal(sourceKind('files/styles.css'), 'css')
  const tokens = sourceTokens('files/styles.css', '.card { color: #fff; width: 20px; }')
  assert.deepEqual(tokens.map((token) => token.className), ['cm-syn-number'])
})

test('highlights HTML tags, strings, and comments', () => {
  const tokens = sourceTokens('files/index.html', '<!-- note --><main class="hero">Hi</main>')
  assert.deepEqual(tokens.map((token) => token.className), [
    'cm-syn-comment', 'cm-syn-tag', 'cm-syn-keyword', 'cm-syn-string', 'cm-syn-tag',
  ])
})
