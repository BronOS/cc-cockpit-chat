'use strict'
// People's names (design "Names"). Chat gives a sender's `displayName` only "provided the user is a
// member of the space or has prior affinity with the calling user", and the old connector found
// human senders without one. So: the message's own name, else a name Chat put on a mention
// annotation, else this cache, else one People API lookup (`people:batchGet`, a Chat user id is the
// People API person id) for all the ids of a poll that nobody named. A lookup that found nothing is
// asked again after a day, not every poll.
//
// Bounded: at most 2000 ids per project, the least recently used go first; kept in names.json in the
// project data folder (one writer, store.js).

const MAX_ENTRIES = 2000
const RETRY_MS = 24 * 3600 * 1000
const BATCH = 200 // people:batchGet takes at most 200 resource names

/**
 * @param {object} [stored] what names.json held
 * @param {() => number} [now]
 */
function createNames(stored, now = Date.now) {
  // id -> { n: name ('' = asked, not found), t: last used (ms), f?: when a lookup found nothing }
  const map = new Map()
  const entries = stored && stored.v === 1 && stored.entries && typeof stored.entries === 'object' ? stored.entries : {}
  for (const [id, e] of Object.entries(entries)) {
    if (!/^users\/[A-Za-z0-9_-]{1,64}$/.test(id) || !e || typeof e !== 'object') continue
    map.set(id, { n: typeof e.n === 'string' ? e.n.slice(0, 100) : '', t: Number(e.t) || 0, ...(e.f ? { f: Number(e.f) || 0 } : {}) })
  }
  let dirty = false

  function prune() {
    if (map.size <= MAX_ENTRIES) return
    const by = [...map.entries()].sort((a, b) => a[1].t - b[1].t)
    for (const [id] of by.slice(0, map.size - MAX_ENTRIES)) map.delete(id)
  }

  /** The cached name of an id, '' when none. Marks the entry as used. */
  function get(id) {
    const e = map.get(id)
    if (!e) return ''
    e.t = now()
    return e.n
  }

  /** Keep a name Chat or the People API gave. */
  function set(id, name) {
    if (!/^users\/[A-Za-z0-9_-]{1,64}$/.test(id) || typeof name !== 'string' || !name.trim()) return
    const n = name.trim().slice(0, 100)
    const e = map.get(id)
    if (e && e.n === n && !e.f) {
      e.t = now()
      return
    }
    map.set(id, { n, t: now() })
    dirty = true
    prune()
  }

  /** A lookup that named nobody: asked again after a day. */
  function missed(id) {
    const e = map.get(id)
    if (e && e.n) return
    map.set(id, { n: '', t: now(), f: now() })
    dirty = true
    prune()
  }

  /** Names from kept messages: the sender's own and those on mention annotations. */
  function learn(msgs) {
    for (const m of msgs) {
      if (m.sender && !m.bot && m.senderName) set(m.sender, m.senderName)
      for (const [id, n] of Object.entries(m.mentionNames || {})) set(id, n)
    }
  }

  /** The ids worth a People API lookup: never named, and not asked in the last day. */
  function unknown(ids) {
    const out = []
    for (const id of new Set(ids)) {
      if (id === 'users/all' || !/^users\/[A-Za-z0-9_-]{1,64}$/.test(id)) continue
      const e = map.get(id)
      if (e && e.n) continue
      if (e && e.f && now() - e.f < RETRY_MS) continue
      out.push(id)
    }
    return out.slice(0, BATCH * 2)
  }

  /** What names.json keeps. */
  function toJSON() {
    dirty = false
    return { v: 1, entries: Object.fromEntries(map) }
  }

  return { get, set, missed, learn, unknown, toJSON, isDirty: () => dirty, size: () => map.size }
}

/**
 * Look the ids up in the People API, in batches of 200 (at most two a poll): fills the cache, marks
 * the misses. A failure leaves the ids unnamed until the next poll and is returned for a log line.
 */
async function lookUp(names, ids, people, signal) {
  const todo = names.unknown(ids)
  let error = null
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH)
    try {
      const got = await people(chunk, signal)
      for (const id of chunk) {
        if (got[id]) names.set(id, got[id])
        else names.missed(id)
      }
    } catch (e) {
      error = e
      break
    }
  }
  return { asked: todo.length, error }
}

/**
 * The name a person reads for a kept message's sender: "you" for the person, `<name> (bot)` for a
 * bot, the name, else "unknown user".
 */
function senderLabel(m, names, me) {
  if (me && m.sender === me) return 'you'
  if (m.bot) return `${m.senderName || 'bot'} (bot)`
  return m.senderName || (m.sender && names.get(m.sender)) || 'unknown user'
}

/**
 * A message text with Chat's mention markup `<users/ID>` (and `<users/all>`) as a person reads it:
 * `@you`, `@Ann Example`, `@all`, `@someone` for a name nobody gave. `nameOf` (user id -> name or '')
 * is tried after the names the message's own annotations carry.
 */
/**
 * Chat's mention markup in one form: the API's `formattedText` writes a mention as
 * `<chat-user data-user="users/ID"></chat-user>` (seen on a real account 2026-11-03), its `text` as
 * `<users/ID>`. Both become `<users/ID>`, the one form mentionText and format.chatHtml read.
 */
function normaliseMentions(text) {
  return String(text == null ? '' : text).replace(/<chat-user\s+data-user="(users\/[A-Za-z0-9_-]{1,64})"[^>]{0,200}>[^<]{0,500}<\/chat-user>/g, '<$1>')
}

function mentionText(text, nameOf, me, own = {}) {
  return normaliseMentions(text).replace(/<(users\/[A-Za-z0-9_-]{1,64})>/g, (_, u) => {
    if (u === 'users/all') return '@all'
    if (me && u === me) return '@you'
    return `@${own[u] || (nameOf && nameOf(u)) || 'someone'}`
  })
}

/** A kept message's text with its mentions named (mentionText with the names cache). */
function shownText(m, names, me) {
  return mentionText(m && m.text, (u) => names.get(u), me, (m && m.mentionNames) || {})
}

module.exports = { createNames, lookUp, senderLabel, mentionText, shownText, MAX_ENTRIES, RETRY_MS, BATCH, normaliseMentions }
