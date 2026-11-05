'use strict'
// The inbox-feed service (v2): the pure mapping (lib/feed.js) on made-up rows, then the host's
// provider over the fake Google (snapshot from the cache, act, the events a diff makes, the sync
// triggers, and an app whose services have no useAll).
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const feed = require('../dist/lib/feed')
const { readSettings } = require('../dist/lib/settings')
const { fakeGoogle, fakeOAuth, fakeCtx, fakeTriage, fakeReviewer, tokens, fixture, json, NOW, S } = require('./fakes')

const CLIENT_FILE = JSON.stringify(fixture('client_secret.json'))
const T1 = `${S.team}/threads/T1`
const T2 = `${S.team}/threads/T2`
const T3 = `${S.team}/threads/T3`

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
    verdict: { priority: 'fyi' },
    title: o.title || 'Ann Example',
    preview: o.preview || 'Hello there',
    where: o.where || 'Direct message',
    from: o.from || 'Ann Example',
    mentioned: o.mentioned || null,
    target: o.target === undefined ? { [id]: '2026-11-03T10:00:00Z' } : o.target,
    conv: { kind, latest: { id: `${id}/messages/${o.latest || 'M1'}`, text: o.text || '' }, context: [], new: [] },
  }
}

const cfgOf = (project = {}) => readSettings(project).cfg

test('feedItem: every field of the contract; rev is the latest message name, time the newest, place the space', () => {
  const it = feed.feedItem(vrow('spaces/AAA', { latest: 'M7', mentioned: 'me', kind: 'space', where: 'Acme Team', at: 5000 }))
  assert.deepEqual(it, {
    id: 'spaces/AAA',
    rev: 'spaces/AAA/messages/M7',
    title: 'Ann Example',
    time: 5000,
    read: false,
    actions: [{ id: 'open', label: 'Open' }, { id: 'markRead', label: 'Mark read' }],
    preview: 'Hello there',
    from: { name: 'Ann Example' },
    to: 'group',
    mentionsMe: true,
    place: { kind: 'channel', name: 'Acme Team' },
  })
  assert.deepEqual(feed.feedItem(vrow('spaces/DDD', { kind: 'dm' })).to, 'direct')
  assert.deepEqual(feed.feedItem(vrow('spaces/GGG', { kind: 'group' })).to, 'group')
  assert.equal('level' in it || 'canUnread' in it || 'jiraKey' in it || 'unread' in it, false, 'the v1 fields are gone')
})

test('feedItem: a read row offers markUnread; no mark target (a thread reply) offers open only; rev ignores a read change', () => {
  const read = feed.feedItem(vrow('spaces/A', { unread: false }))
  assert.equal(read.read, true)
  assert.deepEqual(read.actions.map((a) => a.id), ['open', 'markUnread'])
  assert.deepEqual(feed.feedItem(vrow('spaces/A/threads/T', { target: null })).actions.map((a) => a.id), ['open'])
  assert.deepEqual(feed.feedItem(vrow('spaces/A/threads/T', { target: null, unread: false })).actions.map((a) => a.id), ['open'])
  assert.equal(feed.feedItem(vrow('spaces/A', { latest: 'M1' })).rev, read.rev)
  assert.notEqual(feed.feedItem(vrow('spaces/A', { latest: 'M2' })).rev, read.rev)
})

test('feedItem: caps (title 300, preview 1000, name 120, place 120, rev 100), labels from @all, alerts and a Jira key, no duplicates', () => {
  const r = vrow('spaces/AAA', { title: 'x'.repeat(500), preview: 'y'.repeat(2000), from: 'f'.repeat(300), where: 'w'.repeat(300), mentioned: 'all', text: 'see ABC-123 and ABC-123' })
  const it = feed.feedItem(r, { alerts: ['HighCPU', 'z'.repeat(100), 'HighCPU'] })
  assert.equal(it.title.length, 300)
  assert.equal(it.preview.length, 1000)
  assert.equal(it.from.name.length, 120)
  assert.equal(it.place.name.length, 120)
  assert.deepEqual(it.labels.slice(0, 3), ['mention:all', 'alert', 'alert:HighCPU'])
  assert.ok(it.labels.every((l) => l.length <= 40))
  assert.ok(it.labels.includes('jira:ABC-123'))
  assert.equal(it.mentionsMe, undefined)
  const long = feed.feedItem(vrow('spaces/AAA', { latest: 'M'.repeat(300) }))
  assert.ok(long.rev.length <= 100)
  assert.notEqual(long.rev, feed.feedItem(vrow('spaces/AAA', { latest: 'M'.repeat(299) + 'N' })).rev)
  assert.equal(feed.feedItem(vrow('spaces/' + 'a'.repeat(250))), null, 'an id over 200 characters cannot be an item')
  assert.equal(feed.feedItem(vrow('')), null)
})

test('feedRows and feedItems: every lane, an alert group as one item per conversation, newest first, deduplicated, limit cuts', () => {
  const view = {
    lanes: [
      { id: 'mentions', rows: [vrow('spaces/M', { at: 30 })] },
      { id: 'direct', rows: [vrow('spaces/D', { at: 10 })] },
      {
        id: 'alerts',
        rows: [
          { id: 'alert:HighCPU', kind: 'alert', group: { name: 'HighCPU' }, convRows: [vrow('spaces/AL', { at: 50 }), vrow('spaces/AL2', { at: 5 })] },
          { id: 'alert:Disk', kind: 'alert', group: { name: 'Disk' }, convRows: [vrow('spaces/AL', { at: 50 })] },
        ],
      },
      { id: 'recent', rows: [vrow('spaces/R', { at: 20, unread: false })] },
    ],
  }
  const rows = feed.feedRows(view)
  assert.equal(rows.length, 5)
  const items = feed.feedItems(rows)
  assert.deepEqual(items.map((i) => i.id), ['spaces/AL', 'spaces/M', 'spaces/R', 'spaces/D', 'spaces/AL2'])
  assert.deepEqual(items[0].labels, ['alert', 'alert:HighCPU', 'alert:Disk'], 'one conversation in two groups: one item, both names')
  assert.deepEqual(items[4].labels, ['alert', 'alert:HighCPU'])
  assert.equal(items[2].read, true)
  assert.equal(feed.feedItems(rows, { limit: 2 }).length, 2)
  assert.equal(feed.feedItems(rows, { limit: Infinity }).length, 5)
  // `only`: the same item as in the whole list (both alert names kept), nothing else built.
  assert.deepEqual(feed.feedItems(rows, { only: 'spaces/AL' }), [items[0]])
  assert.deepEqual(feed.feedItems(rows, { only: 'spaces/NOPE' }), [])
  // A stable order for equal times: the id.
  const tie = feed.feedItems([vrow('spaces/B', { at: 1 }), vrow('spaces/A', { at: 1 })])
  assert.deepEqual(tie.map((i) => i.id), ['spaces/A', 'spaces/B'])
  // At most 1000.
  const many = Array.from({ length: 1100 }, (_, i) => vrow(`spaces/X${i}`, { at: i + 1 }))
  const capped = feed.feedItems(many)
  assert.equal(capped.length, 1000)
  assert.equal(capped[0].id, 'spaces/X1099')
})

test('diffFeed: new and changed (each field) are items, missing ids are gone, a no-op is nothing', () => {
  const a = feed.feedItem(vrow('spaces/A'))
  const b = feed.feedItem(vrow('spaces/B'))
  assert.deepEqual(feed.diffFeed([a, b], [a, b]), { items: [], gone: [] })
  assert.deepEqual(feed.diffFeed([], [a]), { items: [a], gone: [] })
  assert.deepEqual(feed.diffFeed([a, b], [a]), { items: [], gone: ['spaces/B'] })
  assert.deepEqual(feed.diffFeed(new Map([[a.id, a]]), [a, b]).items, [b])
  const changes = [
    { rev: 'x' }, { title: 'other' }, { preview: 'other' }, { time: 2 }, { read: true }, { from: { name: 'Bob' } },
    { to: 'group' }, { mentionsMe: true }, { place: { kind: 'channel', name: 'Other' } }, { labels: ['alert'] }, { actions: [{ id: 'open', label: 'Open' }] },
  ]
  for (const c of changes) assert.deepEqual(feed.diffFeed([a], [{ ...a, ...c }]), { items: [{ ...a, ...c }], gone: [] }, Object.keys(c)[0])
  // Key order does not matter.
  const shuffled = Object.fromEntries(Object.entries(a).reverse())
  assert.deepEqual(feed.diffFeed([a], [shuffled]), { items: [], gone: [] })
})

test('goneChunks: at most 500 ids to an event', () => {
  const ids = Array.from({ length: 1201 }, (_, i) => `spaces/${i}`)
  assert.deepEqual(feed.goneChunks(ids).map((c) => c.length), [500, 500, 201])
  assert.deepEqual(feed.goneChunks([]), [])
})

test('scopeLine: accurate for every combination of lanes, at most 120 characters', () => {
  const line = (project) => feed.scopeLine(cfgOf(project))
  assert.equal(line({}), 'unread conversations + read of the last 2 days (newest 10)')
  assert.equal(line({ recentDays: 7, maxRecent: 30 }), 'unread conversations + read of the last 7 days (newest 30)')
  // Alert bots add the Alerts lane: all four on is still "every".
  assert.equal(line({ alertBots: ['Grafana'] }), 'unread conversations + read of the last 2 days (newest 10)')
  assert.equal(line({ alertBots: ['Grafana'], lanes: { alerts: false } }), 'unread mentions, direct messages and spaces + read of the last 2 days (newest 10)')
  assert.equal(line({ lanes: { spaces: false } }), 'unread mentions and direct messages + read of the last 2 days (newest 10)')
  assert.equal(line({ alertBots: ['Grafana'], lanes: { spaces: false, direct: false } }), 'unread mentions and alerts + read of the last 2 days (newest 10)')
  assert.equal(line({ lanes: { mentions: false, direct: false } }), 'unread spaces + read of the last 2 days (newest 10)')
  assert.equal(line({ lanes: { recent: false } }), 'unread conversations')
  assert.equal(line({ lanes: { mentions: false, direct: false, spaces: false } }), 'read of the last 2 days (newest 10)')
  assert.equal(line({ alertBots: ['Grafana'], lanes: { mentions: false, direct: false, spaces: false, recent: false } }), 'unread alerts')
  assert.equal(line({ lanes: { mentions: false, direct: false, spaces: false, recent: false } }), 'nothing (every lane is off)')
  // Alerts on but no bots: there is no such lane, so it is not named.
  assert.doesNotMatch(line({ lanes: { spaces: false } }), /alerts/)
  assert.ok(feed.scopeLine({ lanes: {}, alertBots: [], recentDays: 2, maxRecent: 10 }).length <= 120)
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

async function settle(b) {
  for (let i = 0; i < 5; i++) {
    await b.h.S.polling
    await b.h.S.classifying
    await new Promise((r) => setTimeout(r, 2))
  }
}

async function signedIn(opts) {
  const b = boot(opts)
  await b.h.ready
  await b.ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  await b.ctx.sendPanel({ type: 'signIn' })
  await until(() => b.h.S.state && b.h.S.state.lastPoll)
  await settle(b)
  return b
}

const events = (b, ...names) => b.ctx.emitted.filter((e) => e.name === 'inbox-feed' && (!names.length || names.includes(e.event)))
const svcOf = (b) => b.ctx.provided['inbox-feed']

test('provides inbox-feed v2 with the contract methods and describes itself with its scope', async () => {
  const { ctx, h } = boot({ project: { lanes: { spaces: false } } })
  const svc = ctx.provided['inbox-feed']
  assert.deepEqual(Object.keys(svc).sort(), ['act', 'describe', 'features', 'snapshot'])
  assert.deepEqual(await svc.describe(), { label: 'Chat', badge: 'CHAT', color: 'green', kind: 'chat', scope: 'unread mentions, direct messages and alerts + read of the last 2 days (newest 10)' })
  assert.deepEqual(await svc.features(), [])
  await h.stop()
})

test('snapshot, signed in: every lane and the Recent lane from the cache, no Google call, plain data', async () => {
  const b = await signedIn()
  const before = b.google.calls.length
  const r = await svcOf(b).snapshot()
  assert.equal(b.google.calls.length, before, 'snapshot never calls Google')
  assert.equal(r.state, 'ok')
  assert.equal(r.message, undefined)
  assert.ok(r.asOf > 0)
  assert.deepEqual(r, structuredClone(r))
  const by = Object.fromEntries(r.items.map((i) => [i.id, i]))
  assert.deepEqual(Object.keys(by).sort(), [S.dm, T1, T2, T3, S.alerts, S.random].sort())
  // Unread: the DM, the mention thread, the lunch thread (a Spaces row) and the alert conversation.
  assert.equal(by[S.dm].read, false)
  assert.equal(by[S.dm].to, 'direct')
  assert.equal(by[S.dm].place.kind, 'channel')
  assert.equal(by[T1].mentionsMe, true)
  assert.equal(by[T1].to, 'group')
  assert.equal(by[T1].place.name, 'Acme Team')
  assert.match(by[T1].rev, /T1R1$/)
  assert.deepEqual(by[T1].actions.map((a) => a.id), ['open', 'markRead'])
  assert.equal(by[T2].read, false)
  assert.deepEqual(by[S.alerts].labels, ['alert', 'alert:HighCPU'])
  assert.equal(by[S.alerts].read, false)
  // Read, in Recent: a flat space can be marked unread; a thread reply cannot (open only).
  assert.equal(by[S.random].read, true)
  assert.deepEqual(by[S.random].actions.map((a) => a.id), ['open', 'markUnread'])
  assert.equal(by[T3].read, true)
  assert.deepEqual(by[T3].actions.map((a) => a.id), ['open'])
  // Newest first.
  assert.deepEqual(r.items.map((i) => i.time), [...r.items.map((i) => i.time)].sort((a, c) => c - a))
  for (const it of r.items) for (const k of Object.keys(it)) assert.ok(['id', 'rev', 'title', 'preview', 'time', 'from', 'to', 'mentionsMe', 'read', 'place', 'labels', 'actions'].includes(k), k)
  await b.h.stop()
})

test('snapshot: hidden lanes and a hidden Recent lane leave their conversations out', async () => {
  const b = await signedIn({ project: { lanes: { recent: false, spaces: false, alerts: false } } })
  const ids = (await svcOf(b).snapshot()).items.map((i) => i.id)
  assert.equal(ids.includes(S.random), false)
  assert.equal(ids.includes(T3), false)
  assert.equal(ids.includes(T2), false, 'the Spaces lane is off')
  assert.ok(ids.includes(S.dm))
  assert.ok(ids.includes(T1))
  await b.h.stop()
})

test('snapshot, not signed in: state signedOut with a message and no items; a hostile app (too old) says error', async () => {
  const { ctx, h, google } = boot()
  await h.ready
  const r = await ctx.provided['inbox-feed'].snapshot()
  assert.equal(r.state, 'signedOut')
  assert.equal(typeof r.message, 'string')
  assert.deepEqual(r.items, [])
  assert.equal(google.calls.length, 0)
  await h.stop()
  const old = fakeCtx({ old: true, triage: fakeTriage() })
  const h2 = host._start(old, { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} })
  const r2 = await old.provided['inbox-feed'].snapshot()
  assert.equal(r2.state, 'error')
  assert.match(r2.message, /needs cc-cockpit/)
  await h2.stop()
})

test('snapshot, signed out after a poll: the last items come with signedOut; a failed poll gives error with them', async () => {
  const b = await signedIn()
  b.h.S.error = 'Google Chat is busy'
  const e = await svcOf(b).snapshot()
  assert.equal(e.state, 'error')
  assert.match(e.message, /busy/)
  assert.ok(e.items.length > 0)
  b.h.S.error = null
  await b.ctx.sendPanel({ type: 'signOut' })
  const r = await svcOf(b).snapshot()
  assert.equal(r.state, 'signedOut')
  assert.ok(r.items.length > 0, 'the last items come with signedOut')
  await b.h.stop()
})

test('act refuses a foreign id, a bad argument and an action the item lacks; nothing reaches Google', async () => {
  const b = await signedIn()
  const svc = svcOf(b)
  for (const [id, action] of [[undefined, 'open'], [7, 'open'], [S.dm, undefined], [S.dm, {}], ['', 'open'], ['nope', 'open'], ['alert:HighCPU', 'open'], ['spaces/ZZZ', 'open'], [`${S.team}/threads/NOPE`, 'markRead'], ['__proto__', 'open']]) {
    const r = await svc.act(id, action)
    assert.equal(r.ok, false, String(id))
    assert.match(r.message, /^chat: /)
    assert.ok(r.message.length <= 300)
  }
  // The action must be one of that item's: a read item has no markRead, an unread one no markUnread, a thread reply neither.
  assert.equal((await svc.act(S.dm, 'markUnread')).ok, false)
  assert.equal((await svc.act(S.random, 'markRead')).ok, false)
  assert.equal((await svc.act(T3, 'markUnread')).ok, false)
  assert.equal((await svc.act(S.dm, 'done')).ok, false)
  assert.match((await svc.act(S.dm, 'x'.repeat(500))).message, /no action/)
  assert.deepEqual(b.google.writes, [])
  await b.h.stop()
})

test('act markRead and markUnread: the panel\'s write path, one read-state write each, the item flips', async () => {
  const b = await signedIn()
  const svc = svcOf(b)
  assert.deepEqual(await svc.act(S.dm, 'markRead'), { ok: true })
  assert.equal(b.google.writes.length, 1)
  await settle(b)
  const dm = () => svc.snapshot().then((r) => r.items.find((i) => i.id === S.dm))
  assert.equal((await dm()).read, true)
  assert.deepEqual((await dm()).actions.map((a) => a.id), ['open', 'markUnread'])
  assert.deepEqual(await svc.act(S.dm, 'markUnread'), { ok: true })
  assert.equal(b.google.writes.length, 2)
  await settle(b)
  assert.equal((await dm()).read, false)
  await b.h.stop()
})

test('act markRead on a conversation of an alert group works: it is its own item', async () => {
  const b = await signedIn()
  assert.deepEqual(await svcOf(b).act(S.alerts, 'markRead'), { ok: true })
  assert.equal(b.google.writes.length, 1)
  await b.h.stop()
})

test('act: a Google refusal comes back as { ok: false, message } and the item stays unread', async () => {
  const fail = new Proxy({}, { get: (_, k) => (typeof k === 'string' && k.startsWith('patch:') ? 500 : undefined) })
  const b = await signedIn({ google: { fail } })
  const r = await svcOf(b).act(S.dm, 'markRead')
  assert.equal(r.ok, false)
  assert.match(r.message, /^chat: .*Could not mark/)
  assert.equal((await svcOf(b).snapshot()).items.find((i) => i.id === S.dm).read, false)
  await b.h.stop()
})

test('act open: the conversation goes to the reviewer the way a row click does, and marks nothing read', async () => {
  const reviewer = fakeReviewer()
  const b = await signedIn({ reviewer })
  const svc = svcOf(b)
  for (const [n, id] of [T1, S.random, T3, S.alerts].entries()) {
    assert.deepEqual(await svc.act(id, 'open'), { ok: true }, id)
    // A reviewer without prepare: nothing is on screen before the annotate, so act answers after it.
    await until(() => reviewer.calls.length === n + 1)
  }
  assert.deepEqual(b.google.writes, [])
  assert.equal(Object.keys(b.h.S.marks).length, 0)
  await b.h.stop()
})

test('act open settles once the reader is up, not when the person closes it (no reviewer)', async () => {
  const b = await signedIn()
  // Our own reader page stays open (its result never settles), as it does until the person closes it.
  const start = b.ctx.overlay.start
  b.ctx.overlay.start = (spec) => ({ ...start(spec), result: new Promise(() => {}) })
  const before = b.ctx.overlays.length
  const late = new Promise((r) => setTimeout(() => r('late'), 1000))
  assert.deepEqual(await Promise.race([svcOf(b).act(S.dm, 'open'), late]), { ok: true })
  assert.ok(b.ctx.overlays.length > before)
  await b.h.stop()
})

// Round-2 review: act answered ok before anything was on screen, so a failed read went only to this
// panel's notice and Inbox ended the item's "back" mark for an open the person never saw.
test('act open with nothing on screen yet (a reviewer without prepare, or a prepare that failed): a failed read is the act\'s refusal', async () => {
  const reviewers = {
    'no prepare': fakeReviewer(),
    'prepare failed': Object.assign(fakeReviewer(), {
      prepare: async () => {
        throw new Error('reviewer: the review overlay did not open: overlay: at most 3 open')
      },
      cancel: async () => ({ closed: false }),
    }),
  }
  for (const [name, reviewer] of Object.entries(reviewers)) {
    let failing = false
    const routes = (u) => (failing && u.pathname === `/v1/${S.dm}/messages` ? json({ error: { code: 500, message: 'boom' } }, 500) : null)
    const b = await signedIn({ reviewer, google: { routes } })
    failing = true
    const r = await svcOf(b).act(S.dm, 'open')
    assert.equal(r.ok, false, name)
    assert.match(r.message, /^chat: Google Chat had a problem \(500\)/, name)
    assert.equal(reviewer.calls.length, 0, `${name}: nothing was annotated`)
    assert.equal(b.ctx.overlays.length, 0, `${name}: no reader page either`)
    // The same reviewer opens a conversation that can be read: ok once the reviewer's overlay is filled.
    failing = false
    assert.deepEqual(await svcOf(b).act(S.dm, 'open'), { ok: true }, name)
    assert.equal(reviewer.calls.length, 1, name)
    await b.h.stop()
  }
})

// Round-3 review: an open that ended without anything on screen (the reviewer refused the
// conversation, or the app refused the reader page) set the panel's notice and returned, and act
// still answered ok.
test('act open: a reviewer (without prepare) refusing the conversation is the act\'s refusal, with the notice\'s text', async () => {
  const reviewer = {
    calls: [],
    async annotate(a) {
      reviewer.calls.push(a)
      throw new Error('reviewer: the review overlay did not open: overlay: at most 3 open')
    },
  }
  const b = await signedIn({ reviewer })
  const r = await svcOf(b).act(S.dm, 'open')
  assert.equal(r.ok, false)
  assert.match(r.message, /^chat: The reviewer could not open the conversation: .*at most 3 open/)
  assert.equal(reviewer.calls.length, 2, 'html, then text')
  assert.equal(b.h.S.notice.kind, 'error', 'the panel says it too')
  assert.equal(b.ctx.overlays.length, 0)
  await b.h.stop()
})

test('act open: the app refusing our reader page is the act\'s refusal, with the notice\'s text', async () => {
  const b = await signedIn()
  b.ctx.overlay.start = () => {
    throw new Error('overlay: at most 3 open')
  }
  const r = await svcOf(b).act(S.dm, 'open')
  assert.equal(r.ok, false)
  assert.match(r.message, /^chat: Cannot open the reader: overlay: at most 3 open/)
  await b.h.stop()
})

// Round-4 review: main never throws from start(); its refusal (3 open, 10 a minute) rejects the
// handle's result a moment later, and act answered ok for a reader page that never opened. And
// markOnOpen ran after any annotate that resolved, also the { opened: false } of a closed loader.
test('act open: a reader page whose result rejects (main refused it) is the act\'s refusal, and nothing is marked read', async () => {
  const b = await signedIn({ project: { markReadOnOpen: true } })
  const start = b.ctx.overlay.start
  b.ctx.overlay.start = (spec) => {
    const h = start(spec)
    const result = Promise.reject(new Error('overlay: bronos.chat already has 3 overlays open'))
    result.catch(() => {})
    return { ...h, result }
  }
  const r = await svcOf(b).act(S.dm, 'open')
  assert.equal(r.ok, false)
  assert.match(r.message, /^chat: Cannot open the reader: overlay: bronos\.chat already has 3 overlays open/)
  await settle(b)
  assert.deepEqual(b.google.writes, [], 'a conversation never shown stays unread')
  await b.h.stop()
})

test('act open: the loader the person closed (annotate { opened: false }) marks nothing read; a shown one does', async () => {
  let answer = { opened: false }
  const reviewer = {
    calls: [],
    prepare: async () => ({ opened: true }),
    cancel: async () => ({ closed: false }),
    async annotate(a) {
      reviewer.calls.push(a)
      return answer
    },
  }
  const b = await signedIn({ reviewer, project: { markReadOnOpen: true } })
  // The prepared loader was up, so act answers ok; the person closed it while the conversation loaded.
  assert.deepEqual(await svcOf(b).act(S.dm, 'open'), { ok: true })
  await until(() => reviewer.calls.length === 1)
  await settle(b)
  assert.deepEqual(b.google.writes, [], 'a conversation never shown stays unread')
  answer = { opened: true }
  assert.deepEqual(await svcOf(b).act(S.dm, 'open'), { ok: true })
  await until(() => b.google.writes.length === 1)
  assert.deepEqual(b.google.writes.map((w) => w.space), [S.dm])
  await b.h.stop()
})

test('markReadOnOpen: our reader page closed before the conversation reached it marks nothing read', async () => {
  const b = await signedIn({ project: { markReadOnOpen: true } })
  // The fake page ends at once (dismissed): the person closed the loader during the read.
  await b.ctx.sendPanel({ type: 'open', id: S.dm })
  await settle(b)
  assert.ok(b.ctx.overlays.length >= 1)
  assert.deepEqual(b.google.writes, [])
  // A page that stays open gets the conversation: marked read.
  const start = b.ctx.overlay.start
  b.ctx.overlay.start = (spec) => ({ ...start(spec), result: new Promise(() => {}) })
  assert.deepEqual(await svcOf(b).act(S.dm, 'open'), { ok: true })
  await until(() => b.google.writes.length === 1)
  assert.deepEqual(b.google.writes.map((w) => w.space), [S.dm])
  await b.h.stop()
})

test('sync: after activate\'s first cached view (signed out here), carrying the state', async () => {
  const { ctx, h } = boot()
  await h.ready
  await until(() => events({ ctx }, 'sync').length)
  const [s] = events({ ctx }, 'sync')
  assert.equal(s.data.state, 'signedOut')
  assert.deepEqual(s.data.items, [])
  assert.equal(typeof s.data.message, 'string')
  assert.equal(events({ ctx }).length, 1, 'only the sync')
  await h.stop()
})

test('sync after a sign-in, then items after a poll: the new list is one sync, then only diffs', async () => {
  const b = await signedIn()
  const syncs = events(b, 'sync')
  assert.ok(syncs.length >= 1)
  assert.equal(syncs.at(-1).data.state, 'ok')
  // The sign-in is a sync (state ok, nothing known yet); the first poll's conversations follow as items.
  const told = new Set(events(b, 'item').map((e) => e.data.id))
  for (const id of [S.dm, T1, T2, T3, S.alerts, S.random]) assert.ok(told.has(id), id)
  const total = b.ctx.emitted.length
  await b.h.pollNow('test', true)
  assert.equal(b.ctx.emitted.length, total, 'a poll that changed nothing says nothing')
  await b.h.stop()
})

test('a mark emits an item with the new read state; a conversation leaving the scope is gone', async () => {
  const b = await signedIn()
  const n = b.ctx.emitted.length
  await b.ctx.sendPanel({ type: 'read', id: S.dm })
  await settle(b)
  const items = b.ctx.emitted.slice(n).filter((e) => e.event === 'item' && e.data.id === S.dm)
  assert.ok(items.length >= 1)
  assert.equal(items.at(-1).data.read, true)
  assert.deepEqual(items.at(-1).data.actions.map((a) => a.id), ['open', 'markUnread'])
  // The Recent lane switched off: its conversations are gone at once.
  const m = b.ctx.emitted.length
  await b.ctx.changeSettings({ alertBots: ['Grafana'], lanes: { recent: false } })
  await settle(b)
  const gone = b.ctx.emitted.slice(m).filter((e) => e.event === 'gone').flatMap((e) => e.data.ids)
  assert.ok(gone.includes(S.random))
  assert.ok(gone.includes(T3))
  await b.h.stop()
})

test('an error is a sync with state error, a different message another sync, its recovery a sync with ok', async () => {
  const fail = {}
  const b = await signedIn({ google: { fail } })
  const syncs = () => events(b, 'sync')
  const n0 = syncs().length
  fail.spaces = 404
  await b.h.pollNow('x', true)
  assert.equal(syncs().length, n0 + 1)
  const a = syncs().at(-1).data
  assert.equal(a.state, 'error')
  assert.ok(a.message.length > 0 && a.message.length <= 300)
  assert.ok(a.items.length > 0, 'the last known list comes with the error')
  // The same error again: nothing new to say.
  await b.h.pollNow('x', true)
  assert.equal(syncs().length, n0 + 1)
  // Error A -> error B (the message changes, the kind does not): Inbox hears it.
  fail.spaces = 400
  await b.h.pollNow('x', true)
  const last = syncs().at(-1).data
  assert.equal(last.state, 'error')
  assert.notEqual(last.message, a.message)
  const n1 = syncs().length
  assert.ok(n1 >= n0 + 2)
  // Recovery.
  delete fail.spaces
  await b.h.pollNow('x', true)
  assert.equal(syncs().length, n1 + 1)
  assert.equal(syncs().at(-1).data.state, 'ok')
  assert.equal(syncs().at(-1).data.message, undefined)
  await b.h.stop()
})

test('a sign-out is a sync with signedOut and the last items; a new sign-in a sync with ok', async () => {
  const b = await signedIn()
  await b.ctx.sendPanel({ type: 'signOut' })
  const out = events(b, 'sync').at(-1).data
  assert.equal(out.state, 'signedOut')
  assert.ok(out.items.length > 0)
  await b.ctx.sendPanel({ type: 'signIn' })
  await until(() => events(b, 'sync').at(-1).data.state === 'ok')
  await settle(b)
  assert.ok((await svcOf(b).snapshot()).items.length >= 5)
  const told = new Set(events(b, 'item').map((e) => e.data.id))
  assert.ok(told.has(S.dm))
  await b.h.stop()
})

test('an app before 0.9.7 (services has no useAll, emit may be missing): still activates and provides; a throwing emit is harmless', async () => {
  const reg = tokens()
  const ctx = fakeCtx({ oauth: fakeOAuth(reg), triage: fakeTriage() })
  assert.equal('useAll' in ctx.services, false)
  const mod = require('../dist/host')
  mod.activate(ctx)
  assert.deepEqual(Object.keys(ctx.provided), ['inbox-feed'])
  assert.equal((await ctx.provided['inbox-feed'].snapshot()).state, 'signedOut')
  await mod.deactivate()

  const noEmit = fakeCtx({ oauth: fakeOAuth(tokens()), triage: fakeTriage() })
  delete noEmit.services.emit
  const h = host._start(noEmit, { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} })
  await h.ready
  assert.equal((await noEmit.provided['inbox-feed'].snapshot()).state, 'signedOut')
  await h.stop()

  const throwing = fakeCtx({ oauth: fakeOAuth(tokens()), triage: fakeTriage() })
  throwing.services.emit = () => {
    throw new Error('no listener')
  }
  const h2 = host._start(throwing, { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} })
  await h2.ready
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(throwing.logs.some((l) => /inbox-feed sync/.test(JSON.stringify(l))))
  await h2.stop()
})

test('the panel state carries the scope line Inbox sees, for the footer', async () => {
  const b = await signedIn({ project: { lanes: { spaces: false } } })
  assert.equal(b.ctx.lastState().scope, 'unread mentions, direct messages and alerts + read of the last 2 days (newest 10)')
  assert.equal(b.ctx.lastState().scope, (await svcOf(b).describe()).scope)
  await b.h.stop()
})
