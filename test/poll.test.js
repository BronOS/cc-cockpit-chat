'use strict'
// One poll against the fake Google: the lanes of the example organisation, what a second poll asks
// again (and what it leaves alone), a read in Chat, a failing space, the fatal errors, the optimistic
// marks in the view, and the mark targets.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createClient } = require('../dist/lib/client')
const { poll, checkAccount, buildView, emptyState, loadState, readTarget, fatal, allRows } = require('../dist/lib/poll')
const { readSettings } = require('../dist/lib/settings')
const { createNames } = require('../dist/lib/names')
const { fakeGoogle, tokens, ago, msg, NOW, U, S, ALL_SCOPES } = require('./fakes')

function setup(opts = {}) {
  const reg = tokens()
  reg.valid.add(TOKEN)
  const g = fakeGoogle({ tokens: reg, ...opts })
  const client = createClient({ getToken: async () => TOKEN, invalidate() {}, fetch: g.fetch })
  const state = emptyState('c1')
  const names = createNames(null, () => NOW)
  const cfg = readSettings(opts.project || { alertBots: ['Grafana'] }).cfg
  const run = (now = NOW) => poll({ client, cfg, state, names, now })
  const view = (marks = {}, verdicts = {}) => buildView({ cfg, state, names, marks, verdicts, now: NOW })
  return { g, client, state, names, cfg, run, view }
}

const TOKEN = 'ya29.poll-token'
const lane = (v, id) => v.lanes.find((l) => l.id === id)
const ids = (v, id) => lane(v, id).rows.map((r) => r.id)

test('checkAccount: the address and scopes from the token info, your user id from a message of yours', async () => {
  const s = setup()
  const info = await checkAccount({ client: s.client, state: s.state })
  assert.deepEqual(info, { email: 'me@example.com', sub: '1001', missing: [] })
  assert.equal(s.state.account, 'me@example.com')
  assert.equal(s.state.me, U.me)
  assert.equal(s.state.meChecked, true)
  const tokeninfo = s.g.calls.find((c) => c.path === '/tokeninfo')
  assert.equal(tokeninfo.method, 'POST')
  assert.ok(!tokeninfo.url.includes(TOKEN), 'the token in the header, never the URL')
  // Once checked, the next check asks only the token info.
  const n = s.g.calls.length
  await checkAccount({ client: s.client, state: s.state })
  assert.equal(s.g.calls.length, n + 1)
})

test('checkAccount: a grant without the messages scope is reported, and no message search is tried', async () => {
  const s = setup({ scope: 'openid https://www.googleapis.com/auth/chat.spaces.readonly' })
  const info = await checkAccount({ client: s.client, state: s.state })
  assert.deepEqual(info.missing, ['messages', 'readstate', 'directory'])
  assert.equal(s.state.me, U.me, 'the account id stands in')
  assert.equal(s.state.meChecked, false)
  assert.ok(!s.g.calls.some((c) => c.path.endsWith(':search')))
})

test('the first poll: every lane of the example organisation', async () => {
  const s = setup()
  await checkAccount({ client: s.client, state: s.state })
  const r = await s.run()
  assert.deepEqual(r.stats.errors, [])
  assert.equal(r.stats.spaces, 4, 'the space quiet for a month is not read')
  assert.ok(!s.g.calls.some((c) => c.path.includes('STALE')))
  const v = s.view()
  assert.deepEqual(v.lanes.map((l) => l.id), ['mentions', 'direct', 'spaces', 'alerts', 'recent'])
  assert.deepEqual(ids(v, 'mentions'), [`${S.team}/threads/T1`])
  assert.deepEqual(ids(v, 'direct'), [S.dm])
  assert.deepEqual(ids(v, 'spaces'), [`${S.team}/threads/T2`])
  assert.deepEqual(ids(v, 'alerts'), ['alert:HighCPU'])
  assert.deepEqual(ids(v, 'recent').sort(), [S.random, `${S.team}/threads/T3`].sort())
  assert.equal(v.unread, 2, 'the badge: mentions and direct messages only')
  const dm = lane(v, 'direct').rows[0]
  assert.equal(dm.title, 'Ann Example', 'a DM is titled with the person (People API name)')
  assert.match(dm.sub, /^Can you look at the/)
  const t1 = lane(v, 'mentions').rows[0]
  assert.equal(t1.title, 'Release plan for Friday @you please check')
  assert.equal(t1.mentioned, 'me')
  assert.equal(t1.count, 2)
  assert.deepEqual(t1.target, { [S.team]: ago(25) })
  assert.equal(lane(v, 'recent').rows.find((x) => x.id === `${S.team}/threads/T3`).target, null, 'a read reply in a thread you do not follow: no target')
  const people = s.g.calls.filter((c) => c.origin === 'https://people.googleapis.com')
  assert.equal(people.length, 1, 'one People API call for the names')
})

test('the Alerts lane only with alert bots; without, the alerts are a space conversation', async () => {
  const s = setup({ project: {} })
  await checkAccount({ client: s.client, state: s.state })
  await s.run()
  const v = s.view()
  assert.ok(!v.lanes.some((l) => l.id === 'alerts'))
  assert.ok(ids(v, 'spaces').includes(S.alerts))
})

test('a second poll with nothing new: only the space list, the search and the spaces with unread rows', async () => {
  const s = setup()
  await checkAccount({ client: s.client, state: s.state })
  await s.run()
  const before = s.g.calls.length
  const r = await s.run(NOW + 60000)
  const calls = s.g.calls.slice(before).map((c) => `${c.method} ${c.path}`)
  assert.ok(calls.includes('GET /v1/spaces'))
  assert.ok(!calls.includes('GET /v1/users/me/spaces/RANDOM/spaceReadState'), 'a read, quiet space is not asked')
  assert.ok(calls.includes('GET /v1/users/me/spaces/DMANN/spaceReadState'), 'an unread one may have been read in Chat')
  assert.ok(!calls.some((c) => /\/v1\/spaces\/(DMANN|RANDOM)\/messages/.test(c)), 'unchanged: no messages read again')
  assert.equal(r.stats.read, 1, 'only TEAM: the mention hit makes it read again')
})

test('read in Chat meanwhile: the space read time moved, its rows go to Recent', async () => {
  const s = setup()
  await checkAccount({ client: s.client, state: s.state })
  await s.run()
  s.g.world.read[S.dm] = ago(1)
  await s.run(NOW + 60000)
  const v = s.view()
  assert.deepEqual(ids(v, 'direct'), [])
  assert.ok(ids(v, 'recent').includes(S.dm))
})

test('a new message arrives: the space activity changed, it is read again', async () => {
  const s = setup()
  await checkAccount({ client: s.client, state: s.state })
  await s.run()
  s.g.world.messages[S.random].push(msg(S.random, 'R2', { from: U.bob, at: ago(1), text: 'More cake' }))
  s.g.world.spaces.find((x) => x.name === S.random).lastActiveTime = ago(1)
  await s.run(NOW + 60000)
  const v = s.view()
  assert.ok(ids(v, 'spaces').includes(S.random))
  assert.match(lane(v, 'spaces').rows.find((x) => x.id === S.random).sub, /Bob Example: More cake/)
})

test('one space failing keeps its last rows and is noted; the poll goes on', async () => {
  const s = setup()
  await checkAccount({ client: s.client, state: s.state })
  await s.run()
  s.g.world.spaces.find((x) => x.name === S.dm).lastActiveTime = ago(0.5)
  const failing = setup({ world: s.g.world, fail: { [`messages:${S.dm}`]: 500 } })
  failing.state.spaces = s.state.spaces
  failing.state.me = U.me
  failing.state.lastPoll = s.state.lastPoll
  const r = await poll({ client: failing.client, cfg: s.cfg, state: failing.state, names: s.names, now: NOW + 60000 })
  assert.equal(r.stats.errors.length, 1)
  assert.equal(r.stats.errors[0].space, S.dm)
  assert.ok(r.busy, 'a 5xx is busy: the host backs off')
  assert.ok(failing.state.spaces[S.dm].convs.length, 'the last rows stay')
  assert.equal(failing.state.spaces[S.dm].unread, true)
})

test('a failed mentions search is a note, never fatal', async () => {
  const s = setup({ fail: { search: 400 } })
  s.state.me = U.me
  const r = await s.run()
  assert.match(r.stats.notes.join('\n'), /mentions search failed/)
  assert.ok(lane(s.view(), 'mentions').rows.length, 'the per-space reads still find the mention')
})

test('fatal: a dead token, a missing scope, a personal account, the Chat API off stop the poll', async () => {
  for (const [fail, kind] of [
    [{ spaces: 401 }, 'auth'],
    [{ spaces: 403 }, 'scope'],
    [{ spaces: { status: 403, body: { error: { code: 403, message: 'Google Chat API is only available to Google Workspace users.' } } } }, 'workspace'],
    [{ spaces: { status: 403, body: { error: { code: 403, message: 'Google Chat API has not been used in project 1 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } } } }, 'disabled'],
  ]) {
    const s = setup({ fail })
    await assert.rejects(s.run(), (e) => e.kind === kind && fatal(e), kind)
  }
  assert.equal(fatal({ kind: 'disabled', api: 'people' }), false, 'People API off: names only')
  assert.equal(fatal({ kind: 'server' }), false)
})

test('the People API off: a note, the senders stay unknown, the poll stands', async () => {
  const s = setup({ fail: { people: { status: 403, body: { error: { code: 403, message: 'People API has not been used in project 1', details: [{ reason: 'SERVICE_DISABLED' }] } } } } })
  s.state.me = U.me
  const r = await s.run()
  assert.match(r.stats.notes.join('\n'), /People API is not enabled/)
  assert.equal(lane(s.view(), 'direct').rows[0].title, 'unknown user')
})

test('marks in the view: read takes a row out of its lane into Recent, unread puts it back, an alert read is gone', async () => {
  const s = setup()
  await checkAccount({ client: s.client, state: s.state })
  await s.run()
  const v = s.view({ [S.dm]: { want: 'read', state: 'pending' }, [S.random]: { want: 'unread', state: 'done' }, 'alert:HighCPU': { want: 'read', state: 'pending' } })
  assert.deepEqual(ids(v, 'direct'), [])
  const dm = lane(v, 'recent').rows.find((r) => r.id === S.dm)
  assert.equal(dm.unread, false)
  assert.equal(dm.pending, true)
  assert.ok(ids(v, 'spaces').includes(S.random))
  assert.deepEqual(ids(v, 'alerts'), [])
  assert.equal(v.unread, 1)
})

test('readTarget: the newest message of others; none for an unfollowed thread whose latest is a reply', () => {
  assert.deepEqual(readTarget({ space: 'spaces/A', thread: null, latest: { at: 't1', reply: false } }), { 'spaces/A': 't1' })
  assert.deepEqual(readTarget({ space: 'spaces/A', thread: 'spaces/A/threads/T', latest: { at: 't2', reply: false } }), { 'spaces/A': 't2' })
  assert.deepEqual(readTarget({ space: 'spaces/A', thread: 'spaces/A/threads/T', followed: 'me', latest: { at: 't3', reply: true } }), { 'spaces/A': 't3' })
  assert.equal(readTarget({ space: 'spaces/A', thread: 'spaces/A/threads/T', followed: null, latest: { at: 't4', reply: true } }), null)
})

test('state: kept per client, bounded, a mark rechecks its space next poll', async () => {
  const s = setup()
  await checkAccount({ client: s.client, state: s.state })
  await s.run()
  assert.equal(loadState(JSON.parse(JSON.stringify(s.state)), 'c1').account, 'me@example.com')
  assert.equal(loadState(JSON.parse(JSON.stringify(s.state)), 'other').account, '', 'another client: a fresh state')
  for (const sp of Object.values(s.state.spaces)) for (const c of sp.convs) assert.ok(c.new.length + c.context.length <= 20)
  s.state.marked[S.random] = NOW
  const before = s.g.calls.length
  await s.run(NOW + 60000)
  assert.ok(s.g.calls.slice(before).some((c) => c.path === '/v1/users/me/spaces/RANDOM/spaceReadState'))
  assert.deepEqual(s.state.marked, {}, 'checked: the mark is Chat\'s state now')
  assert.ok(JSON.stringify(s.state).length < 50000)
  assert.equal(allRows(s.view()).length, 6)
  assert.ok(ALL_SCOPES)
})
