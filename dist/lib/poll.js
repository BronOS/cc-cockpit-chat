'use strict'
// One poll (design "Fetching", "Polling"), and the view the panel, the CLI and triage share. The old
// connector's `chat()` with the API's own calls:
//
// - `spaces.list` (cheap: every space's `lastActiveTime`), kept when active within `days`.
// - The mentions search (one call): unread hits make their spaces read this poll and join their
//   messages, so a mention outside a space's newest messages still shows. It leaves out bots and
//   muted spaces, which the per-space reads cover; a failed search is noted, never fatal.
// - Which spaces are checked (their read time asked): one whose activity changed, one that had
//   unread rows (it may have been read in Chat since: a read moves no `lastActiveTime`), one marked
//   from here since, one with a hit. A checked space whose activity, read time and judged thread read
//   times are as last poll keeps its rows; a read space quiet past `recentDays` keeps none; the rest
//   are read (`messages.list`, the newest `messagesPerSpace`) and judged (model.conversations).
// - A failure of one space keeps its last rows (a side space never empties the board); a dead
//   sign-in, a missing scope, a disabled API or a personal account fails the poll, and Chat being
//   busy (429 / 5xx) is reported as `busy` so the host backs off.
// - The state holds only the spaces kept (active within `days`), each with at most a dozen messages
//   per conversation: bounded.

const { compactSpace, compactMessage, groupMessages, conversations, threadStart, userIds, titleLine, mentionsMeDirectly, ALL, isMine } = require('./model')
const { groupAlerts, groupTitle, parseAlert } = require('./alerts')
const { LANES, sortRows, unreadLane } = require('./lanes')
const { alertsOn } = require('./settings')
const { lookUp, senderLabel, shownText } = require('./names')
const { missingScopes } = require('./oauth-client')
const { mapLimit, cut, oneLine, spaceOf, unique } = require('./util')
const { isBusy } = require('./http')
const T = require('./time')

const CONCURRENCY = 4
const DAY = 86400000
const THREAD_CONTEXT_PAGE = 10

/** A fresh state for one client (a client change or a sign out starts one). */
function emptyState(clientHash) {
  return { v: 1, clientHash, account: '', me: '', meChecked: false, spaces: {}, marked: {}, lastPoll: 0 }
}

/** The stored state when it belongs to this client, else a fresh one. */
function loadState(stored, clientHash) {
  if (stored && stored.v === 1 && stored.clientHash === clientHash && stored.spaces && typeof stored.spaces === 'object') {
    return { ...emptyState(clientHash), ...stored, spaces: stored.spaces, marked: stored.marked && typeof stored.marked === 'object' ? stored.marked : {} }
  }
  return emptyState(clientHash)
}

/** Errors that stop the poll as a whole: the sign-in, the grant, the API switch, the account kind. */
function fatal(e) {
  return Boolean(e) && ['auth', 'scope', 'workspace'].includes(e.kind) || Boolean(e && e.kind === 'disabled' && e.api === 'chat') || Boolean(e && e.name === 'AuthError')
}

/**
 * Who is signed in and what was granted (design "Auth"): Google's token info for the address, the
 * scopes and the account id, then (once per account) the person's own Chat user id from a message of
 * theirs, which wins over the account id. Updates `state`; resolves the token info's answer
 * `{ email, sub, missing }`.
 */
async function checkAccount({ client, state, signal, log }) {
  const info = await client.tokenInfo(signal)
  const missing = missingScopes(info.scope)
  if (info.email && info.email !== state.account) {
    state.account = info.email
    state.meChecked = false
    state.me = ''
  }
  if (!state.me && info.sub) state.me = `users/${info.sub}`
  if (!state.meChecked && (!missing || !missing.includes('messages'))) {
    try {
      const own = await client.ownUserId(signal)
      if (own) state.me = own
      state.meChecked = true
    } catch (e) {
      if (fatal(e) || isBusy(e)) throw e
      if (log) log.warn(`finding your Chat user id by a message of yours failed: ${e.message}`)
    }
  }
  return { email: info.email, sub: info.sub, missing }
}

/**
 * @param {object} o
 * @param {ReturnType<import('./client').createClient>} o.client
 * @param {object} o.cfg settings.readSettings(...).cfg
 * @param {object} o.state loadState(...), updated in place
 * @param {ReturnType<import('./names').createNames>} o.names
 * @param {number} [o.now]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{ changed: boolean, stats: object, busy?: Error }>}
 */
async function poll(o) {
  const { client, cfg, state, names, signal } = o
  const now = o.now || Date.now()
  const me = state.me || ''
  const since = now - cfg.days * DAY
  const recentSince = now - cfg.recentDays * DAY
  const stats = { spaces: 0, checked: 0, read: 0, errors: [], notes: [] }
  let busy = null
  const soft = (e, what) => {
    if (fatal(e)) throw e
    if (isBusy(e)) busy = e
    stats.errors.push({ space: what, message: e && e.message ? e.message : String(e) })
  }

  const spaces = (await client.spaces(signal)).map(compactSpace).filter((s) => s.active && T.ms(s.active) > since)
  stats.spaces = spaces.length
  const known = new Set(spaces.map((s) => s.name))

  // The mentions search: its unread hits, per space.
  const hitsBySpace = new Map()
  try {
    for (const h of await client.searchMentions(since, signal)) {
      if (h.read === true) continue
      const sp = spaceOf(h.message.name)
      if (!sp || !known.has(sp)) continue
      if (!hitsBySpace.has(sp)) hitsBySpace.set(sp, [])
      hitsBySpace.get(sp).push(h.message)
    }
  } catch (e) {
    if (fatal(e)) throw e
    if (isBusy(e)) busy = e
    stats.notes.push(`the mentions search failed (${e && e.message ? e.message : e}); mentions outside a space's newest messages may be missing`)
  }

  const prev = state.spaces || {}
  const marked = state.marked || {}
  const check = spaces.filter((s) => marked[s.name] || hitsBySpace.has(s.name) || !(prev[s.name] && prev[s.name].active === s.active && !prev[s.name].unread))
  stats.checked = check.length
  const reads = await mapLimit(check, CONCURRENCY, (s) => client.spaceReadState(s.name, signal))

  const next = {}
  const fetch = []
  const checkedOk = new Set()
  for (let i = 0; i < check.length; i++) {
    const s = check[i]
    const r = reads[i]
    const p = prev[s.name]
    if (!r.ok) {
      soft(r.error, s.name)
      if (p) next[s.name] = { ...p, ...s, active: p.active } // asked again next poll
      continue
    }
    checkedOk.add(s.name)
    const last = r.value
    const isUnread = T.after(s.active, last)
    if (p && p.active === s.active && p.read === last && !hitsBySpace.has(s.name) && !marked[s.name] && !(await threadsMoved(client, p.convs || [], signal))) {
      next[s.name] = { ...s, read: last, unread: Boolean(p.unread), convs: p.convs || [] }
    } else if (!isUnread && T.ms(s.active) < recentSince) {
      next[s.name] = { ...s, read: last, unread: false, convs: [] }
    } else {
      // Until the read below lands, the last rows (a failed read keeps them).
      next[s.name] = { ...s, read: last, unread: isUnread, convs: (p && p.convs) || [] }
      fetch.push({ s, last })
    }
  }
  for (const s of spaces) {
    if (next[s.name] || check.includes(s)) continue
    const p = prev[s.name]
    next[s.name] = { ...s, read: p.read, unread: Boolean(p.unread), convs: p.convs || [] }
  }

  stats.read = fetch.length
  const results = await mapLimit(fetch, CONCURRENCY, ({ s, last }) => readSpace({ client, s, last, me, cfg, recentSince, hits: hitsBySpace.get(s.name) || [], signal, onWarn: (m) => stats.notes.push(m) }))
  const fresh = []
  results.forEach((r, i) => {
    const { s } = fetch[i]
    if (r.ok) {
      next[s.name].convs = r.value
      next[s.name].unread = r.value.some((c) => c.unread)
      fresh.push(...r.value)
      return
    }
    soft(r.error, s.name)
    // Read again next poll: a failed space counts as unread until a read says otherwise.
    next[s.name].unread = true
    checkedOk.delete(s.name)
  })

  // Names: what the messages carry, then the People API for the rest (one or two calls).
  const msgs = fresh.flatMap((c) => [...c.context, ...c.new, c.latest])
  names.learn(msgs)
  const ids = unique(Object.values(next).flatMap((sp) => (sp.convs || []).flatMap(userIds))).filter((u) => u !== me)
  const people = await lookUp(names, ids, (chunk, sig) => client.people(chunk, sig), signal)
  if (people.error) {
    if (people.error.kind === 'auth' || people.error.name === 'AuthError') throw people.error
    stats.notes.push(people.error.kind === 'disabled' || people.error.kind === 'scope' ? people.error.message : `looking up names failed: ${people.error.message}`)
  }

  state.spaces = next
  for (const sp of checkedOk) delete state.marked[sp]
  // A mark for a space no longer kept is gone with it.
  for (const sp of Object.keys(state.marked)) if (!next[sp]) delete state.marked[sp]
  state.lastPoll = now
  return { changed: true, stats, ...(busy ? { busy } : {}) }
}

/**
 * Whether an unread row judged by its thread's read time has a different one now (read, or
 * unfollowed, in Chat): then its space is read again. A failed ask counts as moved.
 */
async function threadsMoved(client, convs, signal) {
  const judged = convs.filter((c) => c.unread && c.thread && Object.prototype.hasOwnProperty.call(c, 'threadRead'))
  if (!judged.length) return false
  const now = await mapLimit(judged, CONCURRENCY, (c) => client.threadReadState(c.thread, signal))
  return now.some((r, i) => {
    if (!r.ok) {
      if (fatal(r.error)) throw r.error
      return true
    }
    return (r.value || null) !== (judged[i].threadRead || null)
  })
}

/** One space read and judged: its conversations (model.conversations), with the context filled in. */
async function readSpace({ client, s, last, me, cfg, recentSince, hits, signal, onWarn }) {
  const { messages: list } = await client.messages(s.name, { pageSize: cfg.messagesPerSpace }, signal)
  const raws = new Map(list.map((m) => [m.name, m]))
  const threadsRead = new Map() // thread -> its messages, read for a hit or for context
  const readThread = async (thread) => {
    if (!threadsRead.has(thread)) threadsRead.set(thread, (await client.messages(s.name, { pageSize: THREAD_CONTEXT_PAGE, thread }, signal)).messages)
    return threadsRead.get(thread)
  }
  // A mention hit out of view: its thread (threaded space), else the message itself.
  for (const h of hits) {
    if (raws.has(h.name)) continue
    const t = h.thread && typeof h.thread.name === 'string' ? h.thread.name : null
    if (s.threaded && t) {
      try {
        for (const m of await readThread(t)) if (!raws.has(m.name)) raws.set(m.name, m)
      } catch (e) {
        if (fatal(e)) throw e
        raws.set(h.name, h)
      }
    } else raws.set(h.name, h)
  }
  const msgs = [...raws.values()].map(compactMessage)
  const { groups, ask } = groupMessages(s, msgs, me)
  const seen = await mapLimit(ask, CONCURRENCY, (t) => client.threadReadState(t, signal))
  const threadSeen = {}
  ask.forEach((t, i) => {
    if (seen[i].ok) threadSeen[t] = seen[i].value
    else {
      if (fatal(seen[i].error)) throw seen[i].error
      // Not known: judged by the space's read time this poll, asked again next time.
      onWarn(`the read time of a thread in ${s.title || s.name} could not be read: ${seen[i].error.message}`)
    }
  })
  const convs = conversations({ space: s, groups, last, threadSeen, me, recentSince, recentPerSpace: cfg.recentPerSpace })
  for (const c of convs) {
    if (!c.needStart) continue
    delete c.needStart
    try {
      const hist = (await readThread(c.thread)).map(compactMessage).sort((a, b) => T.compare(a.at, b.at))
      const before = hist.filter((m) => T.compare(m.at, c.new[0].at) < 0)
      if (before.length) c.context = before.slice(-3)
    } catch (e) {
      if (fatal(e)) throw e
      // Context only: the row stands without it.
    }
  }
  return convs
}

// ---- the view ----

/**
 * What Mark read / Mark unread moves for a conversation (design "Read state"): `{ <space>: <time of
 * its newest message of others> }`, or null for a thread whose newest message of others is a reply
 * and whose start did not @mention the person (judged by the thread's own read time, which only
 * Chat can set).
 */
function readTarget(conv) {
  if (conv.thread && conv.latest.reply && !conv.followed) return null
  return { [conv.space]: conv.latest.at }
}

/** How a conversation's new messages (or its thread's start) address the person: 'me', 'all', null. */
function mentioned(conv, me) {
  if (conv.followed === 'me' || conv.new.some((m) => mentionsMeDirectly(m, me))) return 'me'
  if (conv.followed === 'all' || conv.new.some((m) => m.mentions.includes(ALL))) return 'all'
  return null
}

/** A space's name for a person: its title, else for a DM / group chat its people. */
function spaceLabel(sp, conv, names, me) {
  if (sp && sp.title) return sp.title
  if (conv && (conv.kind === 'dm' || conv.kind === 'group')) {
    const people = participants(conv, names, me)
    if (people.length) return conv.kind === 'dm' ? people[0] : people.slice(0, 4).join(', ') + (people.length > 4 ? ` +${people.length - 4}` : '')
    return conv.kind === 'dm' ? (sp && sp.botDm ? 'a Chat app' : 'Direct message') : 'Group chat'
  }
  return '(unnamed space)'
}

/** The people of a conversation other than the person, by name, in order. */
function participants(conv, names, me) {
  return unique([...conv.context, ...conv.new, conv.latest].filter((m) => !isMine(m, me)).map((m) => senderLabel(m, names, me)))
}

/** The row's title (design "Panel"): a DM the person, a group chat its name or people, a thread its start's first line, a flat space the space. */
function convTitle(conv, sp, names, me) {
  if (conv.kind === 'thread') {
    const start = threadStart(conv)
    return titleLine({ ...start, text: shownText(start, names, me) })
  }
  return spaceLabel(sp, conv, names, me)
}

/**
 * The lanes as shown (only the enabled ones). Each row `{ id, kind: 'conv'|'alert', lane, at,
 * unread, verdict, title, sub, from, count, target, mentioned, pending, conv?, space?, group? }`,
 * sorted by triage priority then the newest message. `marks` (the host's optimistic marks:
 * id -> { want: 'read'|'unread', state }) override Chat's read state until a poll confirms them.
 *
 * @param {{ cfg: object, state: object, names: object, verdicts?: object, marks?: object, now?: number }} o
 */
function buildView(o) {
  const { cfg, state, names } = o
  const verdicts = o.verdicts || {}
  const marks = o.marks || {}
  const now = o.now || Date.now()
  if (!state || !state.lastPoll) return { lanes: [], unread: 0 }
  const me = state.me || ''
  const recentSince = now - cfg.recentDays * DAY
  const titles = {}
  const convs = []
  for (const sp of Object.values(state.spaces || {})) {
    titles[sp.name] = sp.title
    for (const c of sp.convs || []) convs.push({ c, sp })
  }
  const want = (id) => (marks[id] ? marks[id].want : null)
  // The read state as shown: Chat's, unless a mark from here says otherwise.
  const unreadOnes = []
  const readOnes = []
  for (const x of convs) {
    const w = want(x.c.id)
    if (w === 'read' && x.c.unread) readOnes.push({ ...x, c: { ...x.c, unread: false, new: [] } })
    else if (w === 'unread' && !x.c.unread) unreadOnes.push({ ...x, c: { ...x.c, unread: true, new: [x.c.latest] } })
    else (x.c.unread ? unreadOnes : readOnes).push(x)
  }
  const spOf = new Map(convs.map((x) => [x.c.id, x.sp]))
  const byLane = { mentions: [], direct: [], spaces: [], alerts: [], recent: [] }
  let rest = unreadOnes.map((x) => x.c)
  const unreadById = new Map(rest.map((c) => [c.id, c]))
  const bots = cfg.alertBots || []
  if (alertsOn(cfg)) {
    const g = groupAlerts(rest, bots, titles)
    rest = g.rest
    for (const grp of g.groups) {
      if (want(grp.id) === 'read') continue
      byLane.alerts.push({
        id: grp.id,
        kind: 'alert',
        lane: 'alerts',
        at: grp.at,
        unread: true,
        verdict: verdicts[grp.id] || null,
        title: groupTitle(grp),
        from: senderLabel(grp.latest, names, me),
        sub: grp.spaces.map((s) => s.title || 'a space').join(', '),
        count: grp.count,
        target: grp.targets,
        mentioned: null,
        pending: Boolean(marks[grp.id] && marks[grp.id].state === 'pending'),
        group: grp,
      })
    }
  }
  const row = (c, lane) => {
    const sp = spOf.get(c.id)
    const from = senderLabel(c.latest, names, me)
    const preview = cut(oneLine(shownText(c.latest, names, me)), 300)
    const title = convTitle(c, sp, names, me)
    const sub = c.kind === 'dm' ? preview : c.kind === 'thread' ? `${spaceLabel(sp, c, names, me)} · ${from}: ${preview}` : `${from}: ${preview}`
    return {
      id: c.id,
      kind: 'conv',
      lane,
      at: T.ms(c.latest.at),
      unread: c.unread,
      verdict: verdicts[c.id] || null,
      title,
      sub,
      // For the inbox-feed service (lib/feed.js): the message text start, and the space or person.
      preview,
      where: c.kind === 'dm' ? 'Direct message' : spaceLabel(sp, c, names, me),
      from,
      count: c.new.length,
      target: readTarget(c),
      mentioned: c.unread ? mentioned(c, me) : null,
      pending: Boolean(marks[c.id] && marks[c.id].state === 'pending'),
      conv: c,
      space: sp,
    }
  }
  // The inbox-feed has no groups: an alert group's conversations are items of their own (lib/feed.js).
  for (const r of byLane.alerts) r.convRows = r.group.convIds.map((id) => unreadById.get(id)).filter(Boolean).map((c) => row(c, 'alerts'))
  for (const c of rest) byLane[unreadLane(c, mentioned(c, me) === 'me')].push(row(c, unreadLane(c, mentioned(c, me) === 'me')))
  // Recent: the newest read conversations of the last `recentDays`, alerts left out.
  const recent = readOnes
    .map((x) => x.c)
    .filter((c) => T.ms(c.latest.at) >= recentSince && !(bots.length && parseAlert(c.latest, bots)))
    .sort((a, b) => T.compare(b.latest.at, a.latest.at))
    .slice(0, cfg.maxRecent)
  for (const c of recent) byLane.recent.push(row(c, 'recent'))
  const shown = LANES.filter((l) => (l.id === 'alerts' ? alertsOn(cfg) : cfg.lanes[l.id]))
  const lanes = shown.map((l) => ({ id: l.id, title: l.title, rows: sortRows(byLane[l.id]) }))
  // The panel badge: unread mentions and direct messages. Busy spaces and alert storms stay quiet.
  const unread = lanes.filter((l) => l.id === 'mentions' || l.id === 'direct').reduce((n, l) => n + l.rows.length, 0)
  return { lanes, unread }
}

/** Every row of a view, lane by lane. */
function allRows(view) {
  return view.lanes.flatMap((l) => l.rows)
}

module.exports = { poll, checkAccount, buildView, allRows, emptyState, loadState, readTarget, mentioned, participants, spaceLabel, convTitle, threadsMoved, readSpace, fatal, CONCURRENCY }
