'use strict'
// The manifest's settings rules (the app's validate.ts refuses the plugin otherwise) and source
// checks the design asks for: no npm dependency, no exec, the one write (a space's read time), the
// token's hosts, no link to Chat, example data only.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'))
const walkFiles = (dirs, ext) => {
  const out = []
  const walk = (d) => {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name)
      if (n.isDirectory()) walk(p)
      else if (ext.some((e) => n.name.endsWith(e))) out.push(p)
    }
  }
  for (const d of dirs) walk(path.join(ROOT, d))
  return out
}
const sources = () => walkFiles(['dist', 'panels'], ['.js'])
const noComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('the manifest: id, api, entry points and files exist, the services it uses', () => {
  assert.equal(manifest.id, 'bronos.chat')
  assert.equal(manifest.version, '0.2.0')
  assert.equal(manifest.api, 1)
  assert.equal(manifest.license, 'MIT')
  assert.ok(fs.existsSync(path.join(ROOT, manifest.main)))
  for (const p of manifest.contributes.panels) {
    assert.ok(fs.existsSync(path.join(ROOT, p.entry)))
    assert.ok(fs.existsSync(path.join(ROOT, p.icon)))
  }
  assert.deepEqual(manifest.services.uses, { triage: 1, reviewer: 1 })
  assert.deepEqual(manifest.services.provides, { 'inbox-feed': 1 })
  assert.equal(manifest.contributes.cli[0].name, 'chat')
  assert.equal(manifest.contributes.cli[0].stdin, undefined, 'no subcommand reads stdin')
  for (const sub of ['status', 'refresh', 'list', 'show', 'read', 'unread', 'login', 'logout', 'client', 'help']) assert.match(manifest.contributes.cli[0].usage, new RegExp(`\\b${sub}\\b`))
})

test('the settings schema: no regex anywhere; the secret field top-level, no default, only allowed keywords', () => {
  const schema = manifest.contributes.settings.project
  const walk = (node, at) => {
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      assert.ok(!['pattern', 'patternProperties', '$ref', '$anchor', '$id', '$dynamicRef', '$defs', 'definitions'].includes(k), `${at}.${k}`)
      if (k === 'format') assert.equal(at, 'project.properties.clientSecret', `format only on the secret (${at})`)
      walk(v, `${at}.${k}`)
    }
  }
  walk(schema, 'project')
  const secret = schema.properties.clientSecret
  assert.equal(secret.type, 'string')
  assert.equal(secret.format, 'secret')
  assert.ok(!('default' in secret))
  assert.deepEqual(Object.keys(secret).filter((k) => !['type', 'format', 'title', 'description', '$comment'].includes(k)), [])
})

test('the schema and settings.js agree: every property is read, every default the same', () => {
  const { readSettings, LANE_IDS } = require('../dist/lib/settings')
  const props = manifest.contributes.settings.project.properties
  const { cfg } = readSettings({})
  assert.deepEqual(Object.keys(props.lanes.properties), LANE_IDS)
  assert.deepEqual(props.lanes.default, cfg.lanes)
  for (const k of ['rowsPerLane', 'days', 'messagesPerSpace', 'recentDays', 'maxRecent', 'recentPerSpace', 'pollMinutes', 'markReadOnOpen', 'triageText']) {
    assert.ok(k in props, k)
    assert.deepEqual(props[k].default, cfg[k], k)
    if (props[k].type === 'integer') {
      assert.equal(readSettings({ [k]: props[k].maximum + 1 }).cfg[k], props[k].maximum, `${k} max`)
      assert.equal(readSettings({ [k]: props[k].minimum - 1 }).cfg[k], props[k].minimum, `${k} min`)
    }
  }
  assert.equal(props.markReadOnOpen.type, 'boolean')
  assert.equal(props.markReadOnOpen.default, true)
  assert.equal(props.alertBots.items.maxLength, 100)
})

test('no npm dependency: every require is node: or relative', () => {
  for (const f of sources()) {
    const src = fs.readFileSync(f, 'utf8')
    for (const [, mod] of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) assert.ok(mod.startsWith('node:') || mod.startsWith('./') || mod.startsWith('../'), `${path.relative(ROOT, f)} requires ${mod}`)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.scripts, { test: 'node --test test/' })
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
})

test('the one write: PATCH only in client.js, on the space read state; POST only for the search and the token info; no exec', () => {
  for (const f of sources()) {
    const src = noComments(fs.readFileSync(f, 'utf8'))
    const rel = path.relative(ROOT, f)
    assert.ok(!/ctx\.exec\b|child_process/.test(src), `${rel}: exec`)
    assert.ok(!/method:\s*['"](PUT|DELETE)/i.test(src), `${rel}: PUT or DELETE`)
    const patches = [...src.matchAll(/method:\s*['"]PATCH['"]/g)].length
    // http.js holds the route table (checked below through ROUTES); client.js makes the calls.
    if (rel === path.join('dist', 'lib', 'http.js')) continue
    if (rel !== path.join('dist', 'lib', 'client.js')) {
      assert.equal(patches, 0, `${rel}: a PATCH`)
      assert.ok(!/method:\s*['"]POST['"]/.test(src), `${rel}: a POST`)
    } else {
      assert.equal(patches, 1)
      assert.match(src, /\/spaceReadState`, \{ method: 'PATCH', params: \{ updateMask: 'lastReadTime' \}/)
      assert.equal([...src.matchAll(/method:\s*['"]POST['"]/g)].length, 3, 'searchMentions, ownUserId, tokenInfo')
    }
    assert.ok(!/\/messages['"`],\s*\{[^}]*method:\s*['"]POST/.test(src), `${rel}: creating a message`)
    assert.ok(!/\/(reactions|members)\b|:(create|delete|patch|update)\b|messages:(send|reply)/.test(src), `${rel}: reactions, members or a message write`)
  }
  const { ROUTES } = require('../dist/lib/http')
  assert.deepEqual(ROUTES.filter((r) => r.method === 'PATCH').map((r) => String(r.path)), [String(/^\/v1\/users\/me\/spaces\/[A-Za-z0-9_-]{1,128}\/spaceReadState$/)])
  assert.deepEqual(ROUTES.filter((r) => r.method === 'POST').map((r) => `${r.origin}${r.path}`), ['https://chat.googleapis.com/^\\/v1\\/spaces\\/-\\/messages:search$/', 'https://oauth2.googleapis.com/^\\/tokeninfo$/'])
  assert.ok(ROUTES.every((r) => ['GET', 'POST', 'PATCH'].includes(r.method)))
})

test('the only network hosts in the code are Google\'s (and the README link); none is Chat\'s web app', () => {
  const allowed = new Set(['chat.googleapis.com', 'people.googleapis.com', 'oauth2.googleapis.com', 'accounts.google.com', 'www.googleapis.com', 'console.cloud.google.com', 'myaccount.google.com', 'github.com', 'developers.google.com', 'drive.google.com'])
  for (const f of [...sources(), ...walkFiles(['panels'], ['.html'])]) {
    const src = noComments(fs.readFileSync(f, 'utf8'))
    for (const [, host] of src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) assert.ok(allowed.has(host.toLowerCase()), `${path.relative(ROOT, f)}: ${host}`)
  }
})

test('example data only: test data and docs use acme, example.com and the Example people', () => {
  for (const f of walkFiles(['test', 'docs'], ['.js', '.json', '.md']).concat([path.join(ROOT, 'README.md')].filter((p) => fs.existsSync(p)))) {
    const src = fs.readFileSync(f, 'utf8')
    for (const [, domain] of src.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[a-z]{2,})/g)) {
      assert.ok(/(^|\.)example\.(com|org)$|\.example$|^x\.org$/.test(domain) || ['gmail.com', 'googlemail.com'].includes(domain), `${path.relative(ROOT, f)}: an address at ${domain}`)
    }
  }
})
