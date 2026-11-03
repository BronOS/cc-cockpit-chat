'use strict'
// What jev-triage gets per row (source `chat`): the text in full and summary mode, the alert hint,
// the floor for a direct @mention (not for a DM), and the short fields rules match.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createClient } = require('../dist/lib/client')
const { poll, checkAccount, buildView, emptyState, allRows } = require('../dist/lib/poll')
const { readSettings } = require('../dist/lib/settings')
const { createNames } = require('../dist/lib/names')
const { triageItem, jiraKey, CUTS } = require('../dist/lib/triage')
const { fakeGoogle, tokens, msg, ago, NOW, U, S } = require('./fakes')

async function rows(mutate) {
  const reg = tokens()
  reg.valid.add('ya29.t')
  const g = fakeGoogle({ tokens: reg })
  if (mutate) mutate(g.world)
  const client = createClient({ getToken: async () => 'ya29.t', invalidate() {}, fetch: g.fetch })
  const state = emptyState('c')
  const names = createNames(null, () => NOW)
  const cfg = readSettings({ alertBots: ['Grafana'] }).cfg
  await checkAccount({ client, state })
  await poll({ client, cfg, state, names, now: NOW })
  const view = buildView({ cfg, state, names, now: NOW })
  return { names, me: state.me, byId: Object.fromEntries(allRows(view).map((r) => [r.id, r])) }
}

test('a thread that @mentions you: floor action, to me, the new messages and the context', async () => {
  const { names, me, byId } = await rows()
  const it = triageItem(byId[`${S.team}/threads/T1`], 'full', names, me)
  assert.equal(it.id, `${S.team}/threads/T1`)
  assert.equal(it.floor, 'action')
  assert.equal(it.hint, undefined)
  assert.deepEqual(it.fields, { from: 'Cat Example', space: 'Acme Team', kind: 'thread', to: 'me', lane: 'mentions' })
  assert.match(it.text, /^Google Chat, space 'Acme Team', one thread/)
  assert.match(it.text, /Addressed to: the person \(@mentioned/)
  assert.match(it.text, /New messages to judge:\n {2}Bob Example: Release plan for Friday @you please check\n {2}Cat Example: I can help with the release/)
  assert.ok(!it.text.includes('<users/'), 'mentions are named, not markup')
})

test('a DM gets no floor: Jev decides', async () => {
  const { names, me, byId } = await rows()
  const it = triageItem(byId[S.dm], 'full', names, me)
  assert.equal(it.floor, undefined)
  assert.equal(it.fields.kind, 'dm')
  assert.equal(it.fields.to, 'me')
  assert.match(it.text, /^Google Chat, direct message with Ann Example/)
})

test('an @all is everyone, no floor (answer 5)', async () => {
  const { names, me, byId } = await rows((w) => {
    w.messages[S.team].push(msg(S.team, 'T5.T5', { from: U.bob, at: ago(5), text: 'All hands at 3 <users/all>', thread: 'T5', mentions: ['all'] }))
    w.spaces.find((s) => s.name === S.team).lastActiveTime = ago(5)
  })
  const row = byId[`${S.team}/threads/T5`]
  assert.equal(row.lane, 'spaces')
  const it = triageItem(row, 'full', names, me)
  assert.equal(it.fields.to, 'all')
  assert.equal(it.floor, undefined)
  assert.match(it.text, /All hands at 3 @all/)
})

test('an alert row: hinted noise, the alert as a field', async () => {
  const { names, me, byId } = await rows()
  const it = triageItem(byId['alert:HighCPU'], 'full', names, me)
  assert.deepEqual(it.hint, { priority: 'noise' })
  assert.equal(it.fields.kind, 'alert')
  assert.match(it.fields.alert, /^HighCPU/)
  assert.match(it.text, /2 unread alert messages firing, nodes: node-1, node-2/)
})

test('summary mode: who, where, whom; no message text', async () => {
  const { names, me, byId } = await rows()
  for (const r of Object.values(byId)) {
    const it = triageItem(r, 'summary', names, me)
    assert.ok(!/Release plan|Lunch|deploy|Cake|migration/.test(it.text), `${r.id}: ${it.text}`)
  }
})

test('a read row judges its newest message; texts are cut', async () => {
  const long = 'x'.repeat(5000)
  const { names, me, byId } = await rows((w) => {
    w.messages[S.random].push(msg(S.random, 'R2', { from: U.bob, at: ago(200), text: long }))
  })
  const it = triageItem(byId[S.random], 'full', names, me)
  assert.match(it.text, /Latest message \(already read\) to judge:/)
  assert.ok(it.text.length < CUTS.newText + 500)
  assert.equal(it.floor, undefined)
})

test('a Jira key in the conversation is a field', () => {
  assert.equal(jiraKey({ context: [{ text: 'see ACME-123 please' }], new: [], latest: { text: '' } }), 'ACME-123')
  assert.equal(jiraKey({ context: [], new: [{ text: 'utf-8 and x-1' }], latest: { text: '' } }), null)
})
