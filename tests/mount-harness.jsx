// Entry for the headless mount test. Renders the real app with a minimal
// runtime stub and records anything that goes wrong, so the test can assert
// the app actually PAINTS — not merely that its modules link.
import { createRoot } from 'react-dom/client'
import App from '../index.jsx'

const errors = []
window.__probeErrors = errors
window.addEventListener('error', (e) => {
  errors.push('ERROR: ' + ((e.error && e.error.stack) || e.message))
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  errors.push('REJECTION: ' + ((r && r.stack) || String(r)))
})

// The app frame has an OPAQUE origin where the browser denies IndexedDB. The
// storage runtime expects that and falls back, so the test reproduces it —
// a mount that only works with durable storage available is not a mount that
// works in production.
try {
  Object.defineProperty(window, 'indexedDB', {
    get() {
      const deny = () => {
        const e = new Error(
          "Failed to execute 'open' on 'IDBFactory': access to the Indexed "
          + 'Database API is denied in this context.',
        )
        e.name = 'SecurityError'
        throw e
      }
      return { open: deny, deleteDatabase: deny }
    },
  })
} catch { /* already non-configurable — the deny path is what we wanted anyway */ }

window.mobius = {
  signal: () => {},
  chat: () => Promise.resolve({ destroy() {}, setGuidance() {} }),
}
// Everything absent: the state a brand-new project is in.
window.fetch = () => Promise.resolve({
  ok: false,
  status: 404,
  json: () => Promise.resolve({}),
  text: () => Promise.resolve(''),
  blob: () => Promise.resolve(new Blob([])),
})

try {
  createRoot(document.getElementById('root')).render(<App appId={1} token="probe" />)
} catch (e) {
  errors.push('MOUNT THREW: ' + (e && e.stack))
}

setTimeout(() => {
  const root = document.getElementById('root')
  const out = document.createElement('pre')
  out.id = 'probe'
  out.textContent = JSON.stringify({
    rendered: root ? root.innerHTML.length : -1,
    errors: errors.slice(0, 5),
  })
  document.body.appendChild(out)
}, 1200)
