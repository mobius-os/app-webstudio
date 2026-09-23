const effects = globalThis.__webstudioRenderEffects ||= []

export const useState = (initial) => [
  typeof initial === 'function' ? initial() : initial,
  () => {},
]
export const useCallback = (fn) => fn
export const useMemo = (factory) => factory()
export const useEffect = (effect) => { effects.push(effect) }

export default { useState, useCallback, useMemo, useEffect }
