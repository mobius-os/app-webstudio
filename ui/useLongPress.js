import { useCallback, useEffect, useRef } from 'react'
import { LONG_PRESS_MS, LONG_PRESS_SLOP } from '../constants.js'

export function useLongPress(onLongPress) {
  const timerRef = useRef(null)
  const startRef = useRef(null)
  const suppressClickRef = useRef(false)
  const clear = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    startRef.current = null
  }, [])
  useEffect(() => clear, [clear])
  const onPointerDown = useCallback((e) => {
    if (e.pointerType === 'mouse' || e.button !== 0) return
    startRef.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      target: e.currentTarget,
    }
    try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch {}
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      const start = startRef.current
      if (!start) return
      suppressClickRef.current = true
      onLongPress(start.x, start.y)
    }, LONG_PRESS_MS)
  }, [onLongPress])
  const onPointerMove = useCallback((e) => {
    const start = startRef.current
    if (!start || e.pointerId !== start.id) return
    if (Math.abs(e.clientX - start.x) > LONG_PRESS_SLOP
      || Math.abs(e.clientY - start.y) > LONG_PRESS_SLOP) {
      clear()
    }
  }, [clear])
  const finishPointer = useCallback((e) => {
    const start = startRef.current
    if (start && e.pointerId === start.id) {
      try { start.target?.releasePointerCapture?.(start.id) } catch {}
    }
    clear()
  }, [clear])
  const onClickCapture = useCallback((e) => {
    if (!suppressClickRef.current) return
    suppressClickRef.current = false
    e.preventDefault()
    e.stopPropagation()
  }, [])
  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: finishPointer,
    onPointerCancel: finishPointer,
    onLostPointerCapture: clear,
    onClickCapture,
  }
}
