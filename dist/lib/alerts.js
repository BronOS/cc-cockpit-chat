'use strict'
// Grafana alerts posted in Chat by a bot (design "Alerts", ported from the old cockpit's
// lib/convs.py `alert` and `group_alerts`, the chat half). Only with `alertBots`: the bots' display
// names, matched exactly. An alert message is one from such a bot whose first line is Grafana's:
// `[FIRING:n] <name> — <node> (labels)` or `RESOLVED: <name> — <node> (labels)` (a leading emoji or
// marker is skipped). Other messages of those bots are plain conversations.
//
// One row per alert name across spaces with all its unread messages: a count, the nodes still
// firing. A node whose newest message is RESOLVED is gone; an alert whose every node is gone has no
// row (the old connector's rule: there is nothing left to look at).

const { cut, oneLine, firstLine, MAX_ALERT_NAME, ALERT, unique } = require('./util')
const T = require('./time')

const MAX_NODES = 10

/**
 * `{ name, node, resolved }` of an alert message, null for any other message.
 * @param {{ bot: boolean, senderName: string, text: string }} m a kept message (model.compactMessage)
 * @param {string[]} bots
 */
function parseAlert(m, bots) {
  if (!m || !m.bot || !bots.includes(m.senderName)) return null
  const line = firstLine(String(m.text || '').replace(/<[^>]{0,500}>/g, ''))
  if (!line) return null
  const resolved = /RESOLVED/i.test(line.slice(0, 40))
  // Leading emoji, punctuation and Grafana's state marker: `🔥 [FIRING:2] `, `✅ RESOLVED: `.
  const marker = /^[^\p{L}\p{N}[]*(\[(FIRING|RESOLVED)[^\]]{0,40}\]|(FIRING|RESOLVED):?)?\s*/iu.exec(line)
  const hadMarker = Boolean(marker && (marker[2] || marker[3]))
  const body = line.slice(marker ? marker[0].length : 0)
  const dash = body.indexOf(' — ')
  if (dash < 0 && !hadMarker) return null
  const rawName = dash < 0 ? body.replace(/\s*\([^()]*\)\s*$/, '') : body.slice(0, dash)
  const rawNode = dash < 0 ? '' : body.slice(dash + 3).replace(/\s*\([^()]*\)\s*$/, '')
  const name = cut(oneLine(rawName), MAX_ALERT_NAME)
  if (!name) return null
  return { name, node: cut(oneLine(rawNode), 200), resolved }
}

/**
 * The Alerts lane from the unread conversations: alert groups, and the conversations left as they
 * are. A conversation is an alert only when every one of its new messages is.
 *
 * @param {object[]} convs unread conversations (model.conversations), any space
 * @param {string[]} bots
 * @param {Record<string, string>} spaceTitles space name -> its title
 * @returns {{ groups: object[], rest: object[] }} groups: `{ id: 'alert:<name>', name, nodes, count,
 *   firing, at, latest, spaces: [{ name, title }], targets: { space: newest alert time }, messages, convIds }`
 */
function groupAlerts(convs, bots, spaceTitles = {}) {
  const by = new Map()
  const rest = []
  for (const c of convs) {
    const parsed = c.new.map((m) => ({ m, a: parseAlert(m, bots) }))
    if (!parsed.length || parsed.some((x) => !x.a)) {
      rest.push(c)
      continue
    }
    for (const { m, a } of parsed) {
      if (!by.has(a.name)) by.set(a.name, { name: a.name, msgs: [], convIds: new Set() })
      const g = by.get(a.name)
      g.msgs.push({ m, node: a.node, resolved: a.resolved, space: c.space })
      g.convIds.add(c.id)
    }
  }
  const groups = []
  for (const g of by.values()) {
    const msgs = g.msgs.sort((x, y) => T.compare(x.m.at, y.m.at))
    const lastOf = new Map()
    for (const x of msgs) lastOf.set(x.node, x)
    const live = new Set([...lastOf.entries()].filter(([, x]) => !x.resolved).map(([n]) => n))
    const firing = msgs.filter((x) => live.has(x.node) && !x.resolved)
    if (!firing.length) continue // every node resolved: nothing to look at (old connector)
    const latest = firing[firing.length - 1]
    // What Mark read moves: per space, the newest alert message there (a newer alert of another
    // name in the same space stays unread).
    const targets = {}
    for (const x of msgs) targets[x.space] = x.m.at
    const spaces = unique(msgs.map((x) => x.space)).map((name) => ({ name, title: spaceTitles[name] || '' }))
    groups.push({
      id: ALERT + g.name,
      name: g.name,
      nodes: [...live].filter(Boolean).sort().slice(0, MAX_NODES),
      count: firing.length,
      firing: firing.length,
      at: T.ms(latest.m.at),
      latest: latest.m,
      spaces,
      targets,
      messages: msgs.map((x) => x.m),
      convIds: [...g.convIds],
    })
  }
  return { groups, rest }
}

/** The row title of a group: `HighCPU: node1, node2`. */
function groupTitle(g) {
  return g.nodes.length ? `${g.name}: ${g.nodes.join(', ')}` : g.name
}

module.exports = { parseAlert, groupAlerts, groupTitle, MAX_NODES }
