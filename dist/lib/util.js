'use strict'
// Small helpers shared by the other modules: text cuts, a bounded parallel map, stable hashes,
// times for a person, and the checks on the Chat resource names that go into a URL path or a
// filter. No I/O here, so every suite can use them as they are. (From bronos.gmail; the id checks
// are Chat's.)

const crypto = require('node:crypto')

/** `text` cut to at most `max` characters, with an ellipsis that says it was cut. */
function cut(text, max) {
  const s = String(text == null ? '' : text)
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

/** One line: line breaks and runs of white space become one space (rows, notices, a subject). */
function oneLine(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
}

/**
 * Run `fn` over `items` with at most `limit` running at once (design: concurrency 4, so a first
 * run with 60 active spaces does not open 60 sockets to Chat). Resolves to
 * `[{ ok: true, value } | { ok: false, error }]` in the items' order: one failing thread never
 * fails the poll.
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      try {
        out[i] = { ok: true, value: await fn(items[i], i) }
      } catch (error) {
        out[i] = { ok: false, error }
      }
    }
  }
  const workers = []
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker())
  await Promise.all(workers)
  return out
}

/** A short stable hash of a JSON value: what a triage item looked like when it was classified. */
function hashOf(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
}

/** The first `n` hex digits of sha256(text): a key part that names a value without holding it. */
function sha(text, n = 12) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, n)
}

/** `2026-10-30 14:02`, local time: a person reads it (a message date, the last poll). */
function stamp(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** "3 min ago", "2 h ago": `ccc chat status`. */
function ago(ms, now = Date.now()) {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

// Chat resource names (design "Fetching": ids checked by pattern). A name goes into a URL path or a
// `filter`, so nothing that could add a path segment, a query or a quote passes. Chat's ids are
// letters, digits, `_` and `-` (a message id may hold a `.`: a thread's first message is
// `<thread>.<thread>`).
const SEG = '[A-Za-z0-9_-]{1,128}'
const SPACE_RE = new RegExp(`^spaces/${SEG}$`)
const THREAD_RE = new RegExp(`^spaces/${SEG}/threads/[A-Za-z0-9_.-]{1,128}$`)
const MESSAGE_RE = new RegExp(`^spaces/${SEG}/messages/[A-Za-z0-9_.-]{1,256}$`)
const USER_RE = /^users\/[A-Za-z0-9_-]{1,64}$/

/** `spaces/S` or null. */
function spaceName(v) {
  const s = String(v == null ? '' : v)
  return SPACE_RE.test(s) ? s : null
}
/** `spaces/S/threads/T` or null. */
function threadName(v) {
  const s = String(v == null ? '' : v)
  return THREAD_RE.test(s) && !s.includes('..') ? s : null
}
/** `spaces/S/messages/M` or null. */
function messageName(v) {
  const s = String(v == null ? '' : v)
  return MESSAGE_RE.test(s) && !s.includes('..') ? s : null
}
/** `users/ID` or null (`users/all` passes: an @all mention). */
function userName(v) {
  const s = String(v == null ? '' : v)
  return USER_RE.test(s) ? s : null
}
/** The space of a thread or message name (`spaces/S/...` -> `spaces/S`). */
function spaceOf(name) {
  const m = /^(spaces\/[A-Za-z0-9_-]{1,128})(\/|$)/.exec(String(name || ''))
  return m ? m[1] : null
}

const ALERT = 'alert:'
const MAX_ALERT_NAME = 200 // a triage id is at most 256 characters

/**
 * A row id from the panel or the CLI: a space (`spaces/S`: a DM, group chat or flat space), a
 * thread (`spaces/S/threads/T`), or `alert:<name>` (an alert group). Returns `{ space }`,
 * `{ space, thread }` or `{ alert }`, null for anything else.
 */
function rowId(value) {
  const s = String(value == null ? '' : value)
  if (s.startsWith(ALERT)) {
    const name = s.slice(ALERT.length)
    if (name.trim() && name.length <= MAX_ALERT_NAME && !/[\r\n\0]/.test(name)) return { alert: name }
    return null
  }
  if (spaceName(s)) return { space: s }
  if (threadName(s)) return { space: spaceOf(s), thread: s }
  return null
}

/** An email address as the plugin keeps it (lower case), or null when it does not look like one. */
function emailAddress(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase()
  if (s.length > 254 || !/^[^\s@"'(){}<>,;:\\/[\]]+@[^\s@"'(){}<>,;:\\/[\]]+\.[^\s@"'(){}<>,;:\\/[\]]+$/.test(s)) return null
  return s
}

/** The first line of a text that has any, trimmed. */
function firstLine(text) {
  for (const l of String(text == null ? '' : text).split(/\r?\n/)) if (l.trim()) return l.trim()
  return ''
}

/** The values in order, each once, empty ones left out. */
function unique(xs) {
  return [...new Set(xs.filter((x) => x))]
}

module.exports = { cut, oneLine, mapLimit, hashOf, sha, stamp, ago, spaceName, threadName, messageName, userName, spaceOf, rowId, emailAddress, firstLine, unique, ALERT, MAX_ALERT_NAME }
