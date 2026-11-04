'use strict'
// The inbox-feed service: the pure mapping (lib/feed.js) on made-up rows, then the host's provider
// over the fake Google (never a Google call for `items`, the refusals, `changed`, and an app whose
// services have no `useAll`).
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const feed = require('../dist/lib/feed')
const { fakeGoogle, fakeOAuth, fakeCtx, fakeTriage, tokens, fixture, NOW, S } = require('./fakes')

const CLIENT_FILE = JSON.stringify(fixture('client_secret.json'))
const T1 = `${S.team}/threads/T1`

// ---- the pure mapping ----

/** A view row as buildView makes it, cut down to what the feed reads. */
function vrow(id, o = {}) {
  const kind = o.kind || 'dm'
  return {
    id,
    kind: 'conv',
    lane: o.lane || 'direct',
    at: o.at === undefined ? 1000 : o.at,
    unread: o.unread === undefined ? true : o.unread,
    verdict: o.verdict === undefined ? { priority: 'fyi' } : o.verdict,
    title: o.title || 'Ann Example',
    preview: o.preview || 'Hello there',
    where: o.where || 'Direct message',
    from: o.from || 'Ann Example',
    mentioned: o.mentioned || null,
    conv: { kind, latest: { id: `${id}/messages/${o.latest || 'M1'}`, text: o.text || '' }, context: [], new: [] },
  }
}

test('a row becomes a FeedItem: ids, rev = the latest message name, flags, caps', () => {
  const r = vrow('spaces/AAA', { latest: 'M7', verdict: { priority: 'urgent' }, mentioned: 'me', kind: 'dm', preview: 'x'.repeat(500), from: 'y'.repeat(300), at: 5000 })
  const it = feed.feedItem(r)
  assert.deepEqual(Object.keys(it).sort(), ['at', 'direct', 'from', 'id', 'level', 'mentionsMe', 'rev', 'title', 'unread', 'where'])
  assert.equal(it.id, 'spaces/AAA')
  assert.equal(it.rev, 'spaces/AAA/messages/M7')
  assert.equal(it.level, 'urgent')
  assert.equal(it.direct, true)
  assert.equal(it.mentionsMe, true)
  assert.equal(it.unread, true)
  assert.equal(it.at, 5000)
  assert.equal(it.title.length, 300)
  assert.equal(it.from.length, 120)
  assert.equal(feed.feedItem(vrow('spaces/AAA', { kind: 'space', lane: 'mentions' })).direct, false)
  assert.equal(feed.feedItem(vrow('spaces/AAA', { kind: 'group' })).direct, true)
})

test('rev changes with a new message and with nothing else', () => {
  const a = feed.feedItem(vrow('spaces/AAA', { latest: 'M1' }))
  const same = feed.feedItem(vrow('spaces/AAA', { latest: 'M1', unread: false, verdict: { priority: 'action' }, at: 9 }))
  const next = feed.feedItem(vrow('spaces/AAA', { latest: 'M2' }))
  assert.equal(a.rev, same.rev)
  assert.notEqual(a.rev, next.rev)
})

test('level: the verdict; without one a mention is action and a DM fyi; an unknown priority falls back', () => {
  for (const p of ['urgent', 'action', 'fyi', 'noise']) assert.equal(feed.levelOf(vrow('spaces/A', { verdict: { priority: p } })), p)
  assert.equal(feed.levelOf(vrow('spaces/A', { verdict: null, lane: 'mentions' })), 'action')
  assert.equal(feed.levelOf(vrow('spaces/A', { verdict: null, lane: 'direct' })), 'fyi')
  assert.equal(feed.levelOf(vrow('spaces/A', { verdict: { priority: 'bogus' }, lane: 'direct' })), 'fyi')
})

test('a Jira key in the conversation is passed through, none otherwise', () => {
  const r = vrow('spaces/A')
  r.conv.latest.text = 'Please look at ABC-123 today'
  assert.equal(feed.feedItem(r).jiraKey, 'ABC-123')
  assert.equal('jiraKey' in feed.feedItem(vrow('spaces/B')), false)
})

test('order: level, then the newest, then the id; noise only when nothing else', () => {
  const rows = [
    vrow('spaces/B', { verdict: { priority: 'fyi' }, at: 300 }),
    vrow('spaces/C', { verdict: { priority: 'noise' }, at: 900 }),
    vrow('spaces/D', { verdict: { priority: 'urgent' }, at: 100 }),
    vrow('spaces/E', { verdict: { priority: 'fyi' }, at: 300 }),
    vrow('spaces/F', { verdict: { priority: 'action' }, at: 50 }),
    vrow('spaces/G', { verdict: { priority: 'fyi' }, at: 400 }),
  ]
  assert.deepEqual(feed.feedItems(rows, 50).map((i) => i.id), ['spaces/D', 'spaces/F', 'spaces/G', 'spaces/B', 'spaces/E'])
  const onlyNoise = [vrow('spaces/N1', { verdict: { priority: 'noise' }, at: 1 }), vrow('spaces/N2', { verdict: { priority: 'noise' }, at: 2 })]
  assert.deepEqual(feed.feedItems(onlyNoise, 50).map((i) => i.id), ['spaces/N2', 'spaces/N1'])
  assert.deepEqual(feed.feedItems([], 50), [])
})

test('limit: clamped to 1..50, default 20, junk refused or defaulted', () => {
  const rows = Array.from({ length: 60 }, (_, i) => vrow(`spaces/R${i}`, { at: i }))
  assert.equal(feed.feedItems(rows, feed.itemsOptions({ limit: 500 }).limit).length, 50)
  assert.equal(feed.feedItems(rows, feed.itemsOptions({ limit: 0 }).limit).length, 1)
  assert.equal(feed.feedItems(rows, feed.itemsOptions({ limit: -4 }).limit).length, 1)
  assert.equal(feed.feedItems(rows, feed.itemsOptions({ limit: 3.9 }).limit).length, 3)
  assert.equal(feed.itemsOptions().limit, 20)
  assert.equal(feed.itemsOptions({ limit: 'many' }).limit, 20)
  assert.throws(() => feed.itemsOptions('x'), /options are an object/)
  assert.throws(() => feed.itemsOptions([]), /options are an object/)
})

test('feedRows: Mentions and Direct messages conversations only', () => {
  const view = {
    lanes: [
      { id: 'mentions', rows: [vrow('spaces/M', { lane: 'mentions' })] },
      { id: 'direct', rows: [vrow('spaces/D')] },
      { id: 'spaces', rows: [vrow('spaces/S', { lane: 'spaces' })] },
      { id: 'alerts', rows: [{ id: 'alert:Disk', kind: 'alert', lane: 'alerts' }] },
      { id: 'recent', rows: [vrow('spaces/R', { lane: 'recent' })] },
    ],
  }
  assert.deepEqual(feed.feedRows(view).map((r) => r.id), ['spaces/M', 'spaces/D'])
})

test('checkId: strings of the Chat id shape only', () => {
  assert.equal(feed.checkId('spaces/AAA'), 'spaces/AAA')
  assert.equal(feed.checkId('spaces/AAA/threads/T1'), 'spaces/AAA/threads/T1')
  for (const bad of [undefined, null, 5, {}, [], '', 'x', '../etc', 'spaces/', 'alert:Disk', 'spaces/a b', `spaces/${'A'.repeat(400)}`]) assert.throws(() => feed.checkId(bad), /not a conversation id/, String(bad))
})

test('recentRows: read conversations of the Recent lane only; hidden lane gives none', () => {
  const view = {
    lanes: [
      { id: 'direct', rows: [vrow('spaces/D')] },
      { id: 'recent', rows: [vrow('spaces/R1', { lane: 'recent', unread: false }), vrow('spaces/R2', { lane: 'recent', unread: true }), { id: 'alert:X', kind: 'alert', lane: 'recent', unread: false }] },
    ],
  }
  assert.deepEqual(feed.recentRows(view).map((r) => r.id), ['spaces/R1'])
  assert.deepEqual(feed.recentRows({ lanes: [{ id: 'direct', rows: [vrow('spaces/D')] }] }), [])
  assert.deepEqual(feed.recentRows({ lanes: [] }), [])
})

test('recentItems: newest first (then id), no level order, noise kept, same FeedItem as items, limit cuts', () => {
  const rows = [
    vrow('spaces/B', { lane: 'recent', unread: false, verdict: { priority: 'urgent' }, at: 100 }),
    vrow('spaces/C', { lane: 'recent', unread: false, verdict: { priority: 'noise' }, at: 900 }),
    vrow('spaces/A', { lane: 'recent', unread: false, at: 100 }),
  ]
  const out = feed.recentItems(rows, 50)
  assert.deepEqual(out.map((i) => i.id), ['spaces/C', 'spaces/A', 'spaces/B'])
  assert.deepEqual(out[1], feed.feedItem(rows[2]))
  assert.equal(out.every((i) => i.unread === false), true)
  assert.equal(feed.recentItems(rows, 2).length, 2)
  assert.deepEqual(feed.recentItems([], 5), [])
  const many = Array.from({ length: 60 }, (_, i) => vrow(`spaces/R${i}`, { lane: 'recent', unread: false, at: i }))
  assert.equal(feed.recentItems(many, feed.itemsOptions({ limit: 999 }).limit).length, 50)
  assert.equal(feed.recentItems(many, feed.itemsOptions({ limit: 0 }).limit).length, 1)
  assert.equal(feed.recentItems(many, feed.itemsOptions({ limit: 'junk' }).limit).length, 20)
  assert.equal(feed.recentItems(many, feed.itemsOptions().limit)[0].id, 'spaces/R59')
})

// ---- the host ----

function boot(opts = {}) {
  const reg = tokens()
  const google = fakeGoogle({ tokens: reg, ...(opts.google || {}) })
  const ctx = fakeCtx({ project: { alertBots: ['Grafana'], ...(opts.project || {}) }, oauth: fakeOAuth(reg), triage: opts.triage === undefined ? fakeTriage() : opts.triage, reviewer: opts.reviewer })
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: google.fetch, now: () => NOW, setTimeout: () => 0, clearTimeout: () => {}, cliWaitMs: 3000 })
  return { ctx, h, google }
}

async function until(fn, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function signedIn(opts) {
  const b = boot(opts)
  await b.h.ready
  await b.ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  await b.ctx.sendPanel({ type: 'signIn' })
  await until(() => b.h.S.state && b.h.S.state.lastPoll)
  for (let i = 0; i < 5; i++) {
    await b.h.S.polling
    await b.h.S.classifying
    await new Promise((r) => setTimeout(r, 2))
  }
  return b
}

test('provides inbox-feed with the contract methods; describe and features', async () => {
  const { ctx, h } = boot()
  const svc = ctx.provided['inbox-feed']
  assert.deepEqual(Object.keys(svc).sort(), ['describe', 'features', 'items', 'markRead', 'markUnread', 'open', 'recent'])
  assert.deepEqual(await svc.describe(), { label: 'Chat', badge: 'CHAT', color: 'green', kind: 'chat' })
  assert.deepEqual(await svc.features(), ['markRead', 'recent', 'markUnread'])
  await h.stop()
})

test('items before any sign-in: signedOut, no items, no Google call', async () => {
  const { ctx, h, google } = boot()
  const r = await ctx.provided['inbox-feed'].items({ limit: 5 })
  assert.equal(r.state, 'signedOut')
  assert.deepEqual(r.items, [])
  assert.equal(typeof r.message, 'string')
  assert.equal(google.calls.length, 0)
  await h.stop()
})

test('items from the cache after a poll: the mention and the DM, best first, state ok, no new Google call', async () => {
  const b = await signedIn()
  const before = b.google.calls.length
  const r = await b.ctx.provided['inbox-feed'].items({ limit: 50 })
  assert.equal(b.google.calls.length, before, 'items never calls Google')
  assert.equal(r.state, 'ok')
  assert.ok(r.asOf > 0)
  const ids = r.items.map((i) => i.id)
  assert.ok(ids.includes(S.dm))
  assert.ok(ids.includes(T1))
  const t1 = r.items.find((i) => i.id === T1)
  assert.equal(t1.mentionsMe, true)
  assert.equal(t1.direct, false)
  assert.equal(t1.unread, true)
  assert.equal(t1.where, 'Acme Team')
  assert.match(t1.rev, /T1R1$|T1/)
  const dm = r.items.find((i) => i.id === S.dm)
  assert.equal(dm.direct, true)
  assert.equal(dm.where, 'Direct message')
  assert.equal(r.items.every((i) => i.level !== 'noise'), true)
  assert.equal((await b.ctx.provided['inbox-feed'].items({ limit: 1 })).items.length, 1)
  await b.h.stop()
})

test('items signed out after a poll: state signedOut with the last cached items; a poll error: state error', async () => {
  const b = await signedIn()
  b.h.S.error = 'Google Chat is busy'
  const e = await b.ctx.provided['inbox-feed'].items({})
  assert.equal(e.state, 'error')
  assert.match(e.message, /busy/)
  assert.ok(e.items.length > 0, 'the cached items still come')
  b.h.S.error = null
  await b.ctx.sendPanel({ type: 'signOut' })
  const r = await b.ctx.provided['inbox-feed'].items({})
  assert.equal(r.state, 'signedOut')
  assert.ok(r.items.length > 0, 'the last items come with signedOut')
  await b.h.stop()
})

test('open and markRead refuse a bad id; a known id works; markRead writes through the existing path', async () => {
  const b = await signedIn()
  const svc = b.ctx.provided['inbox-feed']
  for (const bad of [undefined, 7, '', 'nope', 'alert:Disk', 'spaces/ZZZ', `${S.team}/threads/NOPE`, { id: S.dm }]) {
    await assert.rejects(() => svc.open(bad), /^Error: chat: /, String(bad))
    await assert.rejects(() => svc.markRead(bad), /^Error: chat: /, String(bad))
  }
  assert.deepEqual(b.google.writes, [])
  await svc.markRead(S.dm)
  assert.equal(b.google.writes.length, 1)
  assert.equal(b.h.S.marks[S.dm] === undefined || b.h.S.marks[S.dm].want === 'read', true)
  await b.h.stop()
})

test('open runs what a row click runs: the conversation goes to the reviewer or the plain page', async () => {
  const { fakeReviewer } = require('./fakes')
  const reviewer = fakeReviewer()
  const b = await signedIn({ reviewer })
  await b.ctx.provided['inbox-feed'].open(T1)
  assert.equal(reviewer.calls.length, 1)
  assert.match(reviewer.calls[0].key, /./)
  await b.h.stop()
})

test('recent: only read rows of the Recent lane, newest first, from the cache; unread items never appear', async () => {
  const b = await signedIn()
  const svc = b.ctx.provided['inbox-feed']
  const before = b.google.calls.length
  const r = await svc.recent({ limit: 50 })
  assert.equal(b.google.calls.length, before, 'recent never calls Google')
  assert.equal(r.state, 'ok')
  assert.ok(r.asOf > 0)
  assert.ok(r.items.length > 0, 'the fake world has read conversations')
  assert.equal(r.items.every((i) => i.unread === false), true)
  const unreadIds = (await svc.items({ limit: 50 })).items.map((i) => i.id)
  assert.equal(r.items.some((i) => unreadIds.includes(i.id)), false)
  assert.equal(r.items.some((i) => i.id === S.dm || i.id === T1), false)
  assert.deepEqual(r.items.map((i) => i.at), [...r.items.map((i) => i.at)].sort((a, c) => c - a))
  assert.deepEqual(r, structuredClone(r))
  for (const k of ['id', 'rev', 'title', 'from', 'where', 'at', 'level', 'unread', 'direct', 'mentionsMe']) assert.ok(k in r.items[0], k)
  assert.equal((await svc.recent({ limit: 1 })).items.length, 1)
  assert.equal((await svc.recent({ limit: 0 })).items.length, 1)
  assert.equal((await svc.recent({ limit: 999 })).items.length, r.items.length)
  assert.equal((await svc.recent({ limit: 'junk' })).items.length, r.items.length)
  assert.equal((await svc.recent()).items.length, r.items.length)
  await assert.rejects(() => svc.recent('x'), /options are an object/)
  await b.h.stop()
})

test('recent: a hidden Recent lane gives no items; signed out gives signedOut; a poll error gives error', async () => {
  const hidden = await signedIn({ project: { lanes: { recent: false } } })
  assert.deepEqual((await hidden.ctx.provided['inbox-feed'].recent({})).items, [])
  assert.equal((await hidden.ctx.provided['inbox-feed'].recent({})).state, 'ok')
  await hidden.h.stop()

  const out = boot()
  const r0 = await out.ctx.provided['inbox-feed'].recent({})
  assert.equal(r0.state, 'signedOut')
  assert.deepEqual(r0.items, [])
  assert.equal(typeof r0.message, 'string')
  await out.h.stop()

  const b = await signedIn()
  b.h.S.error = 'Google Chat is busy'
  const e = await b.ctx.provided['inbox-feed'].recent({})
  assert.equal(e.state, 'error')
  assert.match(e.message, /busy/)
  assert.ok(e.items.length > 0)
  b.h.S.error = null
  await b.ctx.sendPanel({ type: 'signOut' })
  assert.equal((await b.ctx.provided['inbox-feed'].recent({})).state, 'signedOut')
  await b.h.stop()
})

test('every id recent returns opens through open, as a row click does, and open marks nothing read', async () => {
  const { fakeReviewer } = require('./fakes')
  const reviewer = fakeReviewer()
  const b = await signedIn({ reviewer })
  const svc = b.ctx.provided['inbox-feed']
  const r = await svc.recent({ limit: 50 })
  assert.ok(r.items.length > 0)
  for (const [n, it] of r.items.entries()) {
    await svc.open(it.id)
    assert.equal(reviewer.calls.length, n + 1, it.id)
  }
  assert.deepEqual(b.google.writes, [], 'open writes nothing')
  assert.equal(Object.keys(b.h.S.marks).length, 0, 'open marks nothing')
  // Unknown ids stay refused, also after the widening.
  await assert.rejects(() => svc.open('spaces/ZZZ'), /^Error: chat: /)
  await b.h.stop()
})

test('markRead on a read (Recent) row is a harmless no-op for the feed', async () => {
  const b = await signedIn()
  const svc = b.ctx.provided['inbox-feed']
  const id = (await svc.recent({})).items[0].id
  await svc.markRead(id).catch(() => {}) // may refuse a row with no mark target; must not throw anything but chat: errors
  assert.equal((await svc.recent({ limit: 50 })).items.every((i) => i.unread === false), true)
  await b.h.stop()
})

test('markUnread: a read (Recent) row goes through the panel write, moves to items, changed is emitted', async () => {
  const b = await signedIn()
  const svc = b.ctx.provided['inbox-feed']
  const id = (await svc.recent({ limit: 50 })).items.find((i) => !i.id.includes('/threads/')).id
  const n = () => b.ctx.emitted.filter((e) => e.name === 'inbox-feed' && e.event === 'changed').length
  const before = n()
  const writes = b.google.writes.length
  await svc.markUnread(id)
  assert.equal(b.google.writes.length, writes + 1, 'one read-state write')
  assert.ok(n() > before)
  assert.ok((await svc.items({ limit: 50 })).items.some((i) => i.id === id) || b.h.S.marks[id].want === 'unread')
  assert.ok(!(await svc.recent({ limit: 50 })).items.some((i) => i.id === id))
  await b.h.stop()
})

test('markUnread: unknown ids and alert rows are refused as chat: errors, nothing written', async () => {
  const b = await signedIn()
  const svc = b.ctx.provided['inbox-feed']
  for (const bad of [undefined, 7, '', 'nope', 'alert:Disk', 'spaces/ZZZ']) await assert.rejects(() => svc.markUnread(bad), /^Error: chat: /, String(bad))
  assert.deepEqual(b.google.writes, [])
  await b.h.stop()
})

test('markUnread: a thread row rejects with the panel\'s own message (Chat cannot change a thread\'s read state)', async () => {
  const b = await signedIn()
  const svc = b.ctx.provided['inbox-feed']
  const t = (await svc.recent({ limit: 50 })).items.find((i) => i.id.includes('/threads/'))
  if (t) await assert.rejects(() => svc.markUnread(t.id), /^Error: chat: .*thread/)
  assert.deepEqual(b.google.writes, [])
  await b.h.stop()
})

test('markUnread: a failing write rejects as chat: and the row stays read', async () => {
  const fail = new Proxy({}, { get: (_, k) => (typeof k === 'string' && k.startsWith('patch:') ? 500 : undefined) })
  const b = await signedIn({ google: { fail } })
  const svc = b.ctx.provided['inbox-feed']
  const id = (await svc.recent({ limit: 50 })).items.find((i) => !i.id.includes('/threads/')).id
  await assert.rejects(() => svc.markUnread(id), /^Error: chat: .*Could not mark/)
  assert.ok((await svc.recent({ limit: 50 })).items.some((i) => i.id === id))
  await b.h.stop()
})

test('changed is emitted after a poll and after a read change', async () => {
  const b = await signedIn()
  const n = () => b.ctx.emitted.filter((e) => e.name === 'inbox-feed' && e.event === 'changed').length
  assert.ok(n() >= 1, 'after the first poll')
  assert.deepEqual(b.ctx.emitted.at(-1), { name: 'inbox-feed', event: 'changed', data: {} })
  const afterPoll = n()
  await b.h.pollNow('test', true)
  assert.ok(n() > afterPoll, 'after another poll')
  const beforeMark = n()
  await b.ctx.sendPanel({ type: 'read', id: S.dm })
  assert.ok(n() > beforeMark, 'after a read change')
  await b.h.stop()
})

test('an app whose services have no useAll (before 0.9.7): still activates and provides', async () => {
  const reg = tokens()
  const ctx = fakeCtx({ oauth: fakeOAuth(reg), triage: fakeTriage() })
  assert.equal('useAll' in ctx.services, false)
  const mod = require('../dist/host')
  mod.activate(ctx)
  assert.deepEqual(Object.keys(ctx.provided), ['inbox-feed'])
  assert.equal((await ctx.provided['inbox-feed'].items({})).state, 'signedOut')
  await mod.deactivate()
})
