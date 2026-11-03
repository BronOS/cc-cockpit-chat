'use strict'
// `ccc chat` on its own (lib/cli.js with plain deps): the usage errors, what is printed before a
// sign-in, the client file read from a path, the lanes listed, an off lane.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { runCli, statusText, listText, notReady, HELP } = require('../dist/lib/cli')
const { tmpDir, fixture, NOW } = require('./fakes')

const base = { client: null, signedIn: false, ready: false, settingsMissing: [], problems: [] }
const deps = (st, extra = {}) => ({ status: () => st, view: () => ({ lanes: [] }), refresh: async () => ({}), show: async () => 'text', mark: async () => ({ message: 'ok' }), login: async () => ({ message: 'go' }), logout: async () => ({}), client: async () => ({ ok: true, message: 'saved' }), ...extra })

test('help, unknown commands, usage errors exit 2', async () => {
  assert.equal((await runCli([], deps(base))).stdout, HELP)
  assert.equal((await runCli(['status', '--help'], deps(base))).stdout, HELP)
  const u = await runCli(['frobnicate'], deps(base))
  assert.equal(u.code, 2)
  assert.match(u.stderr, /unknown command "frobnicate"/)
  for (const cmd of ['show', 'read', 'unread']) assert.equal((await runCli([cmd], deps(base))).code, 2)
  assert.equal((await runCli(['read', '../etc'], deps(base))).code, 2)
  assert.equal((await runCli(['client'], deps(base))).code, 2)
  assert.match(HELP, /changes nothing in Google Chat but your read state/)
})

test('before a sign-in: the first thing missing', async () => {
  assert.match(notReady(base), /No OAuth client yet/)
  assert.match(notReady({ ...base, client: { id: 'x', source: 'pasted' } }), /Not signed in/)
  assert.match(notReady({ ...base, client: { id: 'x' }, signedIn: true, blocked: 'personal account' }), /personal account/)
  const r = await runCli(['read', 'spaces/AAA'], deps(base))
  assert.equal(r.code, 1)
  assert.match(r.stderr, /No OAuth client yet/)
  assert.match(statusText({ ...base, client: { id: '1234…', source: 'settings' }, signedOutReason: 'Google no longer accepts it' }, NOW), /Google no longer accepts it/)
})

test('status signed in: user id, scopes, marks, notes and space errors', () => {
  const st = { ...base, client: { id: '1234…', source: 'pasted' }, signedIn: true, ready: true, account: 'me@example.com', me: 'users/1001', meChecked: false, missing: ['directory'], lastPoll: NOW - 60000, pollMinutes: 2, backoffMinutes: 0, counts: [{ id: 'mentions', title: 'Mentions', total: 1 }], triage: 'on', annotate: 'reviewer', markReadOnOpen: false, notes: ['a note'], spaceErrors: [{ space: 'spaces/AAA', message: 'boom' }] }
  const t = statusText(st, NOW)
  assert.match(t, /user id +users\/1001 \(from the sign-in/)
  assert.match(t, /scopes +missing directory\.readonly/)
  assert.match(t, /marks +Mark read \/ unread only \(markReadOnOpen is off\)/)
  assert.match(t, /note +a note/)
  assert.match(t, /error +spaces\/AAA: boom/)
  assert.match(t, /lanes +Mentions 1/)
})

test('list: unread star, triage letter, the id to show; an off lane says so', () => {
  const view = { lanes: [{ id: 'direct', title: 'Direct messages', rows: [{ id: 'spaces/DM', unread: true, verdict: { priority: 'urgent' }, count: 3, title: 'Ann Example', sub: 'hi' }] }] }
  const t = listText(view)
  assert.match(t, /Direct messages \(1\)\n {2}\* U spaces\/DM\n {6}Ann Example \(3 new\) · hi/)
  assert.match(listText(view, 'alerts'), /Alerts: this lane is off \(the lanes setting, or no alertBots\)/)
})

test('client <file>: read from a path relative to the caller, size-checked', async () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'client.json'), JSON.stringify(fixture('client_secret.json')))
  let got = null
  const r = await runCli(['client', 'client.json'], deps(base, { client: async (text) => ((got = text), { ok: true, message: 'saved' }) }), { cwd: dir })
  assert.equal(r.code, 0)
  assert.match(got, /installed/)
  fs.writeFileSync(path.join(dir, 'big.json'), 'x'.repeat(70 * 1024))
  assert.match((await runCli(['client', 'big.json'], deps(base), { cwd: dir })).stderr, /too big/)
  assert.match((await runCli(['client', 'missing.json'], deps(base), { cwd: dir })).stderr, /cannot read .*ENOENT/)
  assert.match((await runCli(['client', '.'], deps(base), { cwd: dir })).stderr, /is not a file/)
})

test('read and unread hand the id to the host and print its answer', async () => {
  const st = { ...base, client: { id: 'x' }, signedIn: true, ready: true }
  const seen = []
  const d = deps(st, { mark: async (id, want) => (seen.push([id, want]), want === 'read' ? { message: 'Marked read.' } : { error: 'nope' }) })
  assert.equal((await runCli(['read', 'spaces/AAA/threads/T1'], d)).stdout, 'Marked read.\n')
  const bad = await runCli(['unread', 'alert:HighCPU'], d)
  assert.equal(bad.code, 1)
  assert.equal(bad.stderr, 'nope\n')
  assert.deepEqual(seen, [['spaces/AAA/threads/T1', 'read'], ['alert:HighCPU', 'unread']])
})
