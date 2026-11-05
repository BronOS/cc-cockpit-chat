'use strict'
// The host end to end with a fake ctx, a fake Google sign-in and a fake Google: setup, sign-in, the
// account check, polling, triage, the marks (optimistic, rollback, mark read on open), the reviewer
// and its fallbacks, the CLI, and the rule that no token or secret ever reaches a panel message, a
// log line or the CLI output.
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const { refreshKey } = require('../dist/lib/auth')
const T = require('../dist/lib/time')
const { fakeGoogle, fakeOAuth, fakeCtx, fakeTriage, fakeReviewer, tokens, fixture, ago, NOW, U, S, CLIENT_ID, CLIENT_SECRET } = require('./fakes')

const CLIENT_FILE = JSON.stringify(fixture('client_secret.json'))

function boot(opts = {}) {
  const reg = tokens()
  const google = fakeGoogle({ tokens: reg, ...(opts.google || {}) })
  const oauth = fakeOAuth(reg, opts.oauthOpts)
  const ctx = fakeCtx({
    project: opts.project === undefined ? { alertBots: ['Grafana'] } : opts.project,
    oauth,
    triage: opts.triage === undefined ? fakeTriage() : opts.triage,
    reviewer: opts.reviewer,
    sessions: opts.sessions,
    overlayAnswer: opts.overlayAnswer,
    buttons: !opts.noButtons,
    storage: opts.storage,
    secrets: opts.secrets,
    dataDir: opts.dataDir,
    old: opts.old,
  })
  let clock = NOW
  const h = host._start(ctx, { setInterval: () => 0, clearInterval: () => {}, fetch: google.fetch, now: () => clock, setTimeout: () => 0, clearTimeout: () => {}, cliWaitMs: 3000, imageWaitMs: opts.imageWaitMs })
  return { google, oauth, ctx, h, reg, tick: (ms) => (clock += ms) }
}

/** Boot, paste the client, sign in, wait for the first poll and triage. */
async function signedIn(opts = {}) {
  const b = boot(opts)
  await b.h.ready
  await b.ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  await b.ctx.sendPanel({ type: 'signIn' })
  await until(() => (b.h.S.state && b.h.S.state.lastPoll) || b.h.S.blocked)
  await settle(b)
  return b
}

async function settle(b) {
  for (let i = 0; i < 5; i++) {
    await b.h.S.polling
    await b.h.S.classifying
    await new Promise((r) => setTimeout(r, 2))
  }
}

async function until(fn, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const lane = (st, id) => st.lanes.find((l) => l.id === id)
const row = (st, id) => st.lanes.flatMap((l) => l.rows).find((r) => r.id === id)
const tab = (tabId, status, extra = {}) => ({ tabId, status, cwd: `/p/${tabId}`, notes: [], files: [], ...extra })
const T1 = `${S.team}/threads/T1`
const T3 = `${S.team}/threads/T3`

/** Every string the plugin let out: panel posts, headers, logs. */
function everythingSaid(ctx) {
  return JSON.stringify([ctx.posts, ctx.headers, ctx.logs, ctx.overlays.map((o) => o.posts)])
}

test('not configured: the setup guide, no request to Google, status says what to do', async () => {
  const { ctx, h, google, oauth } = boot()
  await h.ready
  await ctx.sendPanel({ type: 'hello' })
  const st = ctx.lastState()
  assert.equal(st.auth.signedIn, false)
  assert.equal(st.auth.client, null)
  assert.ok(st.steps.length >= 6)
  assert.ok(st.steps.some((s) => s.links.some((l) => l.id === 'chatConfig')))
  await h.pollNow('test')
  assert.equal(google.calls.length, 0)
  assert.equal(oauth.authorizes.length, 0)
  const r = await ctx.runCli(['status'])
  assert.match(r.stdout, /client +\(none\)/)
  assert.match(r.stdout, /ccc chat client <file.json>/)
  assert.equal(ctx.schedules[0].seconds, 120)
  assert.equal(ctx.cliName, 'chat')
  await h.stop()
})

test('a setup link opens the fixed console URL with ctx.openExternal; an unknown id opens nothing', async () => {
  const { ctx, h } = boot()
  await ctx.sendPanel({ type: 'link', id: 'chatApi' })
  await ctx.sendPanel({ type: 'link', id: 'https://evil.example' })
  await ctx.sendPanel({ type: 'link', id: 'constructor' })
  assert.deepEqual(ctx.external, ['https://console.cloud.google.com/apis/library/chat.googleapis.com'])
  await h.stop()
})

test('an older app (no ctx.oauth, secrets, header, openExternal): the panel and the CLI say so, nothing runs', async () => {
  const { ctx, h, google } = boot({ old: true })
  await ctx.sendPanel({ type: 'hello' })
  assert.match(ctx.lastState().tooOld, /needs cc-cockpit 0\.9\.2 or later/)
  assert.match(ctx.lastState().tooOld, /ctx\.oauth, ctx\.secrets, ctx\.panels\.header, ctx\.openExternal/)
  assert.equal(ctx.schedules.length, 0)
  assert.match((await ctx.runCli(['status'])).stdout, /needs cc-cockpit 0\.9\.2/)
  assert.match((await ctx.runCli(['login'])).stderr, /needs cc-cockpit 0\.9\.2/)
  assert.equal(google.calls.length, 0)
  await h.stop()
})

test('pasting the client file: kept in this project\'s storage, never in a post; a bad one refused', async () => {
  const { ctx, h } = boot()
  await ctx.sendPanel({ type: 'client', text: JSON.stringify(fixture('client-web.json')) })
  assert.match(ctx.lastState().clientError, /Web application.*Desktop app/)
  await ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  const st = ctx.lastState()
  assert.equal(st.auth.client.source, 'pasted')
  assert.equal(st.clientError, null)
  assert.match(st.notice.text, /Client saved .*Next: Sign in with Google/)
  assert.deepEqual(await ctx.storage.get('client'), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  assert.ok(!everythingSaid(ctx).includes(CLIENT_SECRET))
  await h.stop()
})

test('sign in: our scopes, offline access, the refresh token per project and client, then the account check and the first poll', async () => {
  const { ctx, h, oauth, google } = await signedIn()
  const spec = oauth.authorizes[0]
  assert.equal(spec.authUrl, 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent')
  assert.deepEqual(spec.scopes, ['https://www.googleapis.com/auth/chat.spaces.readonly', 'https://www.googleapis.com/auth/chat.messages.readonly', 'https://www.googleapis.com/auth/chat.users.readstate', 'https://www.googleapis.com/auth/directory.readonly', 'openid', 'email'])
  const pk = await ctx.storage.get('projectKey')
  assert.equal(await ctx.secrets.get(refreshKey(pk, CLIENT_ID)), '1//refresh-1')
  assert.equal(google.calls[0].path, '/tokeninfo', 'who and what was granted, first')
  const st = ctx.lastState()
  assert.equal(st.auth.signedIn, true)
  assert.equal(st.blocked, null)
  assert.equal(st.account, 'me@example.com')
  assert.deepEqual(st.lanes.map((l) => l.id), ['mentions', 'direct', 'spaces', 'alerts', 'recent'])
  assert.equal(lane(st, 'mentions').rows[0].id, T1)
  assert.equal(st.unread, 2)
  assert.equal(ctx.badges.at(-1), 2)
  assert.match(st.notice.text, /Signed in as me@example.com/)
  assert.match(ctx.headers.at(-1).meta, /just now · me@example.com/)
  assert.deepEqual((await ctx.storage.get('signedIn')).grant, { missing: [], email: 'me@example.com', sub: '1001' })
  await h.stop()
})

test('a personal Google account: signed in, but blocked with the Workspace message; nothing polled', async () => {
  const { ctx, h, google } = await signedIn({ google: { email: 'someone@gmail.com' } })
  const st = ctx.lastState()
  assert.match(st.blocked, /only with Google Workspace/)
  assert.deepEqual(st.lanes, [])
  assert.ok(!google.calls.some((c) => c.path === '/v1/spaces'))
  assert.match((await ctx.runCli(['list'])).stderr, /only with Google Workspace/)
  assert.match((await ctx.runCli(['status'])).stdout, /blocked +Google Chat's API works only/)
  await h.stop()
})

test('Google answering the Workspace 403 itself: blocked the same way', async () => {
  const { ctx, h } = await signedIn({ google: { fail: { spaces: { status: 403, body: { error: { code: 403, message: 'Google Chat API is only available to Google Workspace users.' } } } } } })
  assert.match(ctx.lastState().blocked, /only with Google Workspace/)
  assert.equal(ctx.lastState().error, null)
  await h.stop()
})

test('a sign-in without the read-state scope: blocked, the box named; without directory: a note only', async () => {
  const G = 'https://www.googleapis.com/auth/'
  const a = await signedIn({ google: { scope: `${G}chat.spaces.readonly ${G}chat.messages.readonly ${G}directory.readonly openid` } })
  assert.match(a.ctx.lastState().blocked, /lacks chat\.users\.readstate/)
  assert.match((await a.ctx.runCli(['status'])).stdout, /scopes +missing chat\.users\.readstate/)
  await a.h.stop()
  const b = await signedIn({ google: { scope: `${G}chat.spaces.readonly ${G}chat.messages.readonly ${G}chat.users.readstate openid` } })
  const st = b.ctx.lastState()
  assert.equal(st.blocked, null)
  assert.ok(st.lanes.length)
  assert.ok(st.notes.some((n) => /directory\.readonly/.test(n)))
  await b.h.stop()
})

test('triage: every shown row classified under source chat, verdicts in the rows, kept per account', async () => {
  const triage = fakeTriage()
  const { ctx, h } = await signedIn({ triage })
  assert.ok(triage.calls.length >= 1)
  assert.ok(triage.calls.every((c) => c.source === 'chat'))
  const items = Object.fromEntries(triage.calls.flatMap((c) => c.items).map((i) => [i.id, i]))
  assert.equal(items[T1].floor, 'action')
  assert.deepEqual(items['alert:HighCPU'].hint, { priority: 'noise' })
  const st = ctx.lastState()
  assert.equal(row(st, 'alert:HighCPU').verdict.priority, 'noise')
  assert.equal(row(st, S.dm).verdict.priority, 'action')
  const saved = await ctx.storage.get('triage')
  assert.equal(saved.account, 'me@example.com')
  // A second poll with nothing new asks triage for nothing.
  const n = triage.calls.length
  await h.pollNow('again', true)
  await settle({ h })
  assert.equal(triage.calls.length, n)
  await h.stop()
})

test('triage off: lanes unsorted, the panel says how to turn it on', async () => {
  const { ctx, h } = await signedIn({ triage: null })
  const st = ctx.lastState()
  assert.equal(st.triage.on, false)
  assert.ok(st.lanes.length)
  assert.match((await ctx.runCli(['status'])).stdout, /triage +off/)
  await h.stop()
})

test('Mark read: one PATCH to the newest message of others, the row in Recent, then the poll confirms it', async () => {
  const { ctx, h, google } = await signedIn()
  await ctx.sendPanel({ type: 'read', id: S.dm })
  await settle({ h })
  assert.deepEqual(google.writes, [{ space: S.dm, lastReadTime: T.normalise(ago(20)), updateMask: 'lastReadTime' }])
  const st = ctx.lastState()
  assert.deepEqual(lane(st, 'direct').rows, [])
  assert.equal(row(st, S.dm).lane, 'recent')
  assert.equal(row(st, S.dm).unread, false)
  assert.equal(row(st, S.dm).canUnread, true)
  assert.match(st.notice.text, /Marked "Ann Example" read in Google Chat/)
  assert.equal(ctx.badges.at(-1), 1)
  assert.deepEqual(h.S.marks, {}, 'the poll after the write replaced the guess with Chat\'s state')
  await h.stop()
})

test('Mark read shows before Chat answers: pending while the PATCH is on its way', async () => {
  let release
  const hold = new Promise((r) => (release = r))
  const b = await signedIn({ google: { routes: async (u, init) => (init.method === 'PATCH' ? (await hold, null) : null) } })
  const p = b.ctx.sendPanel({ type: 'read', id: S.dm })
  await until(() => b.h.S.marks[S.dm])
  const st = b.ctx.lastState()
  assert.equal(row(st, S.dm).pending, true)
  assert.equal(row(st, S.dm).unread, false)
  assert.deepEqual(lane(st, 'direct').rows, [])
  release()
  await p
  await settle(b)
  assert.equal(row(b.ctx.lastState(), S.dm).pending, false)
  await b.h.stop()
})

test('a failed mark rolls back with a notice; nothing else changes', async () => {
  const { ctx, h, google } = await signedIn({ google: { fail: { [`patch:${S.dm}`]: { status: 404, body: { error: { code: 404, message: 'Google Chat app not found.' } } } } } })
  await ctx.sendPanel({ type: 'read', id: S.dm })
  const st = ctx.lastState()
  assert.deepEqual(lane(st, 'direct').rows.map((r) => r.id), [S.dm], 'back in its lane')
  assert.equal(row(st, S.dm).unread, true)
  assert.equal(row(st, S.dm).pending, false)
  assert.equal(st.notice.kind, 'error')
  assert.match(st.notice.text, /^Could not mark "Ann Example" read in Google Chat: .*Chat app configured.*It is shown as before\.$/)
  assert.deepEqual(google.writes, [])
  assert.deepEqual(h.S.marks, {})
  await h.stop()
})

test('Mark unread: one microsecond before the newest message of others; an alert cannot; a thread reply with no target says why', async () => {
  const { ctx, h, google } = await signedIn()
  const r = await ctx.runCli(['unread', S.random])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /Marked "Acme Random" unread in Google Chat/)
  assert.equal(google.writes[0].lastReadTime, T.justBefore(T.normalise(ago(300))))
  await settle({ h })
  assert.ok(lane(ctx.lastState(), 'spaces').rows.some((x) => x.id === S.random))
  const alert = await ctx.runCli(['unread', 'alert:HighCPU'])
  assert.match(alert.stdout + alert.stderr, /unread (already|by nature)/)
  const t3 = await ctx.runCli(['unread', T3])
  assert.equal(t3.code, 1)
  assert.match(t3.stderr, /cannot change this thread's read state/)
  assert.equal(row(ctx.lastState(), T3).noTarget, true)
  await h.stop()
})

test('ccc chat read on an alert row: every space of the group moved to its newest alert', async () => {
  const { ctx, h, google } = await signedIn()
  const r = await ctx.runCli(['read', 'alert:HighCPU'])
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(google.writes.map((w) => w.space), [S.alerts])
  await settle({ h })
  assert.equal(lane(ctx.lastState(), 'alerts').rows.length, 0)
  assert.match((await ctx.runCli(['read', S.random])).stdout, /read already/)
  assert.match((await ctx.runCli(['read', 'spaces/NOPE'])).stderr, /not among the last poll/)
  assert.equal((await ctx.runCli(['read', 'https://chat.google.com/x'])).code, 2)
  await h.stop()
})

test('open: the reviewer gets clean HTML with the picture, the aside, no url; mark read on open follows', async () => {
  const reviewer = fakeReviewer()
  const { ctx, h, google } = await signedIn({ reviewer, sessions: [tab('t1', 'waiting', { active: true })], project: { markReadOnOpen: true } })
  await ctx.sendPanel({ type: 'open', id: S.dm })
  await settle({ h })
  const a = reviewer.calls[0]
  assert.equal(a.title, 'Ann Example')
  assert.equal(a.key, `chat:${S.dm}`)
  assert.equal(a.url, undefined, 'no link to Chat (answer 2)')
  assert.match(a.html, /<img data-asset="[a-z0-9]+" alt="deploy.png"/)
  assert.equal(a.assets.length, 1)
  assert.match(a.assets[0].dataUrl, /^data:image\/png;base64,/)
  assert.match(a.aside, /Direct message/)
  assert.ok(google.calls.some((c) => c.path === '/v1/media/RES-A1'))
  assert.deepEqual(google.writes.map((w) => w.space), [S.dm], 'markReadOnOpen')
  assert.equal(row(ctx.lastState(), S.dm).unread, false)
  await h.stop()
})

// Real-work feedback 8: the overlay came only after the conversation was read.
test('open with a reviewer that has prepare: the overlay is up before anything is read, then filled', async () => {
  const order = []
  const reviewer = fakeReviewer()
  reviewer.prepare = async (spec) => (order.push(['prepare', spec, reads()]), { opened: true })
  reviewer.cancel = async (spec) => (order.push(['cancel', spec.key]), { closed: false })
  const annotate = reviewer.annotate
  reviewer.annotate = async (a) => (order.push(['annotate', a.key]), annotate(a))
  const { ctx, h, google } = await signedIn({ reviewer, sessions: [tab('t1', 'waiting', { active: true })] })
  const reads = () => google.calls.filter((c) => /messages|media/.test(c.path)).length
  const before = reads()
  await ctx.sendPanel({ type: 'open', id: S.dm })
  await settle({ h })
  assert.deepEqual(order[0], ['prepare', { key: `chat:${S.dm}`, title: 'Ann Example', type: { name: 'inbox-item', data: { source: 'bronos.chat', id: S.dm } } }, before])
  assert.ok(reads() > before, 'the open read the conversation, after prepare')
  assert.deepEqual(order.slice(1), [['annotate', `chat:${S.dm}`], ['cancel', `chat:${S.dm}`]])
  await h.stop()
})

test('open with prepare: an open that fails cancels the loading overlay', async () => {
  const calls = []
  const reviewer = {
    prepare: async (spec) => (calls.push(['prepare', spec.key]), { opened: true }),
    cancel: async (spec) => (calls.push(['cancel', spec.key]), { closed: true }),
    annotate: async () => {
      throw new Error('reviewer: the review overlay did not open: overlay: at most 3 open')
    },
  }
  const { ctx, h } = await signedIn({ reviewer, sessions: [tab('t1', 'waiting', { active: true })] })
  await ctx.sendPanel({ type: 'open', id: S.dm })
  await settle({ h })
  assert.deepEqual(calls, [['prepare', `chat:${S.dm}`], ['cancel', `chat:${S.dm}`]])
  await h.stop()
})

test('markReadOnOpen off: opening marks nothing', async () => {
  const reviewer = fakeReviewer()
  const { ctx, h, google } = await signedIn({ reviewer, project: { alertBots: ['Grafana'], markReadOnOpen: false } })
  await ctx.sendPanel({ type: 'open', id: S.dm })
  await settle({ h })
  assert.equal(reviewer.calls.length, 1)
  assert.deepEqual(google.writes, [])
  assert.equal(row(ctx.lastState(), S.dm).unread, true)
  await h.stop()
})

test('a reviewer that takes text only: the html refused once, then text for the run', async () => {
  const reviewer = fakeReviewer({ refuseHtml: true })
  const { ctx, h } = await signedIn({ reviewer })
  await ctx.sendPanel({ type: 'open', id: T1 })
  await settle({ h })
  assert.equal(reviewer.calls.length, 2)
  assert.match(reviewer.calls[1].text, /Release plan for Friday @you please check/)
  await ctx.sendPanel({ type: 'open', id: S.random })
  assert.equal(reviewer.calls.length, 3, 'no html try the second time')
  assert.match((await ctx.runCli(['status'])).stdout, /text only/)
  await h.stop()
})

test('no reviewer: the plugin\'s own reader page, in parts, with only links from the document opened', async () => {
  const { ctx, h } = await signedIn({ reviewer: null, overlayAnswer: { kind: 'dismissed' } })
  await ctx.sendPanel({ type: 'open', id: S.dm })
  const o = ctx.overlays[0]
  assert.equal(o.spec.file, 'panels/thread.html')
  assert.equal(o.posts[0].type, 'doc')
  assert.ok(o.posts.some((p) => p.type === 'html' && /deploy/.test(p.part)))
  assert.ok(o.posts.some((p) => p.type === 'asset'))
  o.send({ open: 'https://status.example.com/run/42' })
  o.send({ open: 'https://evil.example/' })
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(ctx.external, ['https://status.example.com/run/42'])
  await h.stop()
})

test('Discuss: the conversation as text to the active waiting tab; two candidates ask which; New opens a tab', async () => {
  const one = await signedIn({ reviewer: fakeReviewer(), sessions: [tab('t1', 'waiting', { active: true })] })
  await one.ctx.sendPanel({ type: 'discuss', id: T1 })
  assert.equal(one.ctx.sent[0].tabId, 't1')
  assert.match(one.ctx.sent[0].text, /^About the Google Chat conversation "Release plan for Friday @you please check" in Acme Team/)
  assert.match(one.ctx.sent[0].text, /Cat Example/)
  assert.deepEqual(one.google.writes, [], 'Discuss marks nothing')
  await one.ctx.sendPanel({ type: 'newSession', id: S.dm })
  assert.match(one.ctx.opened[0].prompt, /^About the Google Chat conversation "Ann Example"/)
  assert.equal(one.ctx.opened[0].focus, true, 'the new tab is shown')
  await one.h.stop()
  const two = await signedIn({ sessions: [tab('t1', 'waiting'), tab('t2', 'waiting')] })
  await two.ctx.sendPanel({ type: 'discuss', id: S.dm })
  assert.equal(two.ctx.lastState().choose.tabs.length, 2)
  await two.ctx.sendPanel({ type: 'discuss', id: S.dm, tabId: 't2' })
  assert.equal(two.ctx.sent[0].tabId, 't2')
  await two.h.stop()
})

test('Wrong? sets and undoes an override through triage', async () => {
  const triage = fakeTriage()
  const { ctx, h } = await signedIn({ triage })
  await ctx.sendPanel({ type: 'wrong', id: S.dm, priority: 'urgent' })
  assert.equal(row(ctx.lastState(), S.dm).verdict.priority, 'urgent')
  assert.match(ctx.lastState().notice.text, /now urgent/)
  await ctx.sendPanel({ type: 'undoWrong', id: S.dm })
  assert.equal(row(ctx.lastState(), S.dm).verdict.priority, 'action')
  await ctx.sendPanel({ type: 'wrong', id: S.dm, priority: 'bogus' })
  assert.equal(Object.keys(triage.overrides).length, 0)
  await h.stop()
})

test('lanes: toggle and Show all kept in storage; rowsPerLane caps what is sent', async () => {
  const { ctx, h } = await signedIn({ project: { alertBots: ['Grafana'], rowsPerLane: 1 } })
  const recent = lane(ctx.lastState(), 'recent')
  assert.equal(recent.total, 2)
  assert.equal(recent.rows.length, 1)
  await ctx.sendPanel({ type: 'expand', lane: 'recent' })
  assert.equal(lane(ctx.lastState(), 'recent').rows.length, 2)
  await ctx.sendPanel({ type: 'toggle', lane: 'mentions' })
  assert.equal(lane(ctx.lastState(), 'mentions').collapsed, true)
  await ctx.sendPanel({ type: 'toggle', lane: '__proto__' })
  assert.deepEqual(await ctx.storage.get('ui'), { collapsed: { mentions: true }, expanded: { recent: true } })
  await h.stop()
})

test('Chat busy: the poll interval doubles (at most 30 min), then back to normal', async () => {
  const c = boot({ google: { fail: { spaces: 429 } } })
  await c.h.ready
  await c.ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  await c.ctx.sendPanel({ type: 'signIn' })
  await until(() => c.h.S.error)
  await settle(c)
  assert.equal(c.h.S.backoffMinutes, 4)
  assert.equal(c.ctx.schedules.at(-1).seconds, 240)
  assert.match(c.ctx.lastState().error, /rate limiting.*every 4 min for now/)
  await c.h.pollNow('again', true)
  assert.equal(c.h.S.backoffMinutes, 8)
  await c.h.stop()
})

test('invalid_grant: signed out with the reason, the lanes gone, no error notice on top', async () => {
  const b = await signedIn()
  b.h.auth.invalidate()
  b.oauth.invalidGrant = true
  await b.h.pollNow('test', true)
  const st = b.ctx.lastState()
  assert.equal(st.auth.signedIn, false)
  assert.match(st.auth.signedOutReason, /invalid_grant/)
  assert.equal(st.error, null)
  assert.deepEqual(st.lanes, [])
  await b.h.stop()
})

test('sign out: the refresh token, the lanes and the verdicts are gone', async () => {
  const { ctx, h } = await signedIn()
  const pk = await ctx.storage.get('projectKey')
  await ctx.sendPanel({ type: 'signOut' })
  assert.equal(await ctx.secrets.get(refreshKey(pk, CLIENT_ID)), null)
  const st = ctx.lastState()
  assert.equal(st.auth.signedIn, false)
  assert.deepEqual(st.lanes, [])
  assert.equal(st.account, '')
  assert.deepEqual((await ctx.storage.get('triage')).verdicts, {})
  await h.stop()
})

test('a restart: the lanes, names and verdicts come back from disk before any poll', async () => {
  const a = await signedIn()
  await a.h.stop()
  const b = boot({ storage: a.ctx.storage, secrets: a.ctx.secrets, dataDir: a.ctx.dataDir })
  await b.h.ready
  await b.ctx.sendPanel({ type: 'hello' })
  const st = b.ctx.lastState()
  assert.equal(st.auth.signedIn, true)
  assert.equal(row(st, S.dm).title, 'Ann Example')
  assert.equal(row(st, S.dm).verdict.priority, 'action')
  assert.equal(b.google.calls.length, 0)
  await b.h.stop()
})

test('the CLI: status, refresh, list, show; show marks nothing', async () => {
  const { ctx, h, google } = await signedIn()
  const st = await ctx.runCli(['status'])
  assert.match(st.stdout, /account +me@example.com/)
  assert.match(st.stdout, /user id +users\/1001\n/)
  assert.match(st.stdout, /scopes +all granted/)
  assert.match(st.stdout, /lanes +Mentions 1 · Direct messages 1 · Spaces 1 · Alerts 1 · Recent 2/)
  assert.match(st.stdout, /marks +Mark read \/ unread only \(markReadOnOpen is off\)/)
  const r = await ctx.runCli(['refresh'])
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /Mentions 1/)
  const list = await ctx.runCli(['list', 'mentions'])
  assert.match(list.stdout, /Mentions \(1\)\n {2}\* A spaces\/TEAM\/threads\/T1/)
  assert.equal((await ctx.runCli(['list', 'nope'])).code, 2)
  const show = await ctx.runCli(['show', T1])
  assert.match(show.stdout, /Release plan for Friday @you please check/)
  assert.match(show.stdout, /\[unread\] Cat Example/)
  assert.deepEqual(google.writes, [])
  const help = await ctx.runCli(['help'])
  assert.match(help.stdout, /ccc chat read <id>/)
  await h.stop()
})

test('no token, refresh token or client secret in any post, header, log, overlay or CLI output', async () => {
  const { ctx, h, reg } = await signedIn({ reviewer: null })
  await ctx.sendPanel({ type: 'open', id: S.dm })
  await ctx.sendPanel({ type: 'read', id: T1 })
  const outs = []
  for (const argv of [['status'], ['list'], ['show', S.dm], ['refresh'], ['read', S.dm], ['unread', S.dm]]) outs.push(await ctx.runCli(argv))
  await settle({ h })
  const said = everythingSaid(ctx) + JSON.stringify(outs)
  assert.ok(!said.includes(CLIENT_SECRET))
  assert.ok(!/1\/\/refresh-/.test(said))
  for (const t of reg.valid) assert.ok(!said.includes(t), 'an access token')
  await h.stop()
})

test('requests go only to Chat, People and the token info; the token never in a URL', async () => {
  const { ctx, h, google } = await signedIn({ reviewer: fakeReviewer() })
  await ctx.sendPanel({ type: 'open', id: S.dm })
  await settle({ h })
  const origins = new Set(google.calls.map((c) => c.origin))
  for (const o of origins) assert.ok(['https://chat.googleapis.com', 'https://people.googleapis.com', 'https://oauth2.googleapis.com'].includes(o), o)
  for (const c of google.calls) {
    assert.equal(c.redirect, 'manual')
    assert.ok(!/ya29/.test(c.url))
  }
  assert.ok(google.calls.filter((c) => c.method === 'PATCH').every((c) => /\/spaceReadState$/.test(c.path)))
  await h.stop()
})

test('opening a thread with markReadOnOpen: its space moves to the thread\'s newest message', async () => {
  const reviewer = fakeReviewer()
  const { ctx, h, google } = await signedIn({ reviewer, project: { markReadOnOpen: true } })
  await ctx.sendPanel({ type: 'open', id: T1 })
  await settle({ h })
  assert.match(reviewer.calls[0].html, /<strong>@you<\/strong>/)
  assert.ok(google.calls.some((c) => c.path === '/v1/spaces/TEAM/messages' && /thread\.name/.test(c.url)))
  assert.deepEqual(google.writes, [{ space: S.team, lastReadTime: T.normalise(ago(25)), updateMask: 'lastReadTime' }])
  // Opening a read row marks nothing.
  await ctx.sendPanel({ type: 'open', id: S.random })
  await settle({ h })
  assert.equal(google.writes.length, 1)
  await h.stop()
})

test('a mark that finishes during a poll: one more poll right after', async () => {
  let release
  const hold = new Promise((r) => (release = r))
  let holding = false
  const b = await signedIn({ google: { routes: async (u) => (holding && u.pathname === '/v1/spaces' ? (await hold, null) : null) } })
  holding = true
  const polling = b.h.pollNow('test', true)
  await b.ctx.sendPanel({ type: 'read', id: S.dm })
  assert.equal(b.h.S.pollAgain, true)
  holding = false
  release()
  await polling
  await settle(b)
  assert.equal(b.h.S.pollAgain, false)
  assert.deepEqual(b.h.S.marks, {})
  assert.equal(row(b.ctx.lastState(), S.dm).unread, false)
  await b.h.stop()
})

test('another account on the same client: nothing of the last one carries over', async () => {
  const b = await signedIn()
  b.h.S.state.account = 'someone-else@example.com'
  b.h.S.accountChecked = false
  await b.h.pollNow('test', true)
  await settle(b)
  assert.equal(b.ctx.lastState().account, 'me@example.com')
  assert.ok(b.ctx.lastState().lanes.length, 'the new account polled at once')
  await b.h.stop()
})

test('a new client id in the settings signs out; the lanes go', async () => {
  const b = await signedIn({ project: { alertBots: ['Grafana'] } })
  await b.ctx.sendPanel({ type: 'removeClient' })
  assert.equal(b.ctx.lastState().auth.client, null)
  assert.equal(b.ctx.lastState().auth.signedIn, false)
  await b.ctx.changeSettings({ clientId: '555555555555-settingsclient.apps.googleusercontent.com', clientSecret: 'GOCSPX-settings-secret' })
  assert.equal(b.ctx.lastState().auth.client.source, 'settings')
  assert.equal(b.ctx.lastState().auth.signedIn, false)
  assert.deepEqual(b.ctx.lastState().lanes, [])
  await b.h.stop()
})

// ---- inbox-item overlay type, buttons and the early reader overlay ----

const itemInfo = (id, source = 'bronos.chat') => ({ type: { name: 'inbox-item', data: { source, id } }, title: 't', opener: 'bronos.chat' })

test('overlay buttons: only for our own items, labels follow state, run = act', async () => {
  const { ctx, h } = await signedIn()
  assert.equal(ctx.buttonProviders.length, 1)
  assert.equal(ctx.buttonProviders[0].name, 'inbox-item')
  const provider = ctx.buttonProviders[0].provider
  assert.deepEqual(await provider(itemInfo(S.dm, 'bronos.jira')), [])
  assert.deepEqual(await provider(itemInfo('not-a-conversation')), [])
  assert.deepEqual(await provider({ type: { name: 'inbox-item', data: null }, title: 't', opener: 'x' }), [])
  const before = await provider(itemInfo(S.dm))
  assert.deepEqual(before.map((b) => b.id), ['markRead'])
  assert.match(before[0].label, /read/i)
  await before[0].run(itemInfo(S.dm))
  await settle({ h })
  const after = await provider(itemInfo(S.dm))
  assert.deepEqual(after.map((b) => b.id), ['markUnread'])
  assert.notEqual(after[0].label, before[0].label)
  await h.stop()
})

test('overlay buttons: only on overlays we or the reviewer opened, whatever the data names', async () => {
  const { ctx, h } = await signedIn()
  const provider = ctx.buttonProviders[0].provider
  // `opener` is the app's record of who opened the overlay: another plugin naming our item, a type
  // data claiming to be ours, the CLI or core get no buttons that act on it.
  const by = (opener) => ({ type: { name: 'inbox-item', data: { source: 'bronos.chat', id: S.dm, opener: 'bronos.chat' } }, title: 't', opener })
  for (const foreign of ['evil.plugin', 'bronos.inbox', 'cli', 'core', '', undefined]) {
    assert.deepEqual(await provider(by(foreign)), [], `opener ${foreign}`)
  }
  assert.deepEqual(await provider({ type: by('x').type, title: 't' }), [])
  // Our own reader page and the reviewer we hand the item to (the project's pick) do.
  assert.equal((await provider(by('bronos.chat'))).length, 1)
  ctx.services.provider = (name) => (name === 'reviewer' ? 'cockpit.reviewer' : null)
  assert.equal((await provider(by('cockpit.reviewer'))).length, 1)
  await h.stop()
})

test('overlay buttons: the reviewer the project picked, asked at button time; the bundled one only when picked', async () => {
  const { ctx, h } = await signedIn()
  const provider = ctx.buttonProviders[0].provider
  const by = (opener) => ({ type: { name: 'inbox-item', data: { source: 'bronos.chat', id: S.dm, opener: 'bronos.chat' } }, title: 't', opener })
  let picked = 'other.reviewer'
  const asked = []
  ctx.services.provider = (name) => (asked.push(name), name === 'reviewer' ? picked : null)
  // A replacement reviewer the project picked gets the buttons; the bundled one, not picked, does not.
  assert.equal((await provider(by('other.reviewer'))).length, 1)
  assert.deepEqual(await provider(by('cockpit.reviewer')), [])
  assert.ok(asked.includes('reviewer'))
  // The pick changes while we run: the next overlay follows it.
  picked = 'cockpit.reviewer'
  assert.equal((await provider(by('cockpit.reviewer'))).length, 1)
  assert.deepEqual(await provider(by('other.reviewer')), [])
  // No reviewer reachable, or the app refusing the name: no reviewer is trusted, our own page still is.
  picked = null
  assert.deepEqual(await provider(by('cockpit.reviewer')), [])
  ctx.services.provider = () => {
    throw new Error('plugin bronos.chat does not declare service "reviewer" in services.uses')
  }
  assert.deepEqual(await provider(by('cockpit.reviewer')), [])
  assert.equal((await provider(by('bronos.chat'))).length, 1)
  await h.stop()
})

test('overlay buttons: an older app without ctx.services.provider trusts the bundled reviewer only', async () => {
  const { ctx, h } = await signedIn()
  const provider = ctx.buttonProviders[0].provider
  const by = (opener) => ({ type: { name: 'inbox-item', data: { source: 'bronos.chat', id: S.dm, opener: 'bronos.chat' } }, title: 't', opener })
  delete ctx.services.provider
  assert.equal((await provider(by('cockpit.reviewer'))).length, 1)
  assert.deepEqual(await provider(by('other.reviewer')), [])
  assert.equal((await provider(by('bronos.chat'))).length, 1)
  await h.stop()
})

test('overlay buttons: a ctx without the member still activates and opens a conversation', async () => {
  const { ctx, h } = await signedIn({ noButtons: true, reviewer: null })
  assert.equal(ctx.buttonProviders.length, 0)
  await ctx.sendPanel({ type: 'open', id: S.dm })
  assert.equal(ctx.overlays.length, 1)
  await h.stop()
})

test('overlay buttons: a failed Mark read shows in the notice and throws, not silent', async () => {
  const { ctx, h } = await signedIn({ google: { fail: { [`patch:${S.dm}`]: 500 } } })
  const provider = ctx.buttonProviders[0].provider
  const [button] = await provider(itemInfo(S.dm))
  assert.equal(button.id, 'markRead')
  await assert.rejects(button.run(itemInfo(S.dm)), /^Error: chat: /)
  assert.equal(ctx.lastState().notice.kind, 'error')
  assert.equal((await provider(itemInfo(S.dm)))[0].id, 'markRead', 'still unread')
  await h.stop()
})

test('own reader page: the overlay (type, ready manual) starts before the conversation is read; Discuss sends its text', async () => {
  const b = await signedIn({ reviewer: null, overlayAnswer: { kind: 'dismissed' } })
  const { ctx, h, google } = b
  const reads = () => google.calls.filter((c) => /messages|media/.test(c.path)).length
  const before = reads()
  let readsAtStart = -1
  const start = ctx.overlay.start
  ctx.overlay.start = (spec) => ((readsAtStart = reads()), start(spec))
  await ctx.sendPanel({ type: 'open', id: S.dm })
  const o = ctx.overlays[0]
  assert.equal(o.spec.ready, 'manual')
  assert.deepEqual(o.spec.type, { name: 'inbox-item', data: { source: 'bronos.chat', id: S.dm } })
  assert.equal(readsAtStart, before, 'the overlay is up before anything is read')
  assert.equal(o.posts[0].type, 'doc')
  const d = await o.discuss()
  assert.match(d.text, /deploy/)
  assert.ok(d.text.length <= 4100)
  await h.stop()
})

test('own reader page: an open that fails closes the early overlay; an alert group gets no type', async () => {
  const { ctx, h } = await signedIn({ reviewer: null, google: { fail: { [`messages:${S.dm}`]: 500 } } })
  let closed = false
  const start = ctx.overlay.start
  ctx.overlay.start = (spec) => {
    const hd = start(spec)
    return { ...hd, close: () => ((closed = true), hd.close()) }
  }
  await ctx.sendPanel({ type: 'open', id: S.dm })
  await settle({ h })
  assert.equal(closed, true)
  const alert = ctx.lastState().lanes.flatMap((l) => l.rows).find((r) => r.kind === 'alert')
  if (alert) {
    const n = ctx.overlays.length
    await ctx.sendPanel({ type: 'open', id: alert.id })
    await settle({ h })
    assert.equal(ctx.overlays.slice(n).some((o) => o.spec.type), false)
  }
  await h.stop()
})

test('reviewer: the inbox-item type goes with prepare and annotate; an alert group has none', async () => {
  const order = []
  const reviewer = fakeReviewer()
  reviewer.prepare = async (spec) => (order.push(spec), { opened: true })
  reviewer.cancel = async () => ({ closed: false })
  const { ctx, h } = await signedIn({ reviewer, sessions: [tab('t1', 'waiting', { active: true })] })
  await ctx.sendPanel({ type: 'open', id: S.dm })
  await settle({ h })
  const type = { name: 'inbox-item', data: { source: 'bronos.chat', id: S.dm } }
  assert.deepEqual(order[0].type, type)
  assert.deepEqual(reviewer.calls[0].type, type)
  await h.stop()
})
