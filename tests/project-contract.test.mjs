import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const path = (name) => new URL(`../${name}`, import.meta.url)
const read = (name) => readFileSync(path(name), 'utf8')
const manifest = JSON.parse(read('mobius.json'))
const source = read('index.jsx')
const builder = read('project-builder.sh')
const guidance = read('webstudio-project.md')

test('Web Studio ships exactly one website template and builder, not hidden specialist formats', () => {
  assert.equal(manifest.embeds_agent, false)
  assert.deepEqual(manifest.offline, { reads: true, writes: 'none', execution: 'none' })
  assert.deepEqual(manifest.project_templates.map(template => template.id), ['website'])
  const [website] = manifest.project_templates
  assert.deepEqual(Object.keys(website.files), ['index.html', 'style.css', 'app.js'])
  assert.deepEqual(website.previews[0], {
    id: 'website', name: 'Website', kind: 'html', path: 'index.html',
  })
  assert.equal(website.artifact_types[0].script, 'project-builder.sh')
  assert.deepEqual(manifest.source_files, [
    'webstudio-project.md', 'project-builder.sh',
    'templates/index.html', 'templates/style.css', 'templates/app.js',
  ])
  for (const name of manifest.source_files) assert.ok(existsSync(path(name)), name)
  for (const name of ['mini-app-builder.sh', 'mini-app-builder.mjs', 'document-builder.sh',
    'document-builder.py', 'spreadsheet-builder.sh', 'spreadsheet-builder.py',
    'templates/mini-app/index.jsx', 'templates/visualization/index.html',
    'templates/document.md', 'templates/sheet.csv', 'templates/presentation/index.html']) {
    assert.equal(existsSync(path(name)), false, `${name} must be removed, not retired`)
  }
})

test('the launcher creates and lists websites only without duplicating drawer navigation', () => {
  assert.match(source, /const LOCAL_TEMPLATE_ID = 'website'/)
  assert.match(source, /rows\.filter\(row => row\.template\?\.id === LOCAL_TEMPLATE_ID\)/)
  assert.match(source, /setProjects\(websites\)/)
  assert.match(source, /templates\.find\(row => row\.id === LOCAL_TEMPLATE_ID\)/)
  assert.match(source, /templateId: template\.key/)
  assert.match(source, /window\.mobius\?\.projects/)
  for (const operation of ['templates', 'migrate', 'list', 'create', 'open']) {
    assert.match(source, new RegExp(`projectApi\\??\\.${operation}`))
  }
  assert.doesNotMatch(source, /const TYPES|visualization|spreadsheet|presentation|mini-app/)
  assert.doesNotMatch(source, /mobius\?\.storage|mobius\.chat|localStorage|<select/)
  assert.match(source, /Your websites/)
  assert.doesNotMatch(source, /projectApi\.browse|wsx-footer|All Projects & project types/)
  assert.match(source, /--project-row-accent/)
  assert.match(source, /min-height:\s*44px/)
  assert.match(source, /:focus-visible/)
})

test('website build and guidance preserve the project source boundary', () => {
  for (const name of ['PROJECT_ROOT', 'PROJECT_SOURCE', 'PROJECT_OUTPUT_DIR']) {
    assert.match(builder, new RegExp(`\\$\\{${name}:\\?`))
  }
  assert.match(builder, /! -name artifacts/)
  assert.match(builder, /! -name \.git/)
  assert.match(builder, /! -name node_modules/)
  assert.match(guidance, /Edit source files directly under `\$PROJECT_ROOT`/)
  assert.match(guidance, /Do not load CDNs, remote fonts, scripts, or images/)
  assert.match(guidance, /When there is no `\$PROJECT_ROOT`/)
  assert.match(guidance, /adds Website projects only/)
  assert.doesNotMatch(guidance, /Build or edit a Website, Mini-app|CSV for|Markdown for/)
})
