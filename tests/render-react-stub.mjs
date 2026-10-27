const effects = globalThis.__webstudioRenderEffects ||= []

export const useState = (initial) => {
  const states = globalThis.__webstudioStates
  const value = typeof initial === 'function' ? initial() : initial
  if (!states) return [value, () => {}]
  const index = globalThis.__webstudioStateIndex++
  if (!(index in states)) states[index] = value
  return [states[index], (next) => { states[index] = next }]
}
export const useCallback = (fn) => fn
export const useMemo = (factory) => factory()
export const useRef = (initial) => ({ current: initial })
export const useEffect = (effect) => { effects.push(effect) }

export default { useState, useCallback, useMemo, useRef, useEffect }
