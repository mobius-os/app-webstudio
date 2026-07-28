import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appSource = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')
const chatSource = readFileSync(new URL('../ui/ChatPanel.jsx', import.meta.url), 'utf8')

test('embedded chat offers contextual guidance instead of prewritten prompts', () => {
  assert.match(appSource, /const guidance = useMemo/)
  assert.match(appSource, /guidance=\{guidance\}/)
  assert.match(chatSource, /guidance: guidanceRef\.current/)
  assert.doesNotMatch(appSource, /\bquickActions\b/)
  assert.doesNotMatch(chatSource, /\bquickActions\b/)
})
