'use strict'
// bronos.chat: your Google Chat in lanes (Mentions, Direct messages, Spaces, Alerts, Recent), sorted
// by jev-triage, with Mark read / Mark unread. Plain JavaScript with no build step; the pure logic is
// in ./lib (node:test suites in test/). Design: docs/design.md. The app API: `ccc guide api` (this
// file uses only what it documents). Built the way bronos.gmail is built (its host is the model).
//
// Life of a project window: activate reads the settings, the sign-in state and the stored lanes,
// then polls every `pollMinutes` while the window is open (a closed project has no host, so it does
// nothing). The first poll of a run asks Google who is signed in and what was granted (token info);
// a personal account or a sign-in without the Chat scopes stops there with a message. A poll lists
// the spaces (their activity times), runs the mentions search, reads the spaces that changed and
// judges what is new (lib/poll.js); then triage judges what changed, and the state goes to the
// panel. Nothing is polled until an OAuth client is set and the person signed in with Google.
//
// Writes: only a space's read time (Mark read / Mark unread, and mark read on open with the
// `markReadOnOpen` setting): lib/readstate.js through lib/client.js's one write method. No message
// is ever sent, edited, deleted or reacted to. No link to Chat is offered anywhere (design, answer 2).

const path = require('node:path')
const { readSettings } = require('./lib/settings')
const { createAuth, AuthError } = require('./lib/auth')
const { shortClientId, SCOPE_TEXT } = require('./lib/oauth-client')
const { createClient } = require('./lib/client')
const { isBusy, WORKSPACE_TEXT } = require('./lib/http')
const { poll, checkAccount, buildView, allRows, loadState, emptyState, spaceLabel, fatal } = require('./lib/poll')
const { compactMessage, titleLine } = require('./lib/model')
const { createNames, lookUp, senderLabel, shownText } = require('./lib/names')
const { groupTitle } = require('./lib/alerts')
const { triageItem } = require('./lib/triage')
const { applyMark, NO_TARGET_TEXT } = require('./lib/readstate')
const { conversationDocument, pictureParts } = require('./lib/document')
const { readableText, discussPrompt } = require('./lib/readable')
const { selectImages, gatherImages, imageCache, MAX_IMAGE_BYTES, WAIT_MS } = require('./lib/images')
const { pickTab, isMissingAnnotate } = require('./lib/actions')
const { headerSpec } = require('./lib/header')
const { STEPS, linkUrl } = require('./lib/setup')
const { runCli } = require('./lib/cli')
const { jsonFile } = require('./lib/store')
const { LANE_IDS } = require('./lib/lanes')
const feed = require('./lib/feed')
const { hashOf, sha, oneLine, cut, rowId, unique } = require('./lib/util')
const { decode } = require('./lib/entities')
const T = require('./lib/time')

const PANEL = 'main'
const SOURCE = 'chat' // the triage source name: verdicts, overrides and cases group by it
const TRIAGE_CHUNK = 500 // triage.classify takes at most 500 items a call
const ROWS_PER_LANE = 300 // the panel message stays far below the 1 MiB post limit
const CLI_WAIT_MS = 25000 // `ccc` gives a handler 30 s
const IMAGE_TIMEOUT_MS = 20000
const BACKOFF_MAX_MINUTES = 30
const THREAD_PAGE = 100 // the view: a thread, all of it (its newest 100)
const CHAT_PAGE = 50 // the view: a DM, group chat or flat space, its newest 50
// The reader page gets the html in parts: a page message is at most 1,040,384 chars of JSON.
const PAGE_HTML_PART = 400000
// How long the reviewer's prepare and cancel may take: host-local calls, far under this.
const REVIEWER_WAIT_MS = 2000
// ctx.overlay.start gives no "shown" signal: main's refusal (3 open, 10 a minute) rejects the handle's
// `result` within one host-to-main round trip, while an overlay that opened settles only when it
// closes. Our reader page counts as up once this long passed without a rejection (the bundled
// reviewer's prepare and annotate wait the same).
const OVERLAY_SETTLE_MS = 500
// The reviewer an older app's overlays are trusted from (one without ctx.services.provider, which
// cannot name the provider a project picked): the bundled one, since a `cockpit.*` id loads only from
// the app's own bundle. A newer app names the picked `reviewer` instead (reviewerId), so a
// replacement reviewer gets our item buttons and the bundled one, not picked, does not.
const FALLBACK_REVIEWER_ID = 'cockpit.reviewer'
// Most of a conversation's text Discuss with Claude sends from an overlay.
const DISCUSS_MAX = 4000
// Consumer Google accounts: Chat's API is for Workspace only (design "Workspace only").
const PERSONAL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

let instance = null

/** What this app lacks of what the plugin needs (the 0.9.1 members); empty on a new enough app. */
function apiGaps(ctx) {
  const gaps = []
  if (!ctx.oauth || typeof ctx.oauth.authorize !== 'function' || typeof ctx.oauth.refresh !== 'function') gaps.push('ctx.oauth')
  if (!ctx.secrets || typeof ctx.secrets.get !== 'function') gaps.push('ctx.secrets')
  if (!ctx.panels || typeof ctx.panels.header !== 'function') gaps.push('ctx.panels.header')
  if (typeof ctx.openExternal !== 'function') gaps.push('ctx.openExternal')
  return gaps
}

/**
 * The host, with its I/O injectable for the suites (`fetch`, timers, the clock). The app calls
 * `activate(ctx)`, which uses the real ones.
 */
function start(ctx, io = {}) {
  const fetchFn = io.fetch || globalThis.fetch
  const now = io.now || Date.now
  const triage = ctx.services.use('triage')
  const reviewer = ctx.services.use('reviewer')
  const stateFile = jsonFile(ctx.dataDir, 'state.json')
  const namesFile = jsonFile(ctx.dataDir, 'names.json')
  const abort = new AbortController()
  const gaps = apiGaps(ctx)
  const tooOld = gaps.length ? `The Google Chat plugin needs cc-cockpit 0.9.2 or later (this app has no ${gaps.join(', ')}). Update cc-cockpit, then reopen this project.` : null

  const S = {
    settings: readSettings(ctx.settings.project),
    state: null, // poll.loadState: the account, the spaces and their rows
    names: createNames(null, now),
    view: { lanes: [], unread: 0 },
    feedRows: [], // lib/feed.js: the rows of every lane of the last view of a signed-in run (the feed's scope)
    gen: 0, // bumped when the client or account changes: a poll of the old one is thrown away
    polling: null, // the running poll's promise: one at a time
    pollAgain: false, // a mark finished during a poll: poll once more when it ends
    error: null, // the last poll's failure, shown as a notice
    notes: [], // the last poll's minor troubles (the mentions search, names)
    spaceErrors: [],
    backoffMinutes: 0, // set while Chat is busy (429 / 5xx): the poll interval, doubled each time
    accountChecked: false, // the token info was asked this run (who, which scopes)
    blocked: null, // why nothing is polled although signed in (a personal account, a missing scope)
    verdicts: {}, // row id -> { priority, kind, confidence, by }
    sigs: {}, // row id -> hash of the triage item it was judged on
    triageError: null,
    classifying: Promise.resolve(),
    annotateMissing: false, // set when a call proved the reviewer has no annotate
    htmlRejected: null, // the reviewer's message when annotate took text but refused html
    marks: {}, // row id -> { want: 'read'|'unread', state: 'pending'|'done', doneAt }: the optimistic view
    ui: { collapsed: {}, expanded: {} }, // per lane id; `expanded` = Show all pressed
    notice: null, // { text, kind: 'info'|'error' } after an action, until dismissed or replaced
    clientError: null, // why the pasted client file was refused (shown by the paste box)
    choose: null, // { id, tabs } when Discuss needs the person to pick a tab
    stopped: false,
  }
  const cfg = () => S.settings.cfg

  const auth = tooOld ? null : createAuth({ oauth: ctx.oauth, secrets: ctx.secrets, storage: ctx.storage, log: ctx.log, now })
  const chat = createClient({ getToken: () => auth.token(), invalidate: () => auth.invalidate(), fetch: fetchFn })
  const signedIn = () => Boolean(auth) && auth.status().signedIn
  const ready_ = () => signedIn() && !S.blocked
  const clientHash = () => {
    const c = auth && auth.client()
    return c ? sha(c.clientId, 12) : ''
  }
  const me = () => (S.state && S.state.me) || ''

  // ---- stored state ----

  const ready = (async () => {
    const ui = await ctx.storage.get('ui').catch(() => undefined)
    if (ui && typeof ui === 'object') {
      const obj = (v) => (v && typeof v === 'object' ? { ...v } : {})
      S.ui = { collapsed: obj(ui.collapsed), expanded: obj(ui.expanded) }
    }
    if (!auth) return
    await auth.load(cfg())
    S.state = loadState(await stateFile.read(null), clientHash())
    S.names = createNames(await namesFile.read(null), now)
    const g = auth.status().grant
    if (g) S.blocked = blockedBy(g.missing, g.email || S.state.account)
    const t = await ctx.storage.get('triage').catch(() => undefined)
    if (t && S.state.account && t.account === S.state.account && t.verdicts && t.sigs) {
      S.verdicts = t.verdicts
      S.sigs = t.sigs
    }
    rebuild()
  })().catch((e) => ctx.log.error('loading the stored state failed:', e && e.stack ? e.stack : e))

  function saveState() {
    if (!S.state) return Promise.resolve()
    const w = [stateFile.write(S.state).catch((e) => ctx.log.warn('writing the poll state failed:', e.message))]
    if (S.names.isDirty()) w.push(namesFile.write(S.names.toJSON()).catch((e) => ctx.log.warn('writing the names cache failed:', e.message)))
    return Promise.all(w)
  }
  function saveTriage() {
    return ctx.storage.set('triage', { account: S.state && S.state.account, verdicts: S.verdicts, sigs: S.sigs }).catch((e) => ctx.log.warn('saving triage verdicts failed:', e.message))
  }

  /** Forget everything of the previous client or account: lanes, names, verdicts, marks, a running poll's result. */
  function resetAccount() {
    S.gen++
    S.state = emptyState(clientHash())
    S.names = createNames(null, now)
    S.verdicts = {}
    S.sigs = {}
    S.marks = {}
    S.error = null
    S.notes = []
    S.spaceErrors = []
    S.backoffMinutes = 0
    S.accountChecked = false
    S.blocked = null
    images = null
    rebuild()
    void stateFile.write(S.state).catch(() => {})
    void namesFile.write(S.names.toJSON()).catch(() => {})
    void saveTriage()
  }

  /**
   * Why a signed-in account cannot be polled (design "Auth"): a personal Google account, or a
   * sign-in without a scope the lanes need. Null when it can. `directory.readonly` missing is not a
   * block (names only).
   */
  function blockedBy(missing, email) {
    const domain = String(email || '').split('@')[1] || ''
    if (PERSONAL_DOMAINS.has(domain.toLowerCase())) return WORKSPACE_TEXT
    const need = (missing || []).filter((k) => k !== 'directory')
    if (need.length) return `The Google sign-in lacks ${need.map((k) => SCOPE_TEXT[k].label).join(' and ')}: ${need.map((k) => SCOPE_TEXT[k].loses).join('; ')}. Sign in again and leave every box ticked on Google's consent page.`
    return null
  }

  let images = null
  /** The image cache of the signed-in account. */
  function imgCache() {
    const account = (S.state && S.state.account) || ''
    if (!images || images.account !== account) images = { account, cache: imageCache(path.join(ctx.dataDir, 'images'), account) }
    return images.cache
  }

  // ---- the view ----

  function rebuild() {
    S.view = S.state && ready_() ? buildView({ cfg: cfg(), state: S.state, names: S.names, verdicts: triageOn() ? S.verdicts : {}, marks: S.marks, now: now() }) : { lanes: [], unread: 0 }
    // The inbox-feed answers from the last view of a signed-in run, even once signed out or failing.
    if (S.state && ready_()) S.feedRows = feed.feedRows(S.view)
    try {
      ctx.badge(PANEL, S.view.unread || null)
    } catch (e) {
      ctx.log.warn('badge:', e.message)
    }
  }

  function triageOn() {
    return ctx.services.available('triage')
  }
  function annotateOn() {
    return !S.annotateMissing && ctx.services.available('reviewer')
  }

  // ---- polling ----

  /** Who is signed in and what was granted, once a run (and after each sign-in). */
  async function ensureAccount() {
    if (S.accountChecked) return
    const before = S.state.account
    const info = await checkAccount({ client: chat, state: S.state, signal: abort.signal, log: ctx.log })
    if (before && info.email && before !== info.email) {
      // Another Google account on the same client (a sign-in in another browser profile): start over.
      const keep = { account: S.state.account, me: S.state.me, meChecked: S.state.meChecked }
      resetAccount()
      Object.assign(S.state, keep)
    }
    await auth.setGrant({ missing: info.missing, email: info.email, sub: info.sub })
    S.accountChecked = true
    S.blocked = blockedBy(info.missing, info.email)
    if (info.missing && info.missing.includes('directory')) S.notes = [`${SCOPE_TEXT.directory.label} was not granted: ${SCOPE_TEXT.directory.loses}. Sign in again to grant it.`]
    if (S.blocked) ctx.log.warn(`signed in, but not polling: ${S.blocked}`)
  }

  /** Poll now unless a poll is running (then that one's promise). Never rejects. */
  function pollNow(reason, force = false) {
    if (S.polling) return S.polling
    if (!auth || S.stopped) return Promise.resolve()
    S.polling = (async () => {
      try {
        await ready
        if (!signedIn()) return
        let gen = S.gen
        await ensureAccount()
        // Another account on the same client starts over inside ensureAccount (and is checked): poll
        // that one. A sign out or a new client meanwhile (not checked): nothing to poll here.
        if (gen !== S.gen) {
          if (!S.accountChecked) return
          gen = S.gen
        }
        if (S.blocked) {
          rebuild()
          return
        }
        const startedAt = now()
        const r = await poll({ client: chat, cfg: cfg(), state: S.state, names: S.names, now: startedAt, signal: abort.signal })
        if (gen !== S.gen) return // signed out or another client meanwhile: not this account's lanes
        // Marks done before this poll began are now Chat's own state: the guesses go.
        for (const [id, m] of Object.entries(S.marks)) if (m.state === 'done' && m.doneAt <= startedAt) delete S.marks[id]
        S.spaceErrors = r.stats.errors
        S.notes = [...r.stats.notes]
        const g = auth.status().grant
        if (g && g.missing && g.missing.includes('directory')) S.notes.push(`${SCOPE_TEXT.directory.label} was not granted: ${SCOPE_TEXT.directory.loses}.`)
        S.error = null
        rebuild()
        for (const e of r.stats.errors) ctx.log.warn(`reading ${e.space} failed: ${e.message}`)
        for (const n of r.stats.notes) ctx.log.warn(n)
        await saveState()
        ctx.log.info(`poll (${reason}${force ? ', forced' : ''}): ${r.stats.spaces} spaces, ${r.stats.checked} checked, ${r.stats.read} read`)
        if (r.busy) failed(reason, r.busy)
        else if (S.backoffMinutes) {
          S.backoffMinutes = 0
          reschedule()
        }
        postState()
        await classifyChanged()
      } catch (e) {
        failed(reason, e)
      } finally {
        S.polling = null
        postState()
        emitFeed()
        if (S.pollAgain && !S.stopped) {
          S.pollAgain = false
          void pollNow('after a mark', true)
        }
      }
    })()
    postState()
    return S.polling
  }

  function failed(reason, e) {
    if (e instanceof AuthError && (e.kind === 'invalidGrant' || e.kind === 'signedOut')) {
      // The panel shows the sign-in again, with the reason; not an error notice on top of it.
      S.error = null
      rebuild()
      ctx.log.warn(`poll (${reason}): signed out (${e.kind})`)
      return
    }
    if (e && e.kind === 'workspace') {
      S.blocked = WORKSPACE_TEXT
      S.error = null
      rebuild()
      ctx.log.warn(`poll (${reason}): ${WORKSPACE_TEXT}`)
      return
    }
    if (e && e.kind === 'scope') {
      // A grant without a scope Chat needs (seen only by a call): ask the token info again next poll.
      S.accountChecked = false
    }
    if (isBusy(e)) {
      S.backoffMinutes = Math.min(BACKOFF_MAX_MINUTES, (S.backoffMinutes || cfg().pollMinutes) * 2)
      reschedule()
      S.error = `${e.message} (every ${S.backoffMinutes} min for now).`
    } else {
      S.error = e && e.message ? e.message : String(e)
    }
    ctx.log.error(`poll (${reason}) failed: ${S.error}`)
  }

  let stopSchedule = null
  let scheduledMinutes = 0
  function reschedule() {
    if (tooOld) return
    const minutes = S.backoffMinutes || cfg().pollMinutes
    if (stopSchedule && minutes === scheduledMinutes) return
    if (stopSchedule) stopSchedule()
    scheduledMinutes = minutes
    // The tick only starts a poll and returns: a first poll can outlast ctx.schedule's 60 s per
    // run, and pollNow already keeps polls from overlapping.
    stopSchedule = ctx.schedule(minutes * 60, () => {
      void pollNow('schedule')
    })
  }
  reschedule()
  // Not inside activate: the poll ends in a triage call, and a service call during activate can
  // close a cycle (`ccc guide api`, Cycles).
  const firstPoll = tooOld ? null : (io.setTimeout || setTimeout)(() => void pollNow('start'), io.firstPollMs === undefined ? 1500 : io.firstPollMs)

  // ---- triage ----

  /**
   * Classify the rows whose triage item changed since they were judged (or `force`d by a triage
   * `change` event). One at a time: an event during a classify waits for it.
   */
  function classifyChanged(force = new Set()) {
    S.classifying = S.classifying.then(async () => {
      if (!triageOn() || !ready_()) {
        S.triageError = null
        return
      }
      const rows = allRows(S.view)
      const items = rows.map((r) => triageItem(r, cfg().triageText, S.names, me()))
      const ids = new Set(items.map((i) => i.id))
      const todo = items.filter((it) => force.has(it.id) || S.sigs[it.id] !== hashOf(it))
      // Forget verdicts of rows no longer shown (bounded by what the lanes hold).
      for (const k of Object.keys(S.verdicts)) if (!ids.has(k)) delete S.verdicts[k]
      for (const k of Object.keys(S.sigs)) if (!ids.has(k)) delete S.sigs[k]
      if (!todo.length) return
      try {
        for (let i = 0; i < todo.length; i += TRIAGE_CHUNK) {
          const chunk = todo.slice(i, i + TRIAGE_CHUNK)
          const { results } = await triage.classify(SOURCE, chunk)
          for (const it of chunk) {
            const v = results && results[it.id]
            if (v && !v.error && v.priority) {
              S.verdicts[it.id] = { priority: v.priority, kind: v.kind || null, confidence: typeof v.confidence === 'number' ? v.confidence : 1, by: v.by || '' }
              S.sigs[it.id] = hashOf(it)
            } else if (v && v.error) {
              ctx.log.warn(`triage of ${it.id}: ${v.error}`)
            }
          }
        }
        S.triageError = null
      } catch (e) {
        // jev-triage's own message (jev missing, a cap reached): the person reads it as is.
        S.triageError = e && e.message ? e.message : String(e)
        ctx.log.warn('triage:', S.triageError)
      }
      await saveTriage()
      rebuild()
      postState()
    })
    return S.classifying
  }

  // After a rescore, a correction or a jev-triage settings change: judge those ids again.
  triage.on('change', (data) => {
    if (!data || data.source !== SOURCE) return
    const force = new Set()
    if (data.ids === null || data.ids === undefined) S.sigs = {}
    else for (const id of data.ids) force.add(String(id))
    void classifyChanged(force)
  })

  // ---- settings ----

  ctx.onSettingsChange(async () => {
    S.settings = readSettings(ctx.settings.project)
    if (!auth) return postState()
    try {
      await ready
      // A different client id signs out (design): its refresh token is deleted in auth.js.
      if (await auth.settingsChanged(cfg())) resetAccount()
    } catch (e) {
      ctx.log.warn(`applying the settings failed: ${e.message}`)
    }
    reschedule()
    rebuild()
    emitFeed() // a lane switched off or a shorter Recent: those items are gone now
    postState()
    if (signedIn()) void pollNow('settings', true)
  })

  // ---- sign-in ----

  /** The browser sign-in, started from the panel or `ccc chat login`; it settles in the background. */
  function startSignIn(from) {
    if (!auth) return { error: tooOld }
    if (!auth.client()) return { error: 'No OAuth client yet: paste the client file in the Google Chat panel, or ccc chat client <file.json>.' }
    // Already open: start over (the panel's "Start over", a second `ccc chat login`). The stuck case
    // is Google's error page ("Access blocked"), which never comes back to the app.
    const restarted = auth.status().signingIn
    void (async () => {
      try {
        const r = await auth.signIn()
        // A new sign-in may be another Google account: nothing of the last one carries over.
        resetAccount()
        emitFeed() // Inbox hears the sign-in at once (a sync), not with the first poll
        setNotice(r.sessionOnly ? `Signed in, but only until the app closes: ${r.sessionOnly}. Fix the keychain (ccc guide settings-secrets) and sign in again to stay signed in.` : 'Signed in with Google. Reading your Chat…', r.sessionOnly ? 'error' : 'info')
        ctx.log.info(`signed in (${from})`)
        // A poll of the old account may be running (its result is thrown away): then this one's
        // promise is that poll, and the new account gets its own right after.
        const stale = Boolean(S.polling)
        await pollNow('signin', true)
        if (stale && !S.blocked) await pollNow('signin', true)
        if (S.blocked) setNotice(S.blocked, 'error')
        else if (S.state && S.state.account && !r.sessionOnly) setNotice(`Signed in as ${S.state.account}.`)
      } catch (e) {
        // Replaced by a newer sign-in: that one reports, this one says nothing.
        if (e && e.kind === 'superseded') return
        setNotice(e && e.message ? e.message : String(e), 'error')
      }
    })()
    postState()
    return { message: `${restarted ? 'Started over: the open sign-in is cancelled. ' : ''}Your browser opens the Google sign-in: finish it there (it gives up after 5 minutes). ccc chat status shows the result.` }
  }

  async function signOut() {
    if (!auth) return { message: tooOld }
    await ready
    await auth.signOut()
    resetAccount()
    emitFeed() // signedOut, with the last items
    postState()
    return { message: 'Signed out: the stored Google sign-in of this project is deleted.' }
  }

  async function pasteClient(text) {
    if (!auth) return { ok: false, error: tooOld }
    await ready
    const r = await auth.pasteClient(text)
    if (!r.ok) {
      S.clientError = r.error
      postState()
      return r
    }
    S.clientError = null
    if (r.changed) resetAccount()
    const saved = `Client saved (${shortClientId(r.clientId)})`
    if (!r.changed) {
      setNotice(`${saved}; it is the client already in use.`)
      return { ok: true, message: `${saved}; it is the client already in use.` }
    }
    setNotice(`${saved}. Next: Sign in with Google.`)
    return { ok: true, message: `${saved}. Next: ccc chat login.` }
  }

  async function removeClient() {
    await ready
    const r = await auth.removeClient()
    if (!r.ok) return setNotice(r.error, 'error')
    if (r.changed) resetAccount()
    setNotice(auth.client() ? 'The pasted client is removed; the client from the settings is used.' : 'The pasted client is removed.')
  }

  // ---- marks (the only writes) ----

  /** The row of an id in the current view, or null. */
  function rowOf(id) {
    const rows = allRows(S.view)
    // A conversation inside an alert group has no row of its own in the panel, but it is an item of the
    // inbox-feed (open, mark read), so it is found through its group.
    return rows.find((x) => x.id === id) || rows.flatMap((x) => x.convRows || []).find((x) => x.id === id) || null
  }

  function labelOf(id) {
    const r = rowOf(id)
    if (!r) return 'the conversation'
    return r.kind === 'alert' ? `the alert "${cut(r.group.name, 60)}"` : `"${cut(oneLine(r.title), 60)}"`
  }

  /**
   * Mark a row read or unread in Chat (design "Read state"): the row changes at once, the space's
   * read time moves (lib/readstate.js), a failure puts the row back and says why. Resolves
   * `{ message }` or `{ error }`; never rejects. `quiet`: no notice on success (mark read on open).
   */
  async function markRow(id, want, { quiet = false } = {}) {
    await ready
    if (!ready_()) return { error: auth ? auth.status().signedOutReason || S.blocked || 'Not signed in to Google.' : tooOld }
    const row = rowOf(id)
    if (!row) return { error: `${id} is not among the last poll's conversations: refresh, then try again.` }
    const label = labelOf(id)
    if (want === 'read' && !row.unread) return { message: `${label} is read already.` }
    if (want === 'unread' && row.unread) return { message: `${label} is unread already.` }
    if (want === 'unread' && row.kind === 'alert') return { error: 'An alert row is unread by nature; mark a conversation unread instead.' }
    if (!row.target) return { error: NO_TARGET_TEXT }
    if (S.marks[id] && S.marks[id].state === 'pending') return { message: `${label}: a mark is still on its way.` }
    const target = { ...row.target }
    S.marks[id] = { want, state: 'pending' }
    rebuild()
    postState()
    emitFeed()
    try {
      const r = await applyMark(chat, target, want, abort.signal)
      S.marks[id] = { want, state: 'done', doneAt: now() }
      // The next poll checks those spaces again and replaces the guess with Chat's state.
      for (const sp of Object.keys(target)) S.state.marked[sp] = now()
      await saveState()
      rebuild()
      postState()
      emitFeed()
      ctx.log.info(`marked ${id} ${want} (${r.changed.length} space read time${r.changed.length === 1 ? '' : 's'} moved)`)
      if (S.polling) S.pollAgain = true
      else void pollNow('mark', true)
      const message = `Marked ${label} ${want} in Google Chat.`
      if (!quiet) setNotice(message)
      return { message }
    } catch (e) {
      delete S.marks[id]
      rebuild()
      emitFeed()
      const why = e && e.message ? e.message : String(e)
      if (e && e.kind === 'scope') S.accountChecked = false
      const text = `Could not mark ${label} ${want} in Google Chat: ${why}. It is shown as before.`
      ctx.log.warn(`marking ${id} ${want} failed: ${why}`)
      setNotice(text, 'error')
      return { error: text }
    }
  }

  // ---- conversations for the actions ----

  /**
   * A conversation (or an alert group's messages) read fresh, for the view, `show` and Discuss:
   * `{ id, title, where, messages (raw, any order), note, key, facts, row, senderOf, isUnread, nameOf }`.
   */
  async function loadConversation(id, signal) {
    await ready
    if (!ready_()) throw new Error(auth ? auth.status().signedOutReason || S.blocked || 'Not signed in to Google.' : tooOld)
    const which = rowId(id)
    if (!which) throw new Error('not a conversation id')
    const row = rowOf(id)
    const self = me()
    let raws
    let note = ''
    let title
    let where
    let key
    let facts
    if (which.alert) {
      if (!row || row.kind !== 'alert') throw new Error('that alert is no longer in the Alerts lane (refresh?)')
      const g = row.group
      // The alert messages of the last poll (design), shaped as Chat messages for the document.
      raws = g.messages.map((m) => ({ name: m.id, createTime: m.at, text: m.text, sender: { name: m.sender, type: m.bot ? 'BOT' : 'HUMAN', displayName: m.senderName } }))
      title = groupTitle(g)
      where = g.spaces.map((s) => s.title || 'a space').join(', ')
      note = `${g.count} alert message${g.count === 1 ? '' : 's'} of the last poll${g.spaces.length > 1 ? `, from ${g.spaces.length} spaces` : ''}`
      key = `chat:alert:${sha(g.name, 16)}`
      facts = { space: where, kind: 'alert', unread: g.count }
    } else {
      const page = await chat.messages(which.space, { pageSize: which.thread ? THREAD_PAGE : CHAT_PAGE, thread: which.thread || null }, signal || abort.signal)
      raws = page.messages
      if (!raws.length) throw new Error('this conversation has no messages')
      if (page.more) note = `Older messages are not shown (the newest ${raws.length}).`
      key = `chat:${id}`
    }
    const compact = raws.map(compactMessage)
    S.names.learn(compact)
    // Names nobody gave yet: one lookup (its failure only leaves "unknown user").
    const ids = unique(compact.flatMap((m) => [m.bot ? '' : m.sender, ...m.mentions])).filter((u) => u && u !== self)
    await lookUp(S.names, ids, (chunk, sig) => chat.people(chunk, sig), signal || abort.signal).catch(() => null)
    const byName = new Map(compact.map((m) => [m.id, m]))
    const senderOf = (raw) => senderLabel(byName.get(raw.name) || compactMessage(raw), S.names, self)
    const nameOf = (u) => (u === self ? 'you' : S.names.get(u))
    // Unread: the row's new messages, and those of others from the first of them on (old connector).
    const newIds = new Set(row && row.unread && row.kind === 'conv' ? row.conv.new.map((m) => m.id) : row && row.kind === 'alert' ? row.group.messages.map((m) => m.id) : [])
    const firstNew = row && row.unread && row.kind === 'conv' && row.conv.new.length ? row.conv.new[0].at : null
    const isUnread = (raw) => {
      if (newIds.has(raw.name)) return true
      const m = byName.get(raw.name)
      return Boolean(firstNew && m && !(self && m.sender === self) && T.compare(m.at, firstNew) >= 0)
    }
    if (!which.alert) {
      const sp = S.state.spaces[which.space] || null
      const conv = row && row.kind === 'conv' ? row.conv : { kind: which.thread ? 'thread' : 'space', context: [], new: [], latest: compact[compact.length - 1] }
      const kind = sp ? (sp.type === 'DIRECT_MESSAGE' ? 'dm' : sp.type === 'GROUP_CHAT' ? 'group' : which.thread ? 'thread' : 'space') : conv.kind
      const convFor = { ...conv, kind, context: compact, new: [], latest: compact[compact.length - 1] }
      where = spaceLabel(sp, convFor, S.names, self)
      const sorted = [...compact].sort((a, b) => T.compare(a.at, b.at))
      const start = sorted.find((m) => !m.reply) || sorted[0]
      title = row ? row.title : which.thread ? titleLine({ ...start, text: shownText(start, S.names, self) }) : where
      const people = unique(sorted.filter((m) => !(self && m.sender === self)).map((m) => senderLabel(m, S.names, self)))
      facts = { space: where, kind, threading: sp ? sp.threading : '', members: sp ? sp.members : null, unread: raws.filter(isUnread).length, people }
    }
    return { id, title, where, messages: raws, note, key, facts, row, senderOf, isUnread, nameOf, alert: Boolean(which.alert) }
  }

  /** The conversation as HTML plus the image assets (downloaded, waited for at most WAIT_MS). */
  async function conversationView(t, withAside) {
    const pics = t.messages.flatMap(pictureParts)
    const { wanted } = selectImages(pics)
    let assets = []
    let byKey = new Map()
    if (wanted.length) {
      const r = await gatherImages({
        wanted,
        download: (img, signal) => chat.media(img.resourceName, { maxBytes: MAX_IMAGE_BYTES, signal: signal || abort.signal, timeoutMs: IMAGE_TIMEOUT_MS }),
        cache: imgCache(),
        waitMs: io.imageWaitMs === undefined ? WAIT_MS : io.imageWaitMs,
        signal: abort.signal,
      })
      assets = r.assets
      byKey = r.byKey
      for (const f of r.failed) ctx.log.warn(`image ${f.name}: ${f.message}`)
      if (r.late) ctx.log.info(`${r.late} image(s) not downloaded in time, listed by name (cached for the next open)`)
    }
    const doc = conversationDocument({ title: t.title, messages: t.messages, senderOf: t.senderOf, nameOf: t.nameOf, isUnread: t.isUnread, assets: byKey, note: t.note, facts: t.facts, aside: Boolean(withAside) })
    return { html: doc.html, assets, aside: doc.aside }
  }

  function setNotice(text, kind = 'info') {
    S.notice = { text: cut(oneLine(text), 600), kind }
    postState()
  }

  /** Mark read on open (`markReadOnOpen`): once the view is up, an unread row with a target. */
  function markOnOpen(id) {
    const r = rowOf(id)
    if (!cfg().markReadOnOpen || !r || !r.unread || !r.target) return
    void markRow(id, 'read', { quiet: true })
  }

  function textOf(t) {
    return readableText({ title: t.title, where: t.where, messages: t.messages, note: t.note, senderOf: t.senderOf, isUnread: t.isUnread, nameOf: t.nameOf, me: me() })
  }

  /** Close an overlay handle that is not needed; a throw here must not mask the error it runs beside. */
  function closeQuietly(handle) {
    try {
      handle.close?.()
    } catch {}
  }

  /**
   * Open: the conversation as clean HTML with its pictures in the reviewer, else as plain text in the
   * reviewer (a reviewer whose annotate takes text only), else in our own page. The chain, each step
   * taken once a call proved the one before is not there (as bronos.gmail):
   *   annotate({ html, assets, aside }) -> rejected (not "no method") -> annotate({ text })
   *   -> "no method annotate" or no reviewer -> panels/thread.html with the same HTML.
   * No `url` goes to annotate: there is no "open in Chat" (design, answer 2).
   * The reviewer's overlay is up before the conversation is read (its prepare, where it has one):
   * reading the messages, the names and the pictures takes seconds, with nothing on screen meanwhile
   * (real-work feedback 8). The annotate below fills that overlay; whatever else happens (a failed
   * read, our own reader page) closes it in the finally.
   * `onStarted` (feed act) runs only once something is on screen: the prepared overlay, our reader
   * page, or (neither: a reviewer without prepare, a prepare that failed or ran past its wait) the
   * filled view at the end. Called earlier, a failed read reached only this panel's notice while
   * the person clicked in Inbox, and Inbox ended the item's "back" mark for an open never seen.
   */
  async function openConversation(id, onStarted) {
    const shown = () => {
      if (onStarted) onStarted()
    }
    const pre = await prepareView(id)
    // Without the reviewer our own reader page is the overlay, so it is up before the conversation is
    // read (`ready: 'manual'`: its loader stays until the page has drawn the conversation).
    const early = pre || annotateOn() ? null : startReader(id, (viewKeyOf(id) || {}).title)
    // Our page counts once main did not refuse it (a refused one fails the open in plainReader).
    if (pre) shown()
    else if (early) void early.refusal.then((e) => e || shown())
    try {
      await showConversation(id, pre, early, shown)
    } finally {
      if (pre) await cancelView(pre)
      if (early && !early.used) closeQuietly(early.handle)
    }
  }

  /**
   * The `inbox-item` type of a conversation overlay (Inbox's and the buttons' key), or none for an
   * alert group row (it shows several conversations and is no feed item).
   */
  function overlayType(id) {
    const which = rowId(id)
    return which && !which.alert ? { name: 'inbox-item', data: { source: ctx.pluginId, id } } : null
  }

  /**
   * The feed item an `inbox-item` overlay of ours names, or null (the data came from the opener: check it).
   * Only a conversation still in the feed counts: one that left it is no item Inbox shows, so its
   * overlay gets no buttons, as `act` refuses it.
   */
  function ownItem(info) {
    if (!info || !trustedOpener(info.opener)) return null
    const d = info.type && info.type.data
    if (!d || typeof d !== 'object' || d.source !== ctx.pluginId || typeof d.id !== 'string') return null
    return feedItemOf(d.id)
  }

  /**
   * Whether an overlay's opener may get our item buttons: we (the reader page) or the reviewer we hand
   * the item to. `opener` is the app's record of who opened it (OverlayInfo), unlike `data`: another
   * plugin opening an overlay that names one of our conversations gets none of our item buttons.
   */
  function trustedOpener(opener) {
    if (opener === ctx.pluginId) return true
    const reviewer = reviewerId()
    return typeof reviewer === 'string' && reviewer !== '' && opener === reviewer
  }

  /**
   * The plugin our `reviewer` calls reach right now, asked at button time (the project's pick can
   * change while we run), or null when none does. An older app without ctx.services.provider: the
   * bundled reviewer. A throw (not expected: `reviewer` is in our uses) trusts no reviewer.
   */
  function reviewerId() {
    if (typeof ctx.services.provider !== 'function') return FALLBACK_REVIEWER_ID
    try {
      return ctx.services.provider('reviewer')
    } catch {
      return null
    }
  }

  /**
   * The item's actions but open, with `run` = the same code as the feed's `act`; labels follow the item's state.
   * A refused act goes to the panel's notice and is thrown: the app only logs a run that throws, and
   * an answer it does not read would make a failed Mark read silent.
   */
  function overlayButtons(info) {
    const item = ownItem(info)
    if (!item) return []
    const run = async (action) => {
      const r = await feedAct(item.id, action)
      if (r && r.ok === false) {
        setNotice(r.message, 'error')
        throw new Error(r.message)
      }
    }
    return item.actions.filter((a) => a.id !== 'open').map((a) => ({ id: a.id, label: a.label, run: () => run(a.id) }))
  }

  /**
   * What Discuss with Claude sends for a conversation overlay: its latest messages, capped (the end
   * of the text is the newest); the feed's preview when the read fails.
   */
  async function overlayDiscuss(id) {
    const item = feedItemOf(id)
    if (!item) return null
    try {
      const t = await loadConversation(id)
      const text = textOf(t)
      return { text: `Conversation: ${item.title}\n${text.length > DISCUSS_MAX ? text.slice(-DISCUSS_MAX) : text}` }
    } catch (e) {
      ctx.log.warn(`discuss text of ${id}: ${e && e.message ? e.message : e}`)
      return { text: cut([`Conversation: ${item.title}`, item.preview || ''].filter(Boolean).join('\n'), DISCUSS_MAX) }
    }
  }

  if (ctx.overlay && typeof ctx.overlay.buttons === 'function') {
    // Dropped by the app when the plugin stops.
    ctx.overlay.buttons('inbox-item', (info) => overlayButtons(info))
  }

  /** Resolves null once an overlay is up (no refusal within OVERLAY_SETTLE_MS, or it already ended), else main's refusal. */
  function overlayRefusal(handle) {
    let timer
    const wait = new Promise((resolve) => (timer = setTimeout(resolve, OVERLAY_SETTLE_MS, null)))
    return Promise.race([handle.result.then(() => null, (e) => e || new Error('refused')), wait]).finally(() => clearTimeout(timer))
  }

  /** `p`, or a rejection after `ms`: a service call has no timeout of its own. */
  function within(p, ms) {
    let timer
    return Promise.race([p, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('the reviewer did not answer in time')), ms)))]).finally(() => clearTimeout(timer))
  }

  /**
   * The reviewer key and title of a row before it is read, the ones loadConversation and the annotate
   * give it (`chat:<id>`, `chat:alert:<hash>`), or null.
   */
  function viewKeyOf(id) {
    const which = rowId(id)
    if (!which) return null
    const row = rowOf(id)
    if (!which.alert) return { key: `chat:${id}`, title: (row && row.title) || '' }
    if (!row || row.kind !== 'alert') return null
    return { key: `chat:alert:${sha(row.group.name, 16)}`, title: groupTitle(row.group) }
  }

  /**
   * Opens the reviewer's overlay of a row now, with its loader: `{ key }` when it did, else null (no
   * reviewer with annotate, or one without prepare, which rejects with "has no method": the overlay
   * then comes with the annotate, as before).
   */
  async function prepareView(id) {
    if (!annotateOn()) return null
    const v = viewKeyOf(id)
    if (!v) return null
    try {
      // The type goes with prepare: the reviewer fixes an overlay's type when it starts, so the
      // annotate that fills a prepared overlay cannot add it later (an older reviewer ignores it).
      const type = overlayType(id)
      await within(reviewer.prepare({ key: v.key, title: cut(oneLine(v.title), 200) || '(no text)', ...(type ? { type } : {}) }), REVIEWER_WAIT_MS)
      return { key: v.key }
    } catch {
      return null
    }
  }

  /** Closes a prepared overlay no annotate filled; a no-op once one did. */
  async function cancelView(pre) {
    await within(reviewer.cancel({ key: pre.key }), REVIEWER_WAIT_MS).catch((e) => ctx.log.warn(`reviewer.cancel: ${e && e.message ? e.message : e}`))
  }

  async function showConversation(id, pre, early, shown = () => {}) {
    const t = await loadConversation(id)
    // Marked read only once the conversation is on screen: annotate also resolves, with
    // { opened: false }, when the person closed the loader during the read, and nothing is shown then
    // (phase-1 review round 4).
    const seen = () => {
      shown()
      markOnOpen(id)
    }
    const opened = (r) => !(r && r.opened === false)
    if (annotateOn()) {
      const pick = pickTab(await ctx.sessions.list().catch(() => []))
      const type = overlayType(id)
      // An older reviewer ignores `type`.
      const base = { title: cut(oneLine(t.title), 200) || '(no text)', key: t.key, ...(pick.tabId ? { tabId: pick.tabId } : {}), ...(type ? { type } : {}) }
      let htmlError = null
      if (!S.htmlRejected) {
        const v = await conversationView(t, true)
        try {
          // Newest messages last: open at the end (reviewer `start`, app 0.9.4; an older one ignores it).
          const r = await reviewer.annotate({ ...base, start: 'end', html: v.html, ...(v.aside ? { aside: v.aside } : {}), ...(v.assets.length ? { assets: v.assets } : {}) })
          if (opened(r)) seen()
          return
        } catch (e) {
          if (isMissingAnnotate(e)) noAnnotate()
          else {
            htmlError = e && e.message ? e.message : String(e)
            ctx.log.info(`reviewer refused the html of ${id} (${htmlError}); trying text`)
          }
        }
      }
      if (!S.annotateMissing) {
        try {
          const r = await reviewer.annotate({ ...base, text: cut(textOf(t), 400000) })
          if (htmlError) {
            S.htmlRejected = htmlError
            ctx.log.info('reviewer.annotate takes text only: using text for this run')
            postState()
          }
          if (opened(r)) seen()
          return
        } catch (e) {
          if (!isMissingAnnotate(e)) return setNotice(`The reviewer could not open the conversation: ${e.message}${htmlError && htmlError !== e.message ? ` (html: ${htmlError})` : ''}`, 'error')
          noAnnotate()
        }
      }
    }
    // Our own page instead of the reviewer's: its loader goes first (it cannot show this page).
    if (pre) await cancelView(pre)
    await plainReader(id, t, await conversationView(t, false), early, shown, seen)
  }

  function noAnnotate() {
    S.annotateMissing = true
    ctx.log.info("reviewer has no annotate (or none is enabled): using the plugin's reader page")
    postState()
  }

  /**
   * Starts the reader page's overlay (before the conversation is read when it can); null when start
   * throws. `refusal` resolves null once the page is up (OVERLAY_SETTLE_MS without a rejection, or the
   * person closed it), else main's refusal; `ended` turns true once the overlay ended.
   */
  function startReader(id, title) {
    const type = overlayType(id)
    try {
      const handle = ctx.overlay.start({ kind: 'html', file: 'panels/thread.html', title: cut(oneLine(title || ''), 100) || 'Google Chat', size: 'large', ready: 'manual', ...(type ? { type } : {}) })
      if (type && typeof handle.onDiscuss === 'function') handle.onDiscuss(() => overlayDiscuss(id))
      const started = { handle, used: false, ended: false, refusal: overlayRefusal(handle) }
      const end = () => (started.ended = true)
      handle.result.then(end, end)
      return started
    } catch (e) {
      setNotice(`Cannot open the reader: ${e.message}`, 'error')
      return null
    }
  }

  /**
   * Without the reviewer's annotate: our own read-only page with Discuss and New session. It gets the
   * same HTML in parts, then one message per image, so no message passes the page limit. A link click
   * in the page comes back as `{ open }` and opens only a link this host put into the document.
   */
  async function plainReader(id, t, v, early, shown = () => {}, seen = shown) {
    const started = early || startReader(id, t.title)
    if (!started) return
    started.used = true
    // start() returns a handle even for an overlay main refuses; the refusal only rejects `result`.
    const refused = await started.refusal
    if (refused) return setNotice(`Cannot open the reader: ${refused.message}`, 'error')
    // On screen now; the wait below lasts until the person closes the page (feed act answers here).
    shown()
    const handle = started.handle
    const parts = []
    for (let i = 0; i < v.html.length; i += PAGE_HTML_PART) parts.push(v.html.slice(i, i + PAGE_HTML_PART))
    let posted = false
    try {
      handle.post({ type: 'doc', title: t.title, parts: parts.length, assets: v.assets.length })
      parts.forEach((part, i) => handle.post({ type: 'html', i, part }))
      for (const a of v.assets) handle.post({ type: 'asset', id: a.id, dataUrl: a.dataUrl })
      posted = true
    } catch (e) {
      ctx.log.warn(`posting to the reader: ${e.message}`)
      // ready: 'manual' means the page never draws, so never says ready, and the loader would stay.
      setNotice(`Cannot show the conversation: ${e.message}`, 'error')
      closeQuietly(handle)
    }
    // Read only when the conversation reached a page still open: a post after the person closed the
    // loader is a silent no-op, so they never saw it.
    if (posted && !started.ended) seen()
    // The links the page may ask to open: the ones this host put into the document (http(s) only,
    // normalised by URL as the page's a.href is). The guide's rule for ctx.openExternal: a URL the
    // host chose, never one taken from the page as is.
    const links = new Set([...v.html.matchAll(/<a href="([^"]*)"/g)].map((x) => decode(x[1])).filter((u) => /^https?:\/\//i.test(u)))
    handle.onMessage((m) => {
      if (m && typeof m.open === 'string' && links.has(m.open)) void openUrl(m.open)
    })
    const res = await handle.result.catch((e) => {
      setNotice(`The reader failed: ${e.message}`, 'error')
      return null
    })
    const action = res && res.kind === 'value' && res.value && typeof res.value === 'object' ? res.value.action : null
    if (action === 'discuss') await discuss(id)
    else if (action === 'newSession') await newSession(id)
  }

  async function conversationPrompt(id) {
    const t = await loadConversation(id)
    return discussPrompt(t.title, t.where, textOf(t))
  }

  async function discuss(id, tabId) {
    const pick = pickTab(await ctx.sessions.list(), tabId)
    if (pick.error) return setNotice(pick.error, 'error')
    if (pick.choose) {
      S.choose = { id, label: labelOf(id), tabs: pick.choose }
      return postState()
    }
    S.choose = null
    const prompt = await conversationPrompt(id)
    const r = await ctx.sessions.send(pick.tabId, prompt)
    setNotice(r && r.delivered ? `Sent ${labelOf(id)} to "${pick.label}".` : `Queued for "${pick.label}": it gets ${labelOf(id)} when Claude is waiting for input.`)
  }

  async function newSession(id) {
    const prompt = await conversationPrompt(id)
    // The person clicked New session: the window shows the tab (an older app ignores `focus`).
    await ctx.sessions.open({ prompt, focus: true })
    setNotice(`Opened a new Claude tab about ${labelOf(id)}.`)
  }

  /**
   * An http(s) address in the person's browser (a setup link, a link inside a message in the reader
   * page), with ctx.openExternal. When the app refuses (its limit is 3 a 10 s), the address is shown
   * so it can be copied.
   */
  async function openUrl(url) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return setNotice(`Only web links open from here; the address: ${cut(String(url), 300)}`)
    try {
      await ctx.openExternal(url)
    } catch (e) {
      setNotice(`Could not open the browser (${e && e.message ? e.message : e}). The address: ${url}`, 'error')
    }
  }

  async function wrong(id, priority) {
    if (!['urgent', 'action', 'fyi', 'noise'].includes(priority)) return
    await triage.override(SOURCE, id, { priority })
    delete S.sigs[id]
    await classifyChanged(new Set([id]))
    setNotice(`${labelOf(id)} is now ${priority} (your correction). Record why with Wrong? in the Jev triage panel, so it becomes a case for its eval.`)
  }

  async function undoWrong(id) {
    const had = await triage.clear(SOURCE, id)
    delete S.sigs[id]
    await classifyChanged(new Set([id]))
    setNotice(had ? `${labelOf(id)}: your correction is gone.` : `${labelOf(id)} had no correction.`)
  }

  // ---- panel ----

  function stateMessage() {
    const a = auth ? auth.status() : null
    const tOn = triageOn()
    const st = S.settings
    return {
      type: 'state',
      tooOld,
      // The setup guide while there is no sign-in; the page draws the steps and asks for the links.
      auth: a
        ? {
            client: a.client ? { source: a.client.source, id: a.client.id } : null,
            pasted: a.pasted,
            pastedBroken: a.pastedBroken,
            settingsMissing: a.settingsMissing,
            signedIn: a.signedIn,
            sessionOnly: a.sessionOnly,
            signingIn: a.signingIn,
            signedOutReason: a.signedOutReason,
          }
        : null,
      blocked: S.blocked,
      steps: STEPS,
      clientError: S.clientError,
      problems: st.problems,
      account: (S.state && S.state.account) || '',
      scope: feed.scopeLine(cfg()),
      meKnown: Boolean(me()),
      lastPoll: (S.state && S.state.lastPoll) || 0,
      polling: Boolean(S.polling),
      error: S.error,
      notes: S.notes,
      spaceErrors: S.spaceErrors.slice(0, 5),
      triage: { on: tOn, error: tOn ? S.triageError : null },
      annotate: annotateOn(),
      markReadOnOpen: cfg().markReadOnOpen,
      notice: S.notice,
      choose: S.choose,
      unread: S.view.unread,
      lanes: S.view.lanes.map((l) => ({
        id: l.id,
        title: l.title,
        collapsed: Boolean(S.ui.collapsed[l.id]),
        // Only the rows the panel draws are sent: `limit` from the setting, all (capped) after Show all.
        expanded: Boolean(S.ui.expanded[l.id]),
        limit: cfg().rowsPerLane,
        total: l.rows.length,
        rows: l.rows.slice(0, S.ui.expanded[l.id] ? ROWS_PER_LANE : cfg().rowsPerLane).map(rowJson),
      })),
    }
  }

  function rowJson(r) {
    return {
      id: r.id,
      kind: r.kind,
      lane: r.lane,
      title: cut(r.title, 300),
      sub: cut(r.sub || '', 400),
      from: cut(r.from || '', 120),
      at: r.at,
      unread: r.unread,
      count: r.count,
      verdict: r.verdict,
      mentioned: r.mentioned,
      // Mark read / Mark unread (design "Read state"): offered when Chat's API can move it.
      canRead: Boolean(r.unread && r.target),
      canUnread: Boolean(!r.unread && r.target && r.kind !== 'alert'),
      noTarget: !r.target,
      pending: r.pending,
      ...(r.kind === 'alert' ? { firing: r.group.firing } : {}),
    }
  }

  function postState() {
    if (S.stopped) return
    try {
      ctx.panels.post(PANEL, stateMessage())
    } catch (e) {
      ctx.log.warn('panel post:', e.message)
    }
    setHeader()
  }

  // ---- the title bar ----

  let lastHeader = ''
  function setHeader() {
    if (tooOld || S.stopped) return
    const spec = headerSpec({ ready: ready_(), polling: Boolean(S.polling), lastPoll: (S.state && S.state.lastPoll) || 0, account: (S.state && S.state.account) || '' }, now())
    // Every state message calls this (a click, a triage answer): unchanged headers are not resent.
    const json = JSON.stringify(spec)
    if (json === lastHeader) return
    lastHeader = json
    try {
      ctx.panels.header(PANEL, spec)
    } catch (e) {
      ctx.log.warn('panel header:', e.message)
    }
  }
  if (!tooOld) {
    ctx.panels.onAction(PANEL, (id) => {
      if (id === 'refresh') void pollNow('header', true)
    })
  }
  // "just now" turns into "5 min ago" with nothing else happening.
  const headerTimer = tooOld ? null : (io.setInterval || setInterval)(setHeader, 60000)

  ctx.panels.onMessage(PANEL, async (m) => {
    if (!m || typeof m !== 'object') return
    try {
      switch (m.type) {
        case 'hello':
          await ready
          return postState()
        case 'refresh':
          return void pollNow('panel', true)
        case 'toggle':
        case 'expand':
          if (typeof m.lane === 'string' && LANE_IDS.includes(m.lane)) {
            const k = m.type === 'toggle' ? 'collapsed' : 'expanded'
            S.ui[k][m.lane] = !S.ui[k][m.lane]
            ctx.storage.set('ui', S.ui).catch(() => {})
            return postState()
          }
          return
        case 'dismiss':
          S.notice = null
          S.choose = null
          S.clientError = null
          return postState()
        case 'link': {
          // A setup link: the page names it, the URL is ours (setup.js).
          const url = linkUrl(m.id)
          if (url) await openUrl(url)
          return
        }
        case 'client':
          if (typeof m.text === 'string') await pasteClient(m.text)
          return
        case 'removeClient':
          return await removeClient()
        case 'signIn': {
          const r = startSignIn('panel')
          if (r.error) setNotice(r.error, 'error')
          return
        }
        case 'signOut':
          await signOut()
          return setNotice('Signed out: the stored Google sign-in of this project is deleted.')
      }
      // The page is ours, but its id still goes into a URL path and a Chat request: checked.
      const id = typeof m.id === 'string' && rowId(m.id) ? m.id : null
      if (!id) return
      switch (m.type) {
        case 'open':
          return await openConversation(id)
        case 'discuss':
          return await discuss(id, typeof m.tabId === 'string' ? m.tabId : undefined)
        case 'newSession':
          return await newSession(id)
        case 'read':
        case 'unread': {
          const r = await markRow(id, m.type)
          // A failed call already put up its notice; a refusal before any call (no target, read
          // already) says it here.
          if (r.error) {
            if (!S.notice || S.notice.text !== cut(oneLine(r.error), 600)) setNotice(r.error, 'error')
          } else if (!/^Marked /.test(r.message)) setNotice(r.message)
          return
        }
        case 'wrong':
          return await wrong(id, m.priority)
        case 'undoWrong':
          return await undoWrong(id)
      }
    } catch (e) {
      ctx.log.warn(`panel ${m.type}: ${e && e.message ? e.message : e}`)
      setNotice(e && e.message ? e.message : String(e), 'error')
    }
  })

  // ---- CLI ----

  function status() {
    const a = auth ? auth.status() : {}
    return {
      tooOld,
      client: a.client || null,
      pasted: a.pasted,
      pastedBroken: a.pastedBroken,
      settingsMissing: a.settingsMissing || [],
      signedIn: Boolean(a.signedIn),
      ready: ready_(),
      blocked: S.blocked,
      sessionOnly: a.sessionOnly,
      signingIn: a.signingIn,
      signedOutReason: a.signedOutReason,
      problems: S.settings.problems,
      account: (S.state && S.state.account) || '',
      me: me(),
      meChecked: Boolean(S.state && S.state.meChecked),
      missing: a.grant ? a.grant.missing : null,
      lastPoll: (S.state && S.state.lastPoll) || 0,
      polling: Boolean(S.polling),
      pollMinutes: cfg().pollMinutes,
      backoffMinutes: S.backoffMinutes,
      markReadOnOpen: cfg().markReadOnOpen,
      counts: S.state && S.state.lastPoll && ready_() ? S.view.lanes.map((l) => ({ id: l.id, title: l.title, total: l.rows.length })) : null,
      triage: triageOn() ? (S.triageError ? `error: ${S.triageError}` : 'on (bronos.jev-triage)') : 'off: install and enable Jev triage (bronos.jev-triage) to sort the lanes',
      annotate: annotateOn()
        ? S.htmlRejected
          ? `reviewer.annotate, text only (its html mode was refused: ${S.htmlRejected})`
          : 'reviewer.annotate (the conversation as clean HTML with its pictures, notes on it)'
        : "the plugin's reader page (no reviewer with annotate in this project)",
      error: S.error,
      notes: S.notes,
      spaceErrors: S.spaceErrors,
    }
  }

  ctx.cli.register('chat', async (argv, call) => {
    await ready
    return runCli(
      argv,
      {
        status,
        async refresh() {
          const p = pollNow('cli', true)
          let timer
          const late = new Promise((r) => {
            timer = setTimeout(() => r('late'), io.cliWaitMs || CLI_WAIT_MS)
          })
          const got = await Promise.race([p.then(() => 'done'), late])
          clearTimeout(timer)
          if (got === 'late') return { pending: true }
          return S.error ? { error: S.error } : {}
        },
        view: () => S.view,
        async show(id, signal) {
          return textOf(await loadConversation(id, signal))
        },
        mark: (id, want) => markRow(id, want),
        login: async () => startSignIn('cli'),
        logout: () => signOut(),
        client: (text) => pasteClient(text),
      },
      call,
    )
  })

  // ---- the inbox-feed service (v2, lib/feed.js; Inbox reads it, cc-cockpit 0.9.7+) ----

  const sent = { items: new Map(), key: null, started: false } // what Inbox was last told: id -> item, the Sync state it saw, and whether the first sync went out

  /** All items of the scope (`limit`: the contract's 1000 by default). */
  function feedList(limit) {
    return feed.feedItems(S.feedRows, { limit })
  }

  /**
   * One feed item by id, or null: the same item feedList(Infinity) holds, without building and
   * sorting every other one (main asks the overlay buttons after every click and setButtons).
   */
  function feedItemOf(id) {
    return feed.feedItems(S.feedRows, { limit: Infinity, only: id })[0] || null
  }

  /** `ok`, `signedOut` or `error`, with the message the Sync carries. */
  function feedState() {
    if (tooOld) return { state: 'error', message: cut(oneLine(tooOld), 300) }
    if (!signedIn()) return { state: 'signedOut', message: cut(oneLine((auth && auth.status().signedOutReason) || 'Not signed in to Google.'), 300) }
    if (S.blocked) return { state: 'error', message: cut(oneLine(S.blocked), 300) }
    if (S.error) return { state: 'error', message: cut(oneLine(S.error), 300) }
    return { state: 'ok' }
  }
  const stateKey = (st) => `${st.state}|${st.message || ''}`

  /** The Sync: the whole list from the cache, and the baseline the next diff starts from. */
  function feedSync() {
    const items = feedList()
    const st = feedState()
    sent.items = new Map(items.map((i) => [i.id, i]))
    sent.key = stateKey(st)
    return { items, ...st, asOf: (S.state && S.state.lastPoll) || now() }
  }

  function feedEmit(event, data) {
    try {
      ctx.services.emit('inbox-feed', event, data)
    } catch (e) {
      ctx.log.warn(`inbox-feed ${event}:`, e && e.message ? e.message : e)
    }
  }

  /**
   * Tell Inbox what changed since it was last told (after a poll, a mark, a sign-in): `item` per
   * changed or new conversation, `gone` for the missing ones. A change of the Sync state (a sign-in,
   * an error, a recovery) is a `sync` instead: the source is unsure it told everything. The message
   * counts as well as the kind, or error A -> error B would stay stale in Inbox. Nothing before the
   * first sync (activate's cached view). Never throws: an older app has no listener to reach.
   */
  function emitFeed() {
    if (S.stopped || !sent.started || !ctx.services || typeof ctx.services.emit !== 'function') return
    try {
      if (stateKey(feedState()) !== sent.key) return feedEmit('sync', feedSync())
      const next = feedList()
      const d = feed.diffFeed(sent.items, next)
      sent.items = new Map(next.map((i) => [i.id, i]))
      for (const it of d.items) feedEmit('item', it)
      for (const ids of feed.goneChunks(d.gone)) feedEmit('gone', { ids })
    } catch (e) {
      ctx.log.warn('inbox-feed:', e && e.message ? e.message : e)
    }
  }

  void ready.then(() => {
    if (S.stopped || !ctx.services || typeof ctx.services.emit !== 'function') return
    sent.started = true
    feedEmit('sync', feedSync())
  })

  /**
   * `act(id, 'open')` of the feed: resolves once the open has started (the reviewer's overlay
   * prepared, or our own reader page up), not when it is over; with neither (a reviewer without
   * prepare, or a prepare that failed) once the conversation is shown, so a failed read is still the act's
   * refusal. The rest (reading the conversation, the
   * annotate, and without the reviewer the wait for our reader page to close) runs on: Inbox gives
   * every act 10 s, and an open that waited for all that was reported as failed while it was on
   * screen (design-next §3.4: "a source answering act(id, 'open') by opening first"). A failure
   * after the start goes to this panel's notice; one before it is the act's refusal.
   * An open that ends without anything shown (the reviewer refused the conversation, the app refused
   * our reader page: paths that set the panel's notice and return) is a refusal too, with that
   * notice's text: resolving there answered ok for nothing on screen, and Inbox ended the item's
   * "back" mark (phase-1 review round 3). One guard here, not one per early return.
   */
  function openStarted(open) {
    return new Promise((resolve, reject) => {
      let started = false
      const before = S.notice
      open(() => {
        started = true
        resolve()
      }).then(() => {
        if (started) return
        const n = S.notice !== before && S.notice && S.notice.kind === 'error' ? S.notice.text : ''
        reject(new Error(n || 'the conversation could not be shown'))
      }, (e) => {
        if (!started) return reject(e)
        const msg = e && e.message ? e.message : String(e)
        ctx.log.warn(`open: ${msg}`)
        setNotice(`Could not open the conversation: ${msg}`, 'error')
      })
    })
  }

  /** One of the item's own actions, as a row click or the panel's mark does it. Never rejects. */
  async function feedAct(id, action) {
    await ready
    const refuse = (message) => ({ ok: false, message: cut(oneLine(message), 300) })
    if (typeof id !== 'string' || typeof action !== 'string') return refuse('chat: act takes an item id and an action id')
    const item = feedItemOf(id)
    if (!item) return refuse('chat: that conversation is not in the inbox feed (refresh?)')
    if (!item.actions.some((a) => a.id === action)) return refuse(`chat: this conversation has no action "${cut(action, 40)}"`)
    try {
      if (action === 'open') await openStarted((started) => openConversation(id, started))
      else {
        const r = await markRow(id, action === 'markUnread' ? 'unread' : 'read', { quiet: true })
        if (r.error) return refuse(`chat: ${r.error}`)
      }
      return { ok: true }
    } catch (e) {
      return refuse(`chat: ${e && e.message ? e.message : e}`)
    }
  }

  const feedService = {
    async describe() {
      return { ...feed.DESCRIBE, scope: feed.scopeLine(cfg()) }
    },
    async features() {
      return [...feed.FEATURES]
    },
    // From the cache only: never a Google call, so Inbox can ask whenever a provider joins.
    async snapshot() {
      await ready
      return feedSync()
    },
    act: (id, action) => feedAct(id, action),
  }
  // Providing needs nothing newer than the app's services; Inbox reading it needs 0.9.7 (useAll).
  if (ctx.services && typeof ctx.services.provide === 'function') ctx.services.provide('inbox-feed', feedService)

  return {
    S,
    auth,
    ready,
    pollNow,
    classifyChanged,
    markRow,
    stop() {
      S.stopped = true
      abort.abort()
      if (headerTimer) (io.clearInterval || clearInterval)(headerTimer)
      if (firstPoll) (io.clearTimeout || clearTimeout)(firstPoll)
      if (stopSchedule) stopSchedule()
      return Promise.all([stateFile.flush().catch(() => {}), namesFile.flush().catch(() => {}), images ? images.cache.flush() : null])
    },
  }
}

exports.activate = (ctx) => {
  instance = start(ctx)
  const gaps = apiGaps(ctx)
  ctx.log.info(gaps.length ? `activated on an app that is too old (no ${gaps.join(', ')})` : 'activated')
}

exports.deactivate = () => {
  const i = instance
  instance = null
  return i ? i.stop() : undefined
}

// For the suites: the host with fakes in place of fetch and timers.
exports._start = start
exports._apiGaps = apiGaps
exports._fatal = fatal
