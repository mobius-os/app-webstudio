// Möbius compiles mini-apps with Rolldown, so the tests bundle the same way —
// one helper, so no test file re-encodes the compiler's options.
//
// Rolldown and the shell's frontend deps (react, @openai/apps-sdk-ui) are not
// published to npm — they ship in mobius-os/mobius. CI checks that repo out and
// points MOBIUS_FRONTEND_NODE_MODULES at its installed frontend/node_modules.
// Discover the shared tree portably from that env var, or from a `.mobius`
// checkout beside the repo root (the CI layout), so a fresh clone on any host
// resolves the compiler and its deps without a host-specific path.
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export function sharedNodeModules() {
  const env = process.env.MOBIUS_FRONTEND_NODE_MODULES
  if (env && existsSync(env)) return env
  const sibling = join(repoRoot, '.mobius', 'frontend', 'node_modules')
  if (existsSync(sibling)) return sibling
  return null
}

async function loadRolldown(frontend) {
  if (!frontend) return import('rolldown')
  const requireFromFrontend = createRequire(join(frontend, 'package.json'))
  return import(pathToFileURL(requireFromFrontend.resolve('rolldown')).href)
}

// CodeMirror only runs in a browser; the tests exercise pure module-level
// exports, so the editor libraries are stubbed rather than bundled.
export const runtimeLibStubs = {
  '@codemirror/state': join(repoRoot, 'tests', 'runtime-lib-stub.mjs'),
  '@codemirror/view': join(repoRoot, 'tests', 'runtime-lib-stub.mjs'),
  '@codemirror/commands': join(repoRoot, 'tests', 'runtime-lib-stub.mjs'),
}

async function compile({ entry, alias = {}, external }) {
  const frontend = sharedNodeModules()
  const { rolldown } = await loadRolldown(frontend)
  return rolldown({
    input: join(repoRoot, entry),
    platform: 'node',
    tsconfig: false,
    transform: { jsx: 'react-jsx' },
    resolve: {
      alias,
      modules: frontend ? [frontend, 'node_modules'] : ['node_modules'],
    },
    ...(external ? { external } : {}),
  })
}

// Bundles an app entry to `outfile` (each caller passes its own: node --test
// runs test files in parallel processes, so a shared path would race the
// bundles) and imports the result.
export async function bundleModule({ entry, outfile, alias = {} }) {
  const target = join(repoRoot, outfile)
  mkdirSync(dirname(target), { recursive: true })
  const build = await compile({ entry, alias })
  await build.write({ file: target, format: 'es' })
  await build.close()
  return import(pathToFileURL(target).href)
}

// Compile-check the whole module tree without emitting anything: packages stay
// external, so this proves the app's own files parse and link.
export async function compileSmoke(entry) {
  const build = await compile({ entry, external: (id) => !/^[./]/.test(id) })
  await build.generate({ format: 'es' })
  await build.close()
}
