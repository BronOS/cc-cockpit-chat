'use strict'
// The small pure pieces: Chat's times, ids and names, the scopes and the client file, the settings,
// the setup links, the title bar, the names cache, and the token's one road out (http.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const T = require('../dist/lib/time')
const { rowId, spaceName, threadName, userName, spaceOf, cut, oneLine, mapLimit, hashOf } = require('../dist/lib/util')
const { missingScopes, oauthSpec, parseClientFile, checkClientId, SCOPES, SCOPE_LIST } = require('../dist/lib/oauth-client')
const { readSettings, alertsOn } = require('../dist/lib/settings')
const { STEPS, LINKS, linkUrl } = require('../dist/lib/setup')
const { headerSpec } = require('../dist/lib/header')
const { createNames, lookUp, senderLabel, mentionText } = require('../dist/lib/names')
const { googleRequest, ChatError, CHAT, PEOPLE, OAUTH, isBusy, WORKSPACE_TEXT, NO_CHAT_APP_TEXT } = require('../dist/lib/http')
const { fixture, json, NOW, ALL_SCOPES, CLIENT_ID, CLIENT_SECRET } = require('./fakes')

test('time: RFC 3339 to nanoseconds, compared exactly (Chat has microseconds)', () => {
  assert.equal(T.parse('2026-11-03T08:00:00Z'), 1793692800000000000n)
  assert.equal(T.parse('2026-11-03T08:00:00.123456Z') - T.parse('2026-11-03T08:00:00.123455Z'), 1000n)
  assert.equal(T.parse('2026-11-03T09:00:00+01:00'), T.parse('2026-11-03T08:00:00Z'))
  assert.equal(T.parse('yesterday'), null)
  assert.equal(T.parse(42), null)
  assert.equal(T.ms('2026-11-03T08:00:00.999999Z'), NOW + 999)
  assert.equal(T.after('2026-11-03T08:00:00.000002Z', '2026-11-03T08:00:00.000001Z'), true)
  assert.equal(T.after('2026-11-03T08:00:00Z', '2026-11-03T08:00:00Z'), false)
  assert.equal(T.after('2026-11-03T08:00:00Z', null), true, 'never read: everything is new')
  assert.equal(T.compare('2026-11-03T08:00:00Z', '2026-11-03T07:00:00Z'), 1)
})

test('time: justBefore is one microsecond earlier; format keeps nine digits when it must', () => {
  assert.equal(T.justBefore('2026-11-03T08:00:00Z'), '2026-11-03T07:59:59.999999Z')
  assert.equal(T.justBefore('2026-11-03T08:00:00.000001Z'), '2026-11-03T08:00:00.000000Z')
  assert.equal(T.format(T.parse('2026-11-03T08:00:00.123456789Z')), '2026-11-03T08:00:00.123456789Z')
  assert.equal(T.normalise('2026-11-03T09:00:00+01:00'), '2026-11-03T08:00:00.000000Z')
  assert.equal(T.normalise('junk'), null)
  assert.equal(T.fromMs(NOW), '2026-11-03T08:00:00Z')
  // Whole seconds only: Chat's search refuses a fraction (2026-11-03).
  assert.equal(T.fromMs(NOW + 590), '2026-11-03T08:00:00Z')
  assert.equal(T.isEpoch('1970-01-01T00:00:00Z'), true)
  assert.equal(T.isEpoch('2026-11-03T08:00:00Z'), false)
})

test('ids: spaces, threads, users and row ids checked before they go into a URL', () => {
  assert.equal(spaceName('spaces/AAAA'), 'spaces/AAAA')
  assert.equal(spaceName('spaces/../x'), null)
  assert.equal(spaceName('spaces/A/messages/B'), null)
  assert.equal(threadName('spaces/AAAA/threads/b.c-d_e'), 'spaces/AAAA/threads/b.c-d_e')
  assert.equal(threadName('spaces/AAAA/threads/'), null)
  assert.equal(userName('users/123'), 'users/123')
  assert.equal(userName('users/1 2'), null)
  assert.equal(spaceOf('spaces/AAAA/messages/x.y'), 'spaces/AAAA')
  assert.deepEqual(rowId('spaces/AAAA'), { space: 'spaces/AAAA' })
  assert.deepEqual(rowId('spaces/AAAA/threads/T1'), { space: 'spaces/AAAA', thread: 'spaces/AAAA/threads/T1' })
  assert.deepEqual(rowId('alert:HighCPU'), { alert: 'HighCPU' })
  for (const bad of ['', 'alert:', 'spaces/', 'https://chat.google.com/x', 'spaces/A/threads/T/../x', 7, null, `alert:${'x'.repeat(300)}`]) assert.equal(rowId(bad), null, String(bad))
})

test('util: cut, oneLine, hashOf, mapLimit keeps order and catches per item', async () => {
  assert.equal(cut('abcdef', 4), 'abc…')
  assert.equal(oneLine(' a\n\tb  c '), 'a b c')
  assert.equal(hashOf({ a: 1 }), hashOf({ a: 1 }))
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }))
  const r = await mapLimit([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('two')
    return n * 10
  })
  assert.deepEqual(r.map((x) => (x.ok ? x.value : x.error.message)), [10, 'two', 30])
})

test('scopes: what is asked, what a token info answer lacks', () => {
  assert.deepEqual(SCOPE_LIST, [SCOPES.spaces, SCOPES.messages, SCOPES.readstate, SCOPES.directory, 'openid', 'email'])
  assert.ok(!SCOPE_LIST.some((s) => /memberships|chat\.messages$|chat\.messages\.create|chat\.spaces$|readstate\.readonly/.test(s)), 'no write scope but the read state')
  assert.deepEqual(missingScopes(ALL_SCOPES), [])
  assert.deepEqual(missingScopes('openid https://www.googleapis.com/auth/chat.spaces.readonly'), ['messages', 'readstate', 'directory'])
  assert.deepEqual(missingScopes('chat.spaces.readonly chat.messages.readonly chat.users.readstate.readonly directory.readonly'), ['readstate'], 'readstate.readonly reads but cannot mark')
  assert.equal(missingScopes(''), null)
  assert.equal(missingScopes(undefined), null)
})

test('the client file: a Desktop client is taken, a Web one refused, the spec carries our scopes and fixed URLs', () => {
  const r = parseClientFile(JSON.stringify(fixture('client_secret.json')))
  assert.deepEqual(r, { ok: true, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  const web = parseClientFile(JSON.stringify(fixture('client-web.json')))
  assert.equal(web.ok, false)
  assert.match(web.error, /Web application.*Desktop app/)
  assert.ok(!web.error.includes('GOCSPX'))
  assert.equal(parseClientFile('not json').ok, false)
  const doctored = fixture('client_secret.json')
  doctored.installed.token_uri = 'https://evil.example/token'
  assert.equal(parseClientFile(JSON.stringify(doctored)).ok, false)
  const spec = oauthSpec({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  assert.equal(spec.authUrl, 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent')
  assert.equal(spec.tokenUrl, 'https://oauth2.googleapis.com/token')
  assert.deepEqual(spec.scopes, SCOPE_LIST)
  assert.equal(checkClientId('abc').ok, false)
})

test('settings: defaults, clamps, alert bots one line each, mark read on open on by default', () => {
  const { cfg, problems } = readSettings({})
  assert.deepEqual(problems, [])
  assert.deepEqual(cfg.lanes, { mentions: true, direct: true, spaces: true, alerts: true, recent: true })
  assert.equal(cfg.rowsPerLane, 10)
  assert.equal(cfg.days, 14)
  assert.equal(cfg.recentDays, 2)
  assert.equal(cfg.pollMinutes, 2)
  assert.equal(cfg.markReadOnOpen, true)
  assert.equal(cfg.triageText, 'full')
  assert.equal(alertsOn(cfg), false, 'no alert bots: no Alerts lane')
  const b = readSettings({ lanes: { spaces: false }, alertBots: ['Grafana', ' Grafana ', 'x'.repeat(150), 3], rowsPerLane: 9999, recentDays: 0, markReadOnOpen: false, triageText: 'summary', clientId: 'nope' })
  assert.equal(b.cfg.lanes.spaces, false)
  assert.equal(b.cfg.lanes.mentions, true)
  assert.deepEqual(b.cfg.alertBots, ['Grafana'])
  assert.equal(b.cfg.rowsPerLane, 300)
  assert.equal(b.cfg.recentDays, 1)
  assert.equal(b.cfg.markReadOnOpen, false)
  assert.equal(b.cfg.triageText, 'summary')
  assert.equal(b.cfg.clientId, '')
  assert.equal(b.problems.length, 2)
  assert.equal(alertsOn(b.cfg), true)
})

test('setup: every step link is a fixed https URL; an unknown id is no URL', () => {
  for (const s of STEPS) for (const l of s.links) assert.match(linkUrl(l.id), /^https:\/\//)
  assert.ok(STEPS.some((s) => s.links.some((l) => l.id === 'chatConfig')), 'the Chat app configuration step')
  assert.ok(STEPS.some((s) => s.links.some((l) => l.id === 'peopleApi')))
  assert.ok(STEPS.some((s) => /Internal/.test(s.text)))
  assert.ok(STEPS.some((s) => /chat\.users\.readstate/.test(s.text)))
  assert.equal(linkUrl('https://evil.example'), null)
  assert.equal(linkUrl('constructor'), null)
  assert.equal(linkUrl('__proto__'), null)
  assert.ok(!Object.values(LINKS).some((u) => /chat\.google\.com/.test(u)), 'no link to Chat')
})

test('header: the last poll and the account; Refresh disabled until ready, busy while polling', () => {
  assert.deepEqual(headerSpec({ ready: false, polling: false, lastPoll: 0, account: '' }, NOW), { meta: '', actions: [{ id: 'refresh', icon: 'refresh', title: 'Poll Google Chat now', busy: false, disabled: true }] })
  const h = headerSpec({ ready: true, polling: true, lastPoll: NOW - 300000, account: 'me@example.com' }, NOW)
  assert.equal(h.meta, 'polling… · 5 min ago · me@example.com')
  assert.equal(h.actions[0].busy, true)
  assert.ok(headerSpec({ ready: true, polling: false, lastPoll: NOW, account: `${'a'.repeat(200)}@example.com` }, NOW).meta.length <= 120)
})

test('names: learned from messages, looked up in batches, misses retried after a day, bounded', async () => {
  let clock = NOW
  const n = createNames(null, () => clock)
  n.learn([{ sender: 'users/1', senderName: 'Ann Example', mentions: [], mentionNames: { 'users/2': 'Bob Example' } }])
  assert.equal(n.get('users/1'), 'Ann Example')
  assert.equal(n.get('users/2'), 'Bob Example')
  const asked = []
  const r = await lookUp(n, ['users/1', 'users/3', 'users/4', 'users/all'], async (ids) => {
    asked.push(ids)
    return { 'users/3': 'Cat Example' }
  })
  assert.deepEqual(asked, [['users/3', 'users/4']])
  assert.equal(r.error, null)
  assert.equal(n.get('users/3'), 'Cat Example')
  assert.equal(n.get('users/4'), '')
  assert.deepEqual(n.unknown(['users/4']), [], 'a miss is not asked again the same day')
  clock += 25 * 3600000
  assert.deepEqual(n.unknown(['users/4']), ['users/4'])
  const failed = await lookUp(n, ['users/5'], async () => {
    throw new Error('people down')
  })
  assert.equal(failed.error.message, 'people down')
  const back = createNames(n.toJSON(), () => clock)
  assert.equal(back.get('users/3'), 'Cat Example')
  const big = createNames(null, () => clock)
  for (let i = 0; i < 2100; i++) big.set(`users/${i}`, `Person ${i}`)
  assert.ok(big.size() <= 2000)
})

test('names: who a sender is, and mentions as a person reads them', () => {
  const n = createNames(null, () => NOW)
  n.set('users/2', 'Bob Example')
  assert.equal(senderLabel({ sender: 'users/1', bot: false, senderName: '' }, n, 'users/1'), 'you')
  assert.equal(senderLabel({ sender: 'users/9', bot: true, senderName: 'Grafana' }, n, 'users/1'), 'Grafana (bot)')
  assert.equal(senderLabel({ sender: 'users/2', bot: false, senderName: '' }, n, 'users/1'), 'Bob Example')
  assert.equal(senderLabel({ sender: 'users/8', bot: false, senderName: '' }, n, 'users/1'), 'unknown user')
  assert.equal(mentionText('hi <users/1> and <users/2>, <users/all>, <users/7>', (u) => n.get(u), 'users/1'), 'hi @you and @Bob Example, @all, @someone')
  assert.equal(mentionText('<users/7>', () => '', '', { 'users/7': 'Cat Example' }), '@Cat Example')
})

test('http: only the allowed routes get the token; the token never goes into a URL; no redirect is followed', async () => {
  const TOKEN = 'ya29.secret-token'
  const seen = []
  const fetch = async (url, init) => {
    seen.push({ url, init })
    return json({ ok: true })
  }
  await googleRequest(CHAT, '/v1/spaces', { token: TOKEN, fetch, params: { pageSize: '10' } })
  await googleRequest(CHAT, '/v1/users/me/spaces/AAA/spaceReadState', { token: TOKEN, fetch, method: 'PATCH', params: { updateMask: 'lastReadTime' }, json: { lastReadTime: 'x' } })
  await googleRequest(CHAT, '/v1/spaces/-/messages:search', { token: TOKEN, fetch, method: 'POST', json: {} })
  await googleRequest(PEOPLE, '/v1/people:batchGet', { token: TOKEN, fetch })
  await googleRequest(OAUTH, '/tokeninfo', { token: TOKEN, fetch, method: 'POST', form: '' })
  for (const s of seen) {
    assert.equal(s.init.redirect, 'manual')
    assert.equal(s.init.headers.Authorization, `Bearer ${TOKEN}`)
    assert.ok(!s.url.includes(TOKEN))
  }
  const refused = [
    [CHAT, '/v1/spaces/AAA/messages', { method: 'POST' }], // sending a message
    [CHAT, '/v1/spaces/AAA/messages/BBB', { method: 'PATCH' }], // editing one
    [CHAT, '/v1/spaces/AAA/messages/BBB', { method: 'DELETE' }],
    [CHAT, '/v1/spaces/AAA/messages/BBB/reactions', { method: 'POST' }],
    [CHAT, '/v1/users/me/spaces/AAA/threads/T/threadReadState', { method: 'PATCH' }],
    [CHAT, '/v1/spaces/AAA/members', {}],
    [CHAT, '/v1/spaces/../x', {}],
    [CHAT, '/v1/spaces?x=1', {}],
    [PEOPLE, '/v1/people/me', {}],
    [OAUTH, '/token', { method: 'POST' }],
    ['https://evil.example', '/v1/spaces', {}],
  ]
  for (const [origin, p, extra] of refused) {
    await assert.rejects(googleRequest(origin, p, { token: TOKEN, fetch, ...extra }), (e) => e instanceof ChatError && e.kind === 'unsafe', `${extra.method || 'GET'} ${origin}${p}`)
  }
  assert.equal(seen.length, 5, 'no refused request reached fetch')
})

test('http: Google errors become kinds the host acts on, as one readable line', async () => {
  const answer = (status, body, headers) => async () => json(body, status, headers)
  const kind = async (origin, p, f, method = 'GET') => {
    try {
      await googleRequest(origin, p, { token: 't', fetch: f, method, ...(method !== 'GET' ? { json: {} } : {}) })
    } catch (e) {
      return e
    }
    return null
  }
  assert.equal((await kind(CHAT, '/v1/spaces', answer(401, { error: { code: 401 } }))).kind, 'auth')
  const rate = await kind(CHAT, '/v1/spaces', answer(429, { error: { code: 429 } }, { 'retry-after': '30' }))
  assert.equal(rate.kind, 'rate')
  assert.equal(rate.retryAfter, 30)
  assert.ok(isBusy(rate))
  assert.ok(isBusy(await kind(CHAT, '/v1/spaces', answer(503, {}))))
  const disabled = await kind(CHAT, '/v1/spaces', answer(403, { error: { code: 403, message: 'Google Chat API has not been used in project 123 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } }))
  assert.equal(disabled.kind, 'disabled')
  assert.equal(disabled.api, 'chat')
  const people = await kind(PEOPLE, '/v1/people:batchGet', answer(403, { error: { code: 403, message: 'People API has not been used in project 123', details: [{ reason: 'SERVICE_DISABLED' }] } }))
  assert.equal(people.api, 'people')
  const scope = await kind(CHAT, '/v1/users/me/spaces/A/spaceReadState', answer(403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }), 'PATCH')
  assert.equal(scope.kind, 'scope')
  assert.match(scope.message, /chat\.users\.readstate/)
  const ws = await kind(CHAT, '/v1/spaces', answer(403, { error: { code: 403, message: 'This API is not available for consumer accounts; use a Google Workspace account.' } }))
  assert.equal(ws.kind, 'workspace')
  assert.equal(ws.message, WORKSPACE_TEXT)
  const app = await kind(CHAT, '/v1/users/me/spaces/A/spaceReadState', answer(404, { error: { code: 404, message: 'Google Chat app not found. To create a Chat app, you must turn on the Chat API and configure the app in the Google Cloud console.' } }), 'PATCH')
  assert.equal(app.kind, 'noChatApp')
  assert.equal(app.message, NO_CHAT_APP_TEXT)
  const redirect = await kind(CHAT, '/v1/spaces', async () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } }))
  assert.equal(redirect.kind, 'http')
  assert.match(redirect.message, /redirect.*not followed/)
  const html = await kind(CHAT, '/v1/spaces', async () => new Response('<html><script>x</script></html>', { status: 400 }))
  assert.ok(!html.message.includes('<'))
  const big = await kind(CHAT, '/v1/spaces', async () => new Response('x'.repeat(100), { status: 200, headers: { 'content-length': String(9 * 1024 * 1024) } }))
  assert.equal(big.kind, 'toolarge')
})
