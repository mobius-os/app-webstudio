import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const manifest = JSON.parse(read('mobius.json'))
const source = read('index.jsx')
const builder = read('project-builder.sh')
const guidance = read('webstudio-project.md')

test('Web Studio declares one first-class website project contract', () => {
  assert.equal(manifest.version, '1.0.0')
  assert.equal(manifest.embeds_agent, false)
  assert.deepEqual(manifest.source_files, [
    'webstudio-project.md',
    'project-builder.sh',
    'templates/index.html',
    'templates/style.css',
    'templates/app.js',
  ])
  assert.deepEqual(manifest.offline, {
    reads: true,
    writes: 'none',
    execution: 'none',
  })
  assert.equal(manifest.project_templates.length, 1)
  const template = manifest.project_templates[0]
  assert.equal(template.id, 'website')
  assert.deepEqual(template.files, {
    'index.html': 'templates/index.html',
    'style.css': 'templates/style.css',
    'app.js': 'templates/app.js',
  })
  assert.equal(template.previews[0].kind, 'html')
  assert.equal(template.artifact_types[0].script, 'project-builder.sh')
})

test('the launcher delegates workspace ownership to Projects', () => {
  assert.match(source, /const TEMPLATE_ID = 'webstudio:website'/)
  assert.match(source, /window\.mobius\?\.projects/)
  for (const operation of ['migrate', 'list', 'create', 'open', 'browse']) {
    assert.match(source, new RegExp(`projectApi\\??\\.${operation}`))
  }
  assert.doesNotMatch(source, /mobius\?\.storage|mobius\.chat|localStorage/)
  assert.match(source, /min-height:\s*44px/)
  assert.match(source, /:focus-visible/)
})

test('the website builder and agent guidance stay project-scoped', () => {
  for (const name of ['PROJECT_ROOT', 'PROJECT_SOURCE', 'PROJECT_OUTPUT_DIR']) {
    assert.match(builder, new RegExp(`\\$\\{${name}:\\?`))
  }
  assert.match(builder, /find "\$PROJECT_ROOT"/)
  assert.match(builder, /! -name artifacts/)
  assert.match(builder, /test -f "\$PROJECT_OUTPUT_DIR\/\$PROJECT_SOURCE"/)
  assert.match(guidance, /Edit source files directly under `\$PROJECT_ROOT`/)
  assert.match(guidance, /Do not load CDNs, remote fonts, scripts, or images/)
})
