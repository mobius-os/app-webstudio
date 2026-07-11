import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SHARED_ESBUILD = '/home/hmzmrzx/projects/mobius/frontend/node_modules/.bin/esbuild'
const SHARED_NODE_MODULES = '/home/hmzmrzx/projects/mobius/frontend/node_modules'

export function resolveEsbuild(importMetaUrl) {
  const local = fileURLToPath(new URL('../node_modules/.bin/esbuild', importMetaUrl))
  if (existsSync(local)) return local
  if (existsSync(SHARED_ESBUILD)) return SHARED_ESBUILD
  return local
}

export function sharedReactAliases(importMetaUrl) {
  const localReact = fileURLToPath(new URL('../node_modules/react/package.json', importMetaUrl))
  if (existsSync(localReact)) return []

  const sharedReact = `${SHARED_NODE_MODULES}/react`
  if (!existsSync(`${sharedReact}/package.json`)) return []

  return [
    `--alias:react/jsx-runtime=${sharedReact}/jsx-runtime.js`,
    `--alias:react/jsx-dev-runtime=${sharedReact}/jsx-dev-runtime.js`,
    `--alias:react=${sharedReact}`,
  ]
}
