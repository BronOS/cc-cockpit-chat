'use strict'
// Fakes shared by the suites: Google Chat, the People API and Google's token info behind one fake
// fetch (a small made-up organisation, never the network), Google's OAuth through a fake ctx.oauth,
// and a cc-cockpit ctx written from `ccc guide api` and `ccc guide types`. Every name, address and id
// here is example data (acme, example.com, "Ann Example"). (bronos.gmail's fakes.js, with Chat's.)

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CHAT = 'https://chat.googleapis.com'
const PEOPLE = 'https://people.googleapis.com'
const OAUTH = 'https://oauth2.googleapis.com'
const NOW = Date.parse('2026-11-03T08:00:00Z')
const ME_EMAIL = 'me@example.com'
const CLIENT_ID = '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com'
const CLIENT_SECRET = 'GOCSPX-test-secret-0123456789ab'
const SETTINGS_CLIENT = { clientId: '555555555555-settingsclient.apps.googleusercontent.com', clientSecret: 'GOCSPX-settings-secret' }
const G = 'https://www.googleapis.com/auth/'
const ALL_SCOPES = `${G}chat.spaces.readonly ${G}chat.messages.readonly ${G}chat.users.readstate ${G}directory.readonly openid ${G}userinfo.email`

const U = { me: 'users/1001', ann: 'users/2001', bob: 'users/2002', cat: 'users/2003', grafana: 'users/3001' }
const NAMES = { [U.ann]: 'Ann Example', [U.bob]: 'Bob Example', [U.cat]: 'Cat Example', [U.me]: 'Me Example' }
const S = { dm: 'spaces/DMANN', team: 'spaces/TEAM', alerts: 'spaces/ALERTS', random: 'spaces/RANDOM', stale: 'spaces/STALE' }

/** RFC 3339 of `min` minutes before NOW (Chat's microsecond precision). */
function ago(min) {
  return new Date(NOW - min * 60000).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z')
}

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** Bytes that sniff as a picture of the type (the magic number, then filler up to `size`). */
function picture(type = 'png', size = 64) {
  const head = {
    png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    gif: Buffer.from('GIF89a', 'latin1'),
  }[type]
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 7)])
}

/** A raw Chat message. */
function msg(space, id, o) {
  const sender = o.from === U.grafana ? { name: U.grafana, type: 'BOT', displayName: 'Grafana' } : { name: o.from, type: 'HUMAN' }
  const m = { name: `${space}/messages/${id}`, sender, createTime: o.at, text: o.text, formattedText: o.text }
  if (o.thread) {
    m.thread = { name: `${space}/threads/${o.thread}` }
    m.threadReply = Boolean(o.reply)
  }
  if (o.mentions) {
    m.annotations = o.mentions.map((u) => ({ type: 'USER_MENTION', startIndex: 0, length: 4, userMention: { user: u === 'all' ? { name: 'users/all', type: 'HUMAN' } : { name: u, type: 'HUMAN' }, type: 'MENTION' } }))
    // Chat names @all with users/all; compactMessage reads it as ALL.
  }
  if (o.attachment) m.attachment = [o.attachment]
  return m
}

/**
 * The example organisation, fresh each call:
 * - DM with Ann (unread: her question with a picture),
 * - Acme Team (threaded): T1 started by Bob @mentioning me (unread, Cat replied), T2 Cat's lunch
 *   question (unread), T3 an old thread with a reply of Ann's (read: Recent, and no mark target),
 * - Acme Alerts (flat): two Grafana alerts (unread),
 * - Acme Random (flat): Ann's message read an hour ago (Recent),
 * - an old space quiet for a month (never read).
 */
function world() {
  const spaces = [
    { name: S.dm, spaceType: 'DIRECT_MESSAGE', spaceThreadingState: 'THREADED_MESSAGES', lastActiveTime: ago(20) },
    { name: S.team, spaceType: 'SPACE', displayName: 'Acme Team', spaceThreadingState: 'THREADED_MESSAGES', lastActiveTime: ago(10), membershipCount: { joinedDirectHumanUserCount: 8 } },
    { name: S.alerts, spaceType: 'SPACE', displayName: 'Acme Alerts', spaceThreadingState: 'GROUPED_MESSAGES', lastActiveTime: ago(8) },
    { name: S.random, spaceType: 'SPACE', displayName: 'Acme Random', spaceThreadingState: 'GROUPED_MESSAGES', lastActiveTime: ago(300) },
    { name: S.stale, spaceType: 'SPACE', displayName: 'Acme Archive', spaceThreadingState: 'GROUPED_MESSAGES', lastActiveTime: ago(30 * 1440) },
  ]
  const messages = {
    [S.dm]: [
      msg(S.dm, 'D1', { from: U.me, at: ago(90), text: 'Morning!' }),
      msg(S.dm, 'D2', { from: U.ann, at: ago(20), text: 'Can you look at the *deploy* of example.com? https://status.example.com/run/42', attachment: { name: `${S.dm}/messages/D2/attachments/A1`, contentName: 'deploy.png', contentType: 'image/png', source: 'UPLOADED_CONTENT', attachmentDataRef: { resourceName: 'RES-A1' } } }),
    ],
    [S.team]: [
      msg(S.team, 'T3.T3', { from: U.ann, at: ago(3 * 1440), text: 'Migration notes', thread: 'T3' }),
      msg(S.team, 'T1.T1', { from: U.bob, at: ago(30), text: 'Release plan for Friday <users/1001> please check', thread: 'T1', mentions: [U.me] }),
      msg(S.team, 'T1R1', { from: U.cat, at: ago(25), text: 'I can help with the release', thread: 'T1', reply: true }),
      msg(S.team, 'T2.T2', { from: U.cat, at: ago(15), text: 'Lunch at noon?', thread: 'T2' }),
      msg(S.team, 'T3R1', { from: U.ann, at: ago(10), text: 'Done with the migration', thread: 'T3', reply: true }),
    ],
    [S.alerts]: [
      msg(S.alerts, 'A1', { from: U.grafana, at: ago(12), text: '[FIRING:1] HighCPU — node-1 (prod)' }),
      msg(S.alerts, 'A2', { from: U.grafana, at: ago(8), text: '[FIRING:1] HighCPU — node-2 (prod)' }),
    ],
    [S.random]: [msg(S.random, 'R1', { from: U.ann, at: ago(300), text: 'Cake in the kitchen' })],
    [S.stale]: [msg(S.stale, 'X1', { from: U.bob, at: ago(30 * 1440), text: 'Old news' })],
  }
  const read = { [S.dm]: ago(60), [S.team]: ago(40), [S.alerts]: ago(60), [S.random]: ago(60), [S.stale]: ago(29 * 1440) }
  return { spaces, messages, read, threadRead: {}, media: { 'RES-A1': picture('png', 80) } }
}

/** A token registry the fake OAuth hands out and the fake Google accepts. */
function tokens() {
  return { valid: new Set(), n: 0 }
}

/**
 * A fake Google: Chat, People and the token info. `opts.world` (default world()), `opts.scope` (the
 * granted scopes), `opts.email`, `opts.sub`, `opts.fail`: { [route]: status | { status, body } } for
 * `spaces`, `readstate:<space>`, `patch:<space>`, `messages:<space>`, `thread:<thread>`, `search`,
 * `own`, `people`, `tokeninfo`, `media`. Records every call in `calls` and every write in `writes`.
 */
function fakeGoogle(opts = {}) {
  const w = opts.world || world()
  const calls = []
  const writes = []
  const reg = opts.tokens || tokens()
  const failOf = (route) => {
    const f = opts.fail && opts.fail[route]
    if (!f) return null
    const status = typeof f === 'number' ? f : f.status
    const body = typeof f === 'object' && f.body ? f.body : status === 401 ? { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } } : status === 429 ? { error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } } : status === 403 ? { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } : { error: { code: status, message: 'boom' } }
    return json(body, status)
  }
  const newestFirst = (list) => [...list].sort((a, b) => (a.createTime < b.createTime ? 1 : a.createTime > b.createTime ? -1 : 0))
  const mentionsMe = (m) => (m.annotations || []).some((a) => a.userMention && a.userMention.user && a.userMention.user.name === U.me)
  async function fetch(url, init = {}) {
    const headers = init.headers || {}
    const u = new URL(url)
    const method = init.method || 'GET'
    const body = init.body && /json/.test(headers['Content-Type'] || '') ? JSON.parse(init.body) : null
    calls.push({ url, origin: u.origin, path: u.pathname, method, auth: headers.Authorization, redirect: init.redirect, body })
    if (opts.routes) {
      const r = await opts.routes(u, init)
      if (r) return r
    }
    if (![CHAT, PEOPLE, OAUTH].includes(u.origin)) throw new Error(`fake google: unexpected host ${u.origin}`)
    const token = String(headers.Authorization || '').replace(/^Bearer /, '')
    if (!reg.valid.has(token)) return json({ error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } }, 401)
    if (u.origin === OAUTH && u.pathname === '/tokeninfo' && method === 'POST') {
      const f = failOf('tokeninfo')
      if (f) return f
      return json({ azp: CLIENT_ID, aud: CLIENT_ID, sub: opts.sub === undefined ? '1001' : opts.sub, scope: opts.scope === undefined ? ALL_SCOPES : opts.scope, exp: String(Math.floor(NOW / 1000) + 3600), expires_in: '3599', email: opts.email || ME_EMAIL, email_verified: 'true', access_type: 'offline' })
    }
    if (u.origin === PEOPLE && u.pathname === '/v1/people:batchGet') {
      const f = failOf('people')
      if (f) return f
      const names = u.searchParams.getAll('resourceNames')
      return json({ responses: names.map((rn) => ({ httpStatusCode: 200, requestedResourceName: rn, person: NAMES[`users/${rn.slice(7)}`] ? { resourceName: rn, names: [{ metadata: { primary: true }, displayName: NAMES[`users/${rn.slice(7)}`] }] } : { resourceName: rn } })) })
    }
    if (u.origin !== CHAT) return json({ error: { code: 404, message: 'not found' } }, 404)
    const p = u.pathname
    if (p === '/v1/spaces' && method === 'GET') {
      const f = failOf('spaces')
      if (f) return f
      return json({ spaces: w.spaces })
    }
    let m = /^\/v1\/users\/me\/(spaces\/[A-Za-z0-9_-]+)\/spaceReadState$/.exec(p)
    if (m) {
      const space = m[1]
      if (method === 'PATCH') {
        const f = failOf(`patch:${space}`)
        if (f) return f
        writes.push({ space, lastReadTime: body.lastReadTime, updateMask: u.searchParams.get('updateMask') })
        w.read[space] = body.lastReadTime
        return json({ name: `users/me/${space}/spaceReadState`, lastReadTime: body.lastReadTime })
      }
      const f = failOf(`readstate:${space}`)
      if (f) return f
      return json({ name: `users/me/${space}/spaceReadState`, ...(w.read[space] ? { lastReadTime: w.read[space] } : {}) })
    }
    m = /^\/v1\/users\/me\/(spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_.-]+)\/threadReadState$/.exec(p)
    if (m) {
      const f = failOf(`thread:${m[1]}`)
      if (f) return f
      return json({ name: `users/me/${m[1]}/threadReadState`, lastReadTime: w.threadRead[m[1]] || '1970-01-01T00:00:00Z' })
    }
    m = /^\/v1\/(spaces\/[A-Za-z0-9_-]+)\/messages$/.exec(p)
    if (m && method === 'GET') {
      const f = failOf(`messages:${m[1]}`)
      if (f) return f
      let list = w.messages[m[1]] || []
      const filter = u.searchParams.get('filter')
      if (filter) {
        const t = /^thread\.name = (\S+)$/.exec(filter)
        if (!t) return json({ error: { code: 400, message: 'bad filter' } }, 400)
        list = list.filter((x) => x.thread && x.thread.name === t[1])
      }
      const size = Number(u.searchParams.get('pageSize')) || 25
      const sorted = newestFirst(list)
      return json({ messages: sorted.slice(0, size), ...(sorted.length > size ? { nextPageToken: 'more' } : {}) })
    }
    if (p === '/v1/spaces/-/messages:search' && method === 'POST') {
      if (/sender\.name = "users\/me"/.test(body.filter)) {
        const f = failOf('own')
        if (f) return f
        const own = Object.values(w.messages).flat().find((x) => x.sender.name === U.me)
        return json({ results: own ? [{ message: own }] : [] })
      }
      const f = failOf('search')
      if (f) return f
      // As the real API (probed 2026-11-03): any createTime filter is refused; is_unread() works.
      if (/createTime/.test(body.filter)) return json({ error: { code: 400, message: `Invalid filter query: ${body.filter}`, status: 'INVALID_ARGUMENT' } }, 400)
      const spaceOf = (name) => name.split('/messages/')[0]
      const isRead = (x) => Boolean(w.read[spaceOf(x.name)] && w.read[spaceOf(x.name)] >= x.createTime)
      const unreadOnly = /is_unread\(\)/.test(body.filter)
      const hits = newestFirst(Object.values(w.messages).flat().filter((x) => mentionsMe(x) && (!unreadOnly || !isRead(x))))
      return json({ results: hits.map((x) => ({ message: x, read: isRead(x) })) })
    }
    m = /^\/v1\/media\/(.+)$/.exec(p)
    if (m && u.searchParams.get('alt') === 'media') {
      const f = failOf('media')
      if (f) return f
      if (opts.mediaDelay) await new Promise((r) => setTimeout(r, opts.mediaDelay))
      const bytes = w.media[m[1]]
      if (!bytes) return json({ error: { code: 404, message: 'no such media' } }, 404)
      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } })
    }
    return json({ error: { code: 404, message: 'not found' } }, 404)
  }
  return { fetch, calls, writes, world: w, tokens: reg }
}

/**
 * A fake ctx.oauth. `authorize` and `refresh` record their specs and hand out tokens the fake
 * Google accepts. `invalidGrant: true` makes refresh fail the way the app's ctx.oauth does.
 * `noRefreshToken`: authorize sends none. `authorizeError`: authorize rejects with it.
 */
function fakeOAuth(reg, opts = {}) {
  const o = {
    authorizes: [],
    refreshes: [],
    invalidGrant: Boolean(opts.invalidGrant),
    async authorize(spec) {
      o.authorizes.push(structuredClone(spec))
      if (o.authorizeError) throw new Error(o.authorizeError)
      if (o.gate) await o.gate
      const t = `ya29.access-${++reg.n}`
      reg.valid.add(t)
      return { accessToken: t, refreshToken: opts.noRefreshToken ? null : `1//refresh-${reg.n}`, expiresAt: (opts.now || (() => NOW))() + 3600000 }
    },
    async refresh(spec, refreshToken) {
      o.refreshes.push({ spec: structuredClone(spec), refreshToken })
      if (o.invalidGrant) throw new Error('the token endpoint refused the request: HTTP 400 (invalid_grant)')
      if (o.refreshError) throw new Error(o.refreshError)
      const t = `ya29.access-${++reg.n}`
      reg.valid.add(t)
      return { accessToken: t, refreshToken: o.rotate ? `1//rotated-${reg.n}` : null, expiresAt: (opts.now || (() => NOW))() + 3600000 }
    },
  }
  return o
}

/** A fake ctx.secrets: a Map, with `failSet` to play a locked keyring. */
function fakeSecrets() {
  const m = new Map()
  const s = {
    map: m,
    failSet: null,
    async get(k) {
      return m.has(k) ? m.get(k) : null
    },
    async set(k, v) {
      if (s.failSet) throw new Error(s.failSet)
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(k)) throw new Error(`bad secret key ${k}`)
      if (typeof v !== 'string' || v.length > 65536) throw new Error('bad secret value')
      m.set(k, v)
    },
    async delete(k) {
      m.delete(k)
    },
    async keys() {
      return [...m.keys()].sort()
    },
  }
  return s
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-'))
}

/** An in-memory ctx.storage (structured clones both ways, like the app's JSON store). */
function fakeStorage() {
  const store = new Map()
  return {
    map: store,
    async get(k) {
      return store.has(k) ? structuredClone(store.get(k)) : undefined
    },
    async set(k, v) {
      store.set(k, structuredClone(v))
    },
    async delete(k) {
      store.delete(k)
    },
    async keys() {
      return [...store.keys()]
    },
  }
}

/**
 * A ctx good enough for dist/host.js: in-memory storage and secrets, recorded posts, headers,
 * badges, sessions, overlays, openExternal; services `triage` and `reviewer` from `opts`.
 * `opts.old`: the members cc-cockpit 0.9.1 added are left out.
 */
function fakeCtx(opts = {}) {
  const panelListeners = []
  const actionListeners = []
  const settingsListeners = []
  const dataDir = opts.dataDir || tmpDir()
  const services = { triage: opts.triage || null, reviewer: opts.reviewer || null }
  const ctx = {
    api: 1,
    pluginId: 'bronos.chat',
    projectDir: dataDir,
    dataDir,
    settings: Object.freeze({ project: opts.project || {}, app: {} }),
    posts: [],
    headers: [],
    badges: [],
    logs: [],
    sent: [],
    opened: [],
    external: [],
    overlays: [],
    buttonProviders: [],
    schedules: [],
    sessionList: opts.sessions || [],
    onSettingsChange(fn) {
      settingsListeners.push(fn)
      return () => {}
    },
    async changeSettings(project) {
      ctx.settings = Object.freeze({ project, app: {} })
      for (const fn of settingsListeners) await fn(ctx.settings)
    },
    storage: opts.storage || fakeStorage(),
    secrets: opts.secrets || fakeSecrets(),
    oauth: opts.oauth,
    log: {
      info: (...a) => ctx.logs.push(['info', a.join(' ')]),
      warn: (...a) => ctx.logs.push(['warn', a.join(' ')]),
      error: (...a) => ctx.logs.push(['error', a.join(' ')]),
    },
    badge: (panel, v) => ctx.badges.push(v),
    schedule(seconds, fn) {
      const s = { seconds, fn, stopped: false }
      ctx.schedules.push(s)
      return () => {
        s.stopped = true
      }
    },
    async exec(argv) {
      throw new Error(`the plugin must not exec (${argv[0]})`)
    },
    async openExternal(url) {
      if (ctx.externalError) throw new Error(ctx.externalError)
      ctx.external.push(url)
    },
    panels: {
      post: (panel, m) => {
        if (JSON.stringify(m).length > 1024 * 1024) throw new Error('panel message over 1 MiB')
        ctx.posts.push(structuredClone(m))
      },
      onMessage: (panel, fn) => {
        panelListeners.push(fn)
        return () => {}
      },
      header: (panel, spec) => {
        if (spec && spec.meta && spec.meta.length > 120) throw new TypeError('meta over 120')
        ctx.headers.push(structuredClone(spec))
      },
      onAction: (panel, fn) => {
        actionListeners.push(fn)
        return () => {}
      },
      show() {},
    },
    async sendPanel(m) {
      for (const fn of panelListeners) await fn(m)
    },
    async clickAction(id) {
      for (const fn of actionListeners) await fn(id)
    },
    overlay: {
      start(spec) {
        const o = { spec, posts: [], listeners: [], answer: opts.overlayAnswer || { kind: 'dismissed' } }
        ctx.overlays.push(o)
        const result = Promise.resolve(o.answer)
        o.send = (m) => o.listeners.forEach((fn) => fn(structuredClone(m)))
        return {
          result,
          post: (m) => {
            if (JSON.stringify(m).length > 1040384) throw new Error('overlay message over 1,040,384 chars of JSON')
            o.posts.push(structuredClone(m))
          },
          onMessage: (fn) => (o.listeners.push(fn), () => {}),
          onDiscuss: (fn) => ((o.discuss = fn), () => {}),
          close() {
            o.closed = true
          },
          focus() {},
        }
      },
    },
    sessions: {
      async list() {
        return ctx.sessionList
      },
      async send(tabId, text) {
        ctx.sent.push({ tabId, text })
        return { delivered: true }
      },
      async open(o) {
        ctx.opened.push(o)
        return { tabId: 'new1' }
      },
    },
    cli: {
      register: (name, fn) => {
        ctx.cliName = name
        ctx.cliHandler = fn
        return () => {}
      },
    },
    async runCli(argv, cwd = dataDir) {
      return ctx.cliHandler(argv, { stdin: '', cwd, signal: new AbortController().signal })
    },
    services: {
      use: (name) => {
        const handle = { on: (ev, fn) => ((handle.listeners[ev] = handle.listeners[ev] || []).push(fn), () => {}), listeners: {} }
        ctx.handles[name] = handle
        return new Proxy(handle, {
          get(target, prop) {
            if (prop in target) return target[prop]
            return async (...args) => {
              const impl = services[name]
              if (!impl) throw new Error(`no enabled plugin in this project provides service "${name}"`)
              if (typeof impl[prop] !== 'function') throw new Error(`service "${name}" (plugin cockpit.${name}) has no method "${String(prop)}"`)
              return structuredClone(await impl[prop](...structuredClone(args)))
            }
          },
        })
      },
      available: (name) => Boolean(services[name]),
      provide: (name, impl) => void (ctx.provided[name] = impl),
      emit: (name, event, data) => void ctx.emitted.push({ name, event, data }),
      caller: () => undefined,
    },
    handles: {},
    provided: {}, // service name -> the impl the plugin provided
    emitted: [], // { name, event, data } of every ctx.services.emit
    lastState() {
      return [...ctx.posts].reverse().find((m) => m.type === 'state')
    },
  }
  // `opts.buttons`: an app with ctx.overlay.buttons (the inbox redesign); without it, as before.
  if (opts.buttons) ctx.overlay.buttons = (name, provider) => (ctx.buttonProviders.push({ name, provider }), () => {})
  if (opts.old) {
    delete ctx.oauth
    delete ctx.secrets
    delete ctx.openExternal
    delete ctx.panels.header
    delete ctx.panels.onAction
  }
  return ctx
}

/** A fake triage service: an override or a hint decides, else priority by lane; records every call. */
function fakeTriage() {
  const t = {
    calls: [],
    overrides: {},
    async classify(source, items) {
      t.calls.push({ source, items })
      const results = {}
      for (const it of items) {
        const o = t.overrides[it.id]
        if (o) results[it.id] = { priority: o.priority, kind: null, confidence: 1, by: 'override' }
        else if (it.hint) results[it.id] = { priority: it.hint.priority, kind: null, confidence: 1, by: 'hint' }
        else results[it.id] = { priority: it.fields.lane === 'recent' ? 'fyi' : 'action', kind: 'request', confidence: 0.4, by: 'jev' }
      }
      return { results, stats: { items: items.length } }
    },
    async override(source, id, v) {
      t.overrides[id] = v
    },
    async clear(source, id) {
      const had = id in t.overrides
      delete t.overrides[id]
      return had
    },
  }
  return t
}

/** A fake reviewer with annotate; `refuseHtml` plays one whose annotate takes text only. */
function fakeReviewer(opts = {}) {
  const r = {
    calls: [],
    async annotate(a) {
      r.calls.push(a)
      if (opts.refuseHtml && a.html !== undefined) throw new Error('annotate: html is not supported')
      return { opened: true }
    },
  }
  return r
}

module.exports = { fixture, fakeGoogle, fakeOAuth, fakeSecrets, fakeStorage, fakeCtx, fakeTriage, fakeReviewer, tokens, world, msg, ago, tmpDir, picture, json, CHAT, PEOPLE, OAUTH, NOW, ME_EMAIL, CLIENT_ID, CLIENT_SECRET, SETTINGS_CLIENT, ALL_SCOPES, U, S, NAMES }
