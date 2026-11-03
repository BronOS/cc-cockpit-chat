'use strict'
// Lanes (design "Lanes"): Mentions, Direct messages, Spaces, Alerts (only with alert bots), Recent.
// Inside a lane: triage priority, then the newest message. A conversation shows once.

const LANES = [
  { id: 'mentions', title: 'Mentions' },
  { id: 'direct', title: 'Direct messages' },
  { id: 'spaces', title: 'Spaces' },
  { id: 'alerts', title: 'Alerts' },
  { id: 'recent', title: 'Recent' },
]
const LANE_IDS = LANES.map((l) => l.id)

const RANK = { urgent: 0, action: 1, fyi: 2, noise: 3 }

/**
 * Rows of one lane in the panel's order. `verdict` is the triage verdict or null: without one (no
 * triage, an error) a row sorts after the judged ones, by its time.
 * @param {{ id: string, at: number, verdict?: { priority: string } | null }[]} rows
 */
function sortRows(rows) {
  const rank = (r) => (r.verdict && r.verdict.priority in RANK ? RANK[r.verdict.priority] : 4)
  return [...rows].sort((a, b) => rank(a) - rank(b) || (b.at || 0) - (a.at || 0) || (a.id < b.id ? -1 : 1))
}

/**
 * The unread lane of a conversation: Mentions when its new messages (or its thread's start)
 * @mention the person by name and it is not a DM; Direct messages for a DM or group chat; Spaces
 * for the rest of a space (an @all included: answer 5).
 */
function unreadLane(conv, mentionedMe) {
  if (mentionedMe && conv.kind !== 'dm') return 'mentions'
  if (conv.kind === 'dm' || conv.kind === 'group') return 'direct'
  return 'spaces'
}

module.exports = { LANES, LANE_IDS, RANK, sortRows, unreadLane }
