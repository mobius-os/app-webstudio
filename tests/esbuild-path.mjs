import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The Möbius frontend deps (esbuild, react) are not published to npm — they ship
// in mobius-os/mobius. CI checks that repo out and points
// MOBIUS_FRONTEND_NODE_MODULES at its installed frontend/node_modules. Discover
// the shared tree portably from that env var, or from a `.mobius` checkout beside
// the repo root (the CI layout), so a fresh clone on any host resolves the deps
// without a host-specific path.
function sharedNodeModules(importMetaUrl) {
  const env = process.env.MOBIUS_FRONTEND_NODE_MODULES
  if (env && existsSync(env)) return env
  const sibling = fileURLToPath(new URL('../.mobius/frontend/node_modules', importMetaUrl))
  if (existsSync(sibling)) return sibling
  return null
}

export function resolveEsbuild(importMetaUrl) {
  const local = fileURLToPath(new URL('../node_modules/.bin/esbuild', importMetaUrl))
  if (existsSync(local)) return local
  const shared = sharedNodeModules(importMetaUrl)
  if (shared && existsSync(`${shared}/.bin/esbuild`)) return `${shared}/.bin/esbuild`
  return local
}

export function sharedReactAliases(importMetaUrl) {
  const localReact = fileURLToPath(new URL('../node_modules/react/package.json', importMetaUrl))
  if (existsSync(localReact)) return []

  const shared = sharedNodeModules(importMetaUrl)
  if (!shared) return []
  const sharedReact = `${shared}/react`
  if (!existsSync(`${sharedReact}/package.json`)) return []

  return [
    `--alias:react/jsx-runtime=${sharedReact}/jsx-runtime.js`,
    `--alias:react/jsx-dev-runtime=${sharedReact}/jsx-dev-runtime.js`,
    `--alias:react=${sharedReact}`,
  ]
}
