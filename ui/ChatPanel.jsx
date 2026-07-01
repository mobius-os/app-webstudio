import { useEffect, useMemo, useRef, useState } from 'react'

function bootstrapPrompt() {
  return [
    'You help the user build their website in this app.',
    'Use the embedded-app-agent skill, which carries the full methodology;',
    'rely on the injected app_context for this app’s id, file paths, and',
    'build commands.',
    '',
    'This is a silent setup brief — do NOT reply to it. Wait for the user’s',
    'first message and act on that.',
  ].join('\n')
}

export function ChatPanel({
  appId, token, storage,
  projectId, persistKey,
  onFilesMaybeChanged,
  quickActions, getContext,
}) {
  const mountRef = useRef(null)
  const [error, setError] = useState(null)
  // Keep the latest onFilesMaybeChanged in a ref so the mount effect below does
  // NOT depend on it. That callback's identity changes on every file selection;
  // if it were a mount-effect dep, selecting a file would tear down + remount
  // the chat iframe — destroying a streaming turn mid-flight.
  const onFilesRef = useRef(onFilesMaybeChanged)
  useEffect(() => { onFilesRef.current = onFilesMaybeChanged }, [onFilesMaybeChanged])
  const quickActionsRef = useRef(quickActions)
  useEffect(() => { quickActionsRef.current = quickActions }, [quickActions])
  const getContextRef = useRef(getContext)
  useEffect(() => { getContextRef.current = getContext }, [getContext])
  const systemPrompt = useMemo(() => bootstrapPrompt(), [])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !window.mobius || typeof window.mobius.chat !== 'function') {
      setError('Embedded chat is not available in this shell.')
      return undefined
    }
    let disposed = false
    let handle = null
    setError(null)

    window.mobius.chat({
      mount,
      projectId: projectId === 'default' ? undefined : projectId,
      persist: persistKey,
      title: 'Web Studio',
      systemPrompt,
      picker: true,
      quickActions: quickActionsRef.current,
      getContext: () => {
        const fn = getContextRef.current
        return fn ? fn() : null
      },
      onTurnDone: () => { if (onFilesRef.current) onFilesRef.current() },
      onError: ({ error }) => { setError(typeof error === 'string' ? error : 'Embedded chat reported an error.') },
    }).then((nextHandle) => {
      if (disposed) {
        nextHandle.destroy()
        return
      }
      handle = nextHandle
    }).catch((e) => {
      if (!disposed) setError(e.message || 'Could not mount embedded chat.')
    })

    return () => {
      disposed = true
      if (handle) handle.destroy()
    }
  }, [storage, systemPrompt, projectId, persistKey])

  return (
    <section className="ws-chat-panel" aria-label="Agent chat">
      {error && <div className="ws-chat-error">{error}</div>}
      <div className="ws-chat-embed" ref={mountRef} />
    </section>
  )
}

// ----------------------------------------------------------------------
// Online/offline detection. The runtime's `window.mobius.online` is a
// getter over `navigator.onLine` — same source, no separate change event —
// so we track `navigator.onLine` directly and react to the browser's own
// 'online'/'offline' events.
