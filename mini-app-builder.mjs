import { cp, mkdir, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'

const root = path.resolve(process.env.PROJECT_ROOT || '')
const source = path.resolve(root, process.env.PROJECT_SOURCE || '')
const output = path.resolve(process.env.PROJECT_OUTPUT_DIR || '')
const relative = path.relative(root, source)
if (!root || !output || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
  throw new Error('Mini-app source must stay inside the project root.')
}

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (['.git', 'artifacts', 'node_modules'].includes(entry.name)) continue
  await cp(path.join(root, entry.name), path.join(output, entry.name), { recursive: true })
}

const entry = path.join(output, '.preview-entry.jsx')
await writeFile(entry, [
  "import React from 'react'",
  "import { createRoot } from 'react-dom/client'",
  `import App from ${JSON.stringify(source)}`,
  "createRoot(document.getElementById('root')).render(React.createElement(App, { appId: 'project-preview' }))",
].join('\n'))

await build({
  absWorkingDir: root,
  entryPoints: [entry],
  outfile: path.join(output, 'app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  nodePaths: [path.join(import.meta.dirname, 'node_modules')],
  logLevel: 'warning',
})
await unlink(entry)
await writeFile(path.join(output, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mini-app preview</title></head><body><div id="root"></div><script src="app.js"></script></body></html>`)
