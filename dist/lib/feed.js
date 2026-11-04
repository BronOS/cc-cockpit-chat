'use strict'
// The `inbox-feed` service (v1) for the Inbox plugin: the pure parts. The host (dist/host.js) wires
// them to its view cache, the row open and the mark-read write.
//
// - Only the rows of the Mentions and Direct messages lanes: what asks for the person. Spaces, Alerts
//   and Recent stay in the panel (an Inbox full of channel chatter is not an inbox).
// - Built from the rows the panel already shows (poll.buildView), so `items` never calls Google; the
//   host keeps the last view of a signed-in run, so a signed-out or failing plugin still answers
//   with what it had.
// - `rev` is the latest message's resource name: it changes when a message arrives and for nothing
//   else, which is what Inbox's "done until it changes" compares. A mark read leaves it alone.
// - `level` is the plugin's own triage verdict (Jev or rules). Without a verdict (triage off, an
//   error, not judged yet) a Mentions row is `action` (it names the person, the same floor triage
//   applies) and a Direct messages row is `fyi`: unjudged is never urgent and never noise.
// - `recent` (optional, announced through `features()`): the same FeedItems for the READ conversations
//   of the Recent lane (read, within `recentDays`), newest first, so Inbox can offer "reopen what I
//   just read". Same cache, same row mapping, same caps; never an API call. Every id it returns is a
//   row of the view, so `open` accepts it exactly like a click on that row in the panel's Recent lane.
// - Arguments come from another plugin, so they are checked here (as bronos.jira's service.js): the
//   limit is clamped, an id must be a string of the Chat id shape and a row of the feed.

const { rowId } = require('./util')
const { RANK } = require('./lanes')
const { jiraKey } = require('./triage')

const FEED_LANES = ['mentions', 'direct']
const RECENT_LANE = 'recent'
const LIMIT = { def: 20, min: 1, max: 50 }
const LEVELS = ['urgent', 'action', 'fyi', 'noise']
const ID_MAX = 300 // a space or thread resource name is far shorter; bounds what a caller can make us scan
const CAPS = { title: 300, from: 120, where: 120 }

const DESCRIBE = Object.freeze({ label: 'Chat', badge: 'CHAT', color: 'green', kind: 'chat' })
const FEATURES = Object.freeze(['markRead', 'recent'])

function clampLimit(v) {
  if (v === undefined || v === null) return LIMIT.def
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return LIMIT.def
  return Math.min(LIMIT.max, Math.max(LIMIT.min, n))
}

/** `items()`'s argument: `{ limit }` or nothing; anything else is a caller bug, refused. */
function itemsOptions(o) {
  if (o === undefined || o === null) return { limit: LIMIT.def }
  if (typeof o !== 'object' || Array.isArray(o)) throw new Error('chat: the options are an object')
  return { limit: clampLimit(o.limit) }
}

/** A conversation id of a service argument (`spaces/<id>` or `spaces/<id>/threads/<id>`), or throws. */
function checkId(value) {
  if (typeof value !== 'string' || !value || value.length > ID_MAX) throw new Error('chat: not a conversation id')
  const r = rowId(value)
  // An alert id is a valid panel id but not a feed item.
  if (!r || r.alert) throw new Error('chat: not a conversation id')
  return value
}

/** The row's level: its verdict, else the fallback above. */
function levelOf(row) {
  const p = row.verdict && row.verdict.priority
  if (LEVELS.includes(p)) return p
  return row.lane === 'mentions' ? 'action' : 'fyi'
}

const cap = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n - 1) + '…' : String(s == null ? '' : s))

/** One view row as a FeedItem. */
function feedItem(row) {
  const c = row.conv
  const item = {
    id: row.id,
    rev: c.latest.id,
    title: cap(row.preview || row.title, CAPS.title),
    from: cap(row.from, CAPS.from),
    where: cap(row.where || row.title, CAPS.where),
    at: row.at,
    level: levelOf(row),
    unread: Boolean(row.unread),
    direct: c.kind === 'dm' || c.kind === 'group',
    mentionsMe: row.mentioned === 'me',
  }
  const key = jiraKey(c)
  if (key) item.jiraKey = key
  return item
}

/** The feed rows of a view (Mentions and Direct messages, conversations only), lane by lane. */
function feedRows(view) {
  return (view.lanes || []).filter((l) => FEED_LANES.includes(l.id)).flatMap((l) => l.rows.filter((r) => r.kind === 'conv' && r.conv))
}

/**
 * The Recent lane's conversations of a view. Read rows only: a conversation marked unread here
 * leaves the lane in buildView already, the filter is the belt to that brace. An empty array when the
 * lane is hidden (it is then not in `view.lanes`).
 */
function recentRows(view) {
  return (view.lanes || []).filter((l) => l.id === RECENT_LANE).flatMap((l) => l.rows.filter((r) => r.kind === 'conv' && r.conv && !r.unread))
}

/**
 * The recently read items, newest message first (then the id, a stable order). No level ordering and
 * no noise rule: this is a history to reopen from, not a queue.
 * @param {object[]} rows view rows (recentRows)
 * @param {number} limit already clamped
 */
function recentItems(rows, limit) {
  return rows.map(feedItem).sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)).slice(0, limit)
}

/**
 * The items, best first: level, then the newest message, then the id (a stable order). Noise is
 * left out unless nothing else is there (design: the provider has nothing else), then it comes.
 * @param {object[]} rows view rows (feedRows)
 * @param {number} limit already clamped
 */
function feedItems(rows, limit) {
  const all = rows.map(feedItem).sort((a, b) => RANK[a.level] - RANK[b.level] || b.at - a.at || (a.id < b.id ? -1 : 1))
  const kept = all.filter((i) => i.level !== 'noise')
  return (kept.length ? kept : all).slice(0, limit)
}

module.exports = { DESCRIBE, FEATURES, FEED_LANES, LIMIT, itemsOptions, clampLimit, checkId, levelOf, feedItem, feedRows, feedItems, recentRows, recentItems }
