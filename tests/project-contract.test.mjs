import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const manifest = JSON.parse(read('mobius.json'))
const source = read('index.jsx')
const builder = read('project-builder.sh')
const miniBuilder = read('mini-app-builder.mjs')
const documentBuilder = read('document-builder.py')
const spreadsheetBuilder = read('spreadsheet-builder.py')
const guidance = read('webstudio-project.md')

test('Web Studio declares durable source contracts for every project format', () => {
  assert.equal(manifest.version, '1.3.3')
  assert.equal(manifest.embeds_agent, false)
  assert.deepEqual(manifest.offline, { reads: true, writes: 'none', execution: 'none' })
  assert.deepEqual(manifest.project_templates.map((template) => template.id), [
    'website', 'mini-app', 'visualization', 'document', 'spreadsheet', 'presentation',
  ])

  const byId = Object.fromEntries(manifest.project_templates.map(template => [template.id, template]))
  assert.deepEqual(Object.keys(byId.website.files), ['index.html', 'style.css', 'app.js'])
  assert.deepEqual(Object.keys(byId['mini-app'].files), ['index.jsx', 'mobius.json'])
  assert.deepEqual(Object.keys(byId.visualization.files), ['index.html', 'visualization.css', 'data.js', 'visualization.js'])
  assert.deepEqual(byId.document.files, {
    'document.md': 'templates/document.md',
    'assets/cover.png': 'templates/artwork/document.png',
  })
  assert.deepEqual(byId.spreadsheet.files, {
    'sheet.csv': 'templates/sheet.csv',
    'assets/cover.png': 'templates/artwork/spreadsheet.png',
  })
  assert.deepEqual(byId.presentation.files, {
    'index.html': 'templates/presentation/index.html',
    'assets/cover.png': 'templates/artwork/presentation.png',
  })
  assert.equal(byId['mini-app'].artifact_types[0].script, 'mini-app-builder.sh')
  assert.equal(byId.document.artifact_types[0].script, 'document-builder.sh')
  assert.equal(byId.spreadsheet.artifact_types[0].script, 'spreadsheet-builder.sh')
  for (const template of manifest.project_templates) {
    assert.equal(template.previews[0].kind, 'html')
    assert.ok(manifest.source_files.includes(template.artifact_types[0].script))
    for (const sourcePath of Object.values(template.files)) {
      assert.ok(manifest.source_files.includes(sourcePath), `${sourcePath} must ship with the app`)
    }
  }
  assert.doesNotMatch(read('templates/presentation/index.html'), /https?:\/\//)
  const presentationScript = read('templates/presentation/index.html').match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(presentationScript)
  assert.doesNotThrow(() => new Function(presentationScript))
})

test('the launcher creates websites and labels every supported project type', () => {
  assert.match(source, /const TYPES = \{/)
  for (const id of ['website', 'mini-app', 'visualization', 'document', 'spreadsheet', 'presentation']) {
    assert.match(source, new RegExp(`id: '${id}'`))
  }
  assert.match(source, /const WEBSITE = TYPES\.website/)
  assert.match(source, /createWebsite/)
  assert.match(source, /templateId: `webstudio:\$\{WEBSITE\.id\}`/)
  assert.match(source, /window\.mobius\?\.projects/)
  for (const operation of ['migrate', 'list', 'create', 'open', 'browse']) {
    assert.match(source, new RegExp(`projectApi\\??\\.${operation}`))
  }
  assert.doesNotMatch(source, /mobius\?\.storage|mobius\.chat|localStorage|<select/)
  assert.doesNotMatch(source, /const project = await projectApi\.create/)
  assert.match(source, /--project-row-accent/)
  assert.match(source, /min-height:\s*44px/)
  assert.match(source, /:focus-visible/)
})

test('builders stay confined and never publish repository internals', () => {
  for (const name of ['PROJECT_ROOT', 'PROJECT_SOURCE', 'PROJECT_OUTPUT_DIR']) {
    assert.match(builder, new RegExp(`\\$\\{${name}:\\?`))
  }
  assert.match(builder, /! -name artifacts/)
  assert.match(builder, /! -name \.git/)
  assert.match(builder, /! -name node_modules/)
  assert.match(miniBuilder, /relative\.startsWith\('\.\.'\)/)
  assert.match(miniBuilder, /bundle:\s*true/)
  assert.match(miniBuilder, /MOBIUS_FRONTEND_NODE_MODULES/)
  assert.match(miniBuilder, /platform', 'frontend', 'node_modules/)
  assert.match(miniBuilder, /nodePaths:\s*\[\.\.\.sharedNodeModulePaths\(\)/)
  assert.match(documentBuilder, /html\.escape/)
  assert.match(spreadsheetBuilder, /csv\.reader/)
  assert.match(guidance, /Edit source files directly under `\$PROJECT_ROOT`/)
  assert.match(guidance, /Do not load CDNs, remote fonts, scripts, or images/)
  assert.match(guidance, /When there is no `\$PROJECT_ROOT`/)
  assert.match(guidance, /Projects → New → Import existing/)
  assert.match(guidance, /building-apps-quickstart/)
})
