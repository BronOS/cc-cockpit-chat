'use strict'
// What jev-triage gets for one row (its `triage` v1 service, source `chat`; design "Triage"): the
// item text, the hint or floor, and short fields rules can match. The text is the old connector's
// `conv_text` / `chat_finish` shape, with "the person" where it had the user's own name.
//
// - item: `{ id, text, hint?, floor?, fields: { from, space, kind, to, lane, jira? } }`.
// - text, `triageText: full`: what the conversation is (`Google Chat, direct message with Ann`),
//   who takes part, whom it addresses, up to 3 earlier messages as context (300 characters each) and
//   the newest 5 new ones to judge (1500 each); a read row judges its newest message. `summary`: the
//   first line, participants and addressed-to only, no message text.
// - hints: every alert row is noise (the old rule). Floor: an unread conversation that @mentions the
//   person by name (a new message, or the thread's start) is at least `action` (answer 3). DMs get no
//   floor: Jev decides.

const { cut, oneLine } = require('./util')
const { ALL, isMine } = require('./model')
const { senderLabel, shownText } = require('./names')
const { participants, spaceLabel } = require('./poll')
const { groupTitle } = require('./alerts')

const CUTS = { context: 3, contextText: 300, newCount: 5, newText: 1500, field: 200 }
const JIRA_KEY = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9_]*-[0-9]{1,9}(?![A-Za-z0-9_])/

/** What the conversation is, in one line. */
function about(row, names, me) {
  const c = row.conv
  const sp = row.space
  if (c.kind === 'dm') return `Google Chat, direct message with ${spaceLabel(sp, c, names, me)}`
  if (c.kind === 'group') return `Google Chat, group chat '${spaceLabel(sp, c, names, me)}'`
  if (c.kind === 'thread') return `Google Chat, space '${spaceLabel(sp, c, names, me)}', one thread`
  return `Google Chat, space '${spaceLabel(sp, c, names, me)}'`
}

/** Whom the conversation addresses (the old connector's `to`), and the short field for rules. */
function addressed(row, names, me) {
  const c = row.conv
  if (c.kind === 'dm') return { text: 'the person (direct message)', field: 'me' }
  const mentions = c.new.flatMap((m) => m.mentions)
  const others = [...new Set(c.new.flatMap((m) => m.mentions.filter((u) => u !== ALL && u !== me).map((u) => m.mentionNames[u] || names.get(u) || 'someone')))]
  if (me && mentions.includes(me)) return { text: `the person (@mentioned)${others.length ? `, also ${others.join(', ')}` : ''}`, field: 'me' }
  if (mentions.includes(ALL)) return { text: `everyone (@all), the person included${others.length ? `, also @${others.join(', @')}` : ''}`, field: 'all' }
  if (c.followed) return { text: `${c.followed === 'me' ? 'the person (@mentioned' : 'everyone (@all'} at the thread's start)${others.length ? `; replies @mention ${others.join(', ')}` : ''}`, field: c.followed === 'me' ? 'me' : 'all' }
  if (others.length) return { text: `${others.join(', ')} (@mentioned) - not the person`, field: 'others' }
  return { text: 'the group, nobody in particular', field: 'none' }
}

/** One message as a line Jev reads. */
function say(m, max, names, me) {
  return `${senderLabel(m, names, me)}: ${cut(shownText(m, names, me) || '(no text)', max).replace(/\n/g, '\n    ')}`
}

/** The text Jev reads about a conversation row. */
function convText(row, mode, names, me) {
  const c = row.conv
  const people = participants(c, names, me)
  const to = addressed(row, names, me)
  const lines = [about(row, names, me)]
  if (people.length) lines.push(`Participants: ${people.slice(0, 12).join(', ')}`)
  lines.push(`Addressed to: ${to.text}`)
  if (mode === 'summary') return lines.join('\n')
  const judged = c.unread ? c.new.slice(-CUTS.newCount) : [c.latest]
  if (c.context.length) {
    lines.push('', 'Earlier in the conversation (context only, do not judge these):')
    for (const m of c.context.slice(-CUTS.context)) lines.push(`  ${say(m, CUTS.contextText, names, me)}`)
  }
  lines.push('', c.unread ? 'New messages to judge:' : 'Latest message (already read) to judge:')
  for (const m of judged) lines.push(`  ${say(m, CUTS.newText, names, me)}`)
  return lines.join('\n')
}

/** The text Jev reads about an alert group (hinted noise; Jev only sees it if a rule says so). */
function alertText(g, mode, names, me) {
  const head = `Google Chat, Grafana alert '${g.name}'${g.spaces.length === 1 && g.spaces[0].title ? ` in space '${g.spaces[0].title}'` : ''}`
  if (mode === 'summary') return head
  return [head, `${g.count} unread alert message${g.count === 1 ? '' : 's'} firing${g.nodes.length ? `, nodes: ${g.nodes.join(', ')}` : ''}.`, 'Addressed to: the ops alert channel, nobody in particular.', '', `Latest: ${say(g.latest, 300, names, me)}`].join('\n')
}

/** The first Jira issue key in the thread's start or the new messages (a field for rules). */
function jiraKey(c) {
  const start = c.context.length ? c.context[0] : null
  for (const m of [start, ...c.new, c.latest].filter(Boolean)) {
    const k = JIRA_KEY.exec(String(m.text || ''))
    if (k) return k[0]
  }
  return null
}

/**
 * One triage item for a view row.
 * @param {object} row poll.buildView's row
 * @param {'full'|'summary'} mode
 * @param {object} names lib/names.js
 * @param {string} me the person's user id ('' unknown)
 */
function triageItem(row, mode, names, me) {
  if (row.kind === 'alert') {
    const g = row.group
    return {
      id: row.id,
      text: alertText(g, mode, names, me),
      hint: { priority: 'noise' },
      fields: { from: cut(senderLabel(g.latest, names, me), CUTS.field), space: cut(g.spaces.map((s) => s.title).filter(Boolean).join(', '), CUTS.field), kind: 'alert', to: 'none', lane: row.lane, alert: cut(groupTitle(g), CUTS.field) },
    }
  }
  const c = row.conv
  const to = addressed(row, names, me)
  const item = {
    id: row.id,
    text: convText(row, mode, names, me),
    fields: { from: cut(oneLine(senderLabel(c.latest, names, me)), CUTS.field), space: cut(oneLine(spaceLabel(row.space, c, names, me)), CUTS.field), kind: c.kind, to: to.field, lane: row.lane },
  }
  const key = jiraKey(c)
  if (key) item.fields.jira = key
  // A direct @mention of the person in what is new (answer 3): at least action. Not for a DM.
  if (c.unread && c.kind !== 'dm' && row.mentioned === 'me' && !isMine(c.latest, me)) item.floor = 'action'
  return item
}

module.exports = { triageItem, convText, alertText, addressed, about, jiraKey, CUTS }
