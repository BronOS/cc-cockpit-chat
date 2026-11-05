'use strict'
// The `inbox-feed` service (v2, 0.3.0) this plugin provides to Inbox: the pure parts. The host
// (dist/host.js) wires them to its view, its open path and its mark-read write.
//
// - Built only from the rows of the last view the panel shows (poll.buildView), never an API call:
//   Inbox calls `snapshot()` whenever a provider joins and a service call has no rate limit from the
//   app. The host keeps the last view of a signed-in run, so a signed-out or failing plugin still
//   answers with what it had.
// - The scope is the view itself: the unread conversations of every lane that is on (Mentions, Direct
//   messages, Spaces, Alerts) and the read ones of the Recent lane (`recentDays`, `maxRecent`). An
//   alert group is a panel idea; the feed has no groups, so the group's conversations are items
//   labelled `alert` and `alert:<name>`. Triage verdicts stay in this plugin's lanes: the feed
//   carries facts, and Inbox's rules decide what matters.
// - `rev` is the latest message's resource name: it changes when a message arrives and for nothing
//   else. A mark read leaves it alone.
// - An action is a promise: `markRead` / `markUnread` are listed only on a row that has a mark target.
//   A thread whose newest message is a reply is judged by the thread's own read time, which only Google
//   Chat sets, so the panel's mark refuses it and the feed does not offer it (open still works).
// - `diffFeed` is how events are made: after each poll and each mark the host compares the list with
//   what it last told and emits `item` for any changed field and `gone` for a missing id.
// - Plain data only (the registry copies it with structuredClone); every string is cut to the
//   contract's caps here too, since Inbox treats a source as untrusted.

const { cut, oneLine, sha } = require('./util')
const { jiraKey } = require('./triage')
const { alertsOn } = require('./settings')

const DESCRIBE = Object.freeze({ label: 'Chat', badge: 'CHAT', color: 'green', kind: 'chat' })
const FEATURES = Object.freeze([])
const MAX_ITEMS = 1000
const MAX_GONE = 500
const MAX_ID = 200
const MAX_REV = 100
const CUTS = { title: 300, preview: 1000, name: 120, place: 120, label: 40, labels: 20, scope: 120, message: 300 }
const ACTION_LABELS = { open: 'Open', markRead: 'Mark read', markUnread: 'Mark unread' }

/**
 * `scope` of describe(): what the feed holds, from the settings. Each unread lane that is on is in
 * it and one that is off is not; the Alerts lane exists only with alert bots (without them an alert
 * message is a plain conversation of another lane), so it is named only then. The read part is the
 * Recent lane.
 */
function scopeLine(cfg) {
  const lanes = (cfg && cfg.lanes) || {}
  const alerts = Boolean(cfg && cfg.alertBots && alertsOn(cfg))
  const hasAlertsLane = Boolean(cfg && cfg.alertBots && cfg.alertBots.length)
  const names = []
  if (lanes.mentions !== false) names.push('mentions')
  if (lanes.direct !== false) names.push('direct messages')
  if (lanes.spaces !== false) names.push('spaces')
  if (alerts) names.push('alerts')
  // Every lane that can exist is on: say so in one phrase instead of listing them.
  const every = names.length === 3 + (hasAlertsLane ? 1 : 0)
  const parts = []
  if (names.length) parts.push(every ? 'unread conversations' : `unread ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]}`)
  if (lanes.recent !== false) parts.push(`read of the last ${cfg.recentDays} days (newest ${cfg.maxRecent})`)
  return cut(parts.length ? parts.join(' + ') : 'nothing (every lane is off)', CUTS.scope)
}

/** `rev` in the contract's 1-100: a resource name longer than that is hashed (it still changes with a new message). */
function revOf(id) {
  const s = String(id == null ? '' : id)
  if (!s) return 'none'
  return s.length <= MAX_REV ? s : `h:${sha(s, 40)}`
}

/**
 * One conversation row of the view as a FeedItem.
 * @param {object} row buildView's `conv` row
 * @param {{ alerts?: string[] }} [o] `alerts`: the names of the alert groups the conversation is in
 * @returns {object | null} null for a row whose id the contract cannot carry
 */
function feedItem(row, o = {}) {
  const c = row.conv
  if (!c || typeof row.id !== 'string' || !row.id || row.id.length > MAX_ID) return null
  const unread = Boolean(row.unread)
  const item = {
    id: row.id,
    rev: revOf(c.latest && c.latest.id),
    title: cut(oneLine(row.title), CUTS.title) || '(no text)',
    time: Math.max(1, Number(row.at) || 0),
    read: !unread,
    actions: [{ id: 'open', label: ACTION_LABELS.open }],
  }
  const preview = cut(oneLine(row.preview || ''), CUTS.preview)
  if (preview) item.preview = preview
  const name = cut(oneLine(row.from || ''), CUTS.name)
  if (name) item.from = { name }
  item.to = c.kind === 'dm' ? 'direct' : 'group'
  if (row.mentioned === 'me') item.mentionsMe = true
  const where = cut(oneLine(row.where || row.title || ''), CUTS.place)
  if (where) item.place = { kind: 'channel', name: where }
  const labels = []
  if (row.mentioned === 'all') labels.push('mention:all')
  if (o.alerts && o.alerts.length) {
    labels.push('alert')
    for (const a of o.alerts) labels.push(`alert:${a}`)
  }
  const key = jiraKey(c)
  if (key) labels.push(`jira:${key}`)
  const seen = new Set()
  const clean = []
  for (const l of labels) {
    const s = cut(oneLine(l), CUTS.label)
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase())
      clean.push(s)
    }
  }
  if (clean.length) item.labels = clean.slice(0, CUTS.labels)
  if (row.target) item.actions.push(unread ? { id: 'markRead', label: ACTION_LABELS.markRead } : { id: 'markUnread', label: ACTION_LABELS.markUnread })
  return item
}

/** The rows of a view that are a feed item's source, lane by lane: conversations, and alert groups (expanded by feedItems). */
function feedRows(view) {
  return (view.lanes || []).flatMap((l) => l.rows.filter((r) => (r.kind === 'conv' && r.conv) || (r.kind === 'alert' && Array.isArray(r.convRows))))
}

/**
 * The whole scope as items, newest first (then the id, a stable order), at most `limit` (default
 * 1000, the contract's cap; `act` passes Infinity to check an id against everything). A
 * conversation shows once, with the names of every alert group it is in.
 * @param {object[]} rows feedRows(view)
 * @param {{ limit?: number }} [o]
 */
function feedItems(rows, o = {}) {
  const convs = new Map() // id -> { row, alerts }
  // `only`: the one id wanted (an overlay's buttons, an act): every other conversation is skipped.
  const wanted = (id) => o.only === undefined || id === o.only
  for (const r of rows) {
    if (r.kind === 'alert') {
      for (const cr of r.convRows) {
        if (!wanted(cr.id)) continue
        const e = convs.get(cr.id) || { row: cr, alerts: [] }
        if (r.group && r.group.name && !e.alerts.includes(r.group.name)) e.alerts.push(r.group.name)
        convs.set(cr.id, e)
      }
    } else if (wanted(r.id) && !convs.has(r.id)) convs.set(r.id, { row: r, alerts: [] })
  }
  const items = []
  for (const { row, alerts } of convs.values()) {
    const it = feedItem(row, { alerts })
    if (it) items.push(it)
  }
  const limit = o.limit === undefined ? MAX_ITEMS : o.limit
  return items.sort((a, b) => b.time - a.time || (a.id < b.id ? -1 : 1)).slice(0, limit)
}

/** JSON with sorted keys: two items are the same when this is. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

/**
 * What changed between the list last told and the list now.
 * @param {object[] | Map<string, object>} prev items last told
 * @param {object[]} next items now
 * @returns {{ items: object[], gone: string[] }} `items`: new or changed (any field), `gone`: ids missing now
 */
function diffFeed(prev, next) {
  const before = prev instanceof Map ? prev : new Map((prev || []).map((i) => [i.id, i]))
  const now = new Set(next.map((i) => i.id))
  const items = next.filter((i) => !before.has(i.id) || stable(before.get(i.id)) !== stable(i))
  const gone = [...before.keys()].filter((id) => !now.has(id))
  return { items, gone }
}

/** `gone` ids in the events' bound (1-500 per event). */
function goneChunks(ids) {
  const out = []
  for (let i = 0; i < ids.length; i += MAX_GONE) out.push(ids.slice(i, i + MAX_GONE))
  return out
}

module.exports = { DESCRIBE, FEATURES, MAX_ITEMS, MAX_GONE, MAX_ID, CUTS, ACTION_LABELS, scopeLine, revOf, feedItem, feedRows, feedItems, diffFeed, goneChunks }
