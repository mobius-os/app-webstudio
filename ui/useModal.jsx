import { useCallback, useEffect, useRef, useState } from 'react'
import { ModalView } from './ModalView.jsx'

export function useModal() {
  const [state, setState] = useState(null)
  const navRef = useRef(null)
  const resolveRef = useRef(null)

  const finish = useCallback((value, fromShell = false) => {
    if (!fromShell) {
      try { navRef.current?.close?.() } catch {}
    }
    navRef.current = null
    setState(null)
    const resolve = resolveRef.current
    resolveRef.current = null
    if (resolve) resolve(value)
  }, [])

  const openModal = useCallback((factory, backValue) => new Promise((resolve) => {
    if (resolveRef.current) finish(backValue)
    resolveRef.current = resolve
    const show = () => setState(factory((value) => finish(value)))
    if (window.mobius?.nav?.open) {
      const handle = window.mobius.nav.open('webstudio-modal', () => finish(backValue, true))
      navRef.current = handle
      Promise.resolve(handle.ready).finally(() => {
        if (navRef.current === handle) show()
      })
    } else {
      show()
    }
  }), [finish])

  const alert = useCallback((body, opts = {}) => openModal((resolve) => ({
    kind: 'alert',
    title: opts.title || 'Heads up',
    body,
    resolve: () => resolve(undefined),
  }), undefined), [openModal])

  const confirm = useCallback((body, opts = {}) => openModal((resolve) => ({
    kind: 'confirm',
    title: opts.title || 'Confirm',
    body,
    danger: !!opts.danger,
    resolve: (ok) => resolve(!!ok),
  }), false), [openModal])

  const prompt = useCallback((body, opts = {}) => openModal((resolve) => ({
    kind: 'prompt',
    title: opts.title || 'Enter a value',
    body,
    placeholder: opts.placeholder || '',
    defaultValue: opts.defaultValue || '',
    resolve,
  }), null), [openModal])

  const choose = useCallback((body, opts = {}) => openModal((resolve) => ({
    kind: 'choose',
    title: opts.title || 'Choose',
    body,
    actions: Array.isArray(opts.actions) ? opts.actions : [],
    resolve,
  }), null), [openModal])

  useEffect(() => () => {
    try { navRef.current?.close?.() } catch {}
    navRef.current = null
    resolveRef.current = null
  }, [])

  const node = state ? (
    <ModalView state={state} />
  ) : null

  return { node, alert, confirm, prompt, choose }
}
