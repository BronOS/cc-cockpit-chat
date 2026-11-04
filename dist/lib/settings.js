'use strict'
// Settings validation (project scope; design "Settings"). The manifest schema cannot say everything
// (no regexes in schemas: the app refuses them, ReDoS in main), so the host checks here what the
// form cannot: a client id that is a Google one, bot names that are plain one-line text. A bad
// optional value (one bot name) is a problem shown in the panel and `ccc chat status` and skipped; it
// never stops the plugin. (From bronos.gmail's settings.js.)

const { checkClientId } = require('./oauth-client')
const { oneLine } = require('./util')

const LANE_IDS = ['mentions', 'direct', 'spaces', 'alerts', 'recent']
const LANE_DEFAULTS = { mentions: true, direct: true, spaces: true, alerts: true, recent: true }
const MAX_BOT_NAME = 100

/**
 * @param {Record<string, unknown>} p ctx.settings.project
 * @returns {{ cfg: object, problems: string[] }}
 */
function readSettings(p) {
  const s = p || {}
  const problems = []
  const rawId = typeof s.clientId === 'string' ? s.clientId.trim() : ''
  let clientId = ''
  if (rawId) {
    const c = checkClientId(rawId)
    if (c.ok) clientId = rawId
    else problems.push(`clientId: ${c.error}`)
  }
  // A secret field is absent when unset (never '' or null; `ccc guide settings-secrets`).
  const clientSecret = typeof s.clientSecret === 'string' && s.clientSecret ? s.clientSecret : ''

  // Nested defaults: a project that never saved `lanes` may arrive without some keys, so each lane
  // falls back on its own default rather than trusting the object to be whole (as bronos.jira).
  const lanesIn = s.lanes && typeof s.lanes === 'object' ? s.lanes : {}
  const lanes = {}
  for (const id of LANE_IDS) lanes[id] = typeof lanesIn[id] === 'boolean' ? lanesIn[id] : LANE_DEFAULTS[id]

  // Bot display names are matched exactly (a bot's sender.displayName, as Chat shows it).
  const alertBots = []
  for (const a of Array.isArray(s.alertBots) ? s.alertBots : []) {
    if (typeof a !== 'string' || !a.trim()) continue
    const name = oneLine(a)
    if (name.length > MAX_BOT_NAME) problems.push(`alertBots: "${name.slice(0, 60)}…" is longer than ${MAX_BOT_NAME} characters, skipped`)
    else if (!alertBots.includes(name)) alertBots.push(name)
  }
  const int = (v, d, lo, hi) => {
    const n = Math.floor(Number(v))
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
  }
  const cfg = {
    clientId,
    clientSecret,
    lanes,
    alertBots,
    rowsPerLane: int(s.rowsPerLane, 10, 1, 300),
    days: int(s.days, 14, 1, 90),
    messagesPerSpace: int(s.messagesPerSpace, 12, 5, 100),
    recentDays: int(s.recentDays, 2, 1, 14),
    maxRecent: int(s.maxRecent, 10, 1, 100),
    recentPerSpace: int(s.recentPerSpace, 3, 1, 20),
    pollMinutes: int(s.pollMinutes, 2, 1, 1440),
    triageText: s.triageText === 'summary' ? 'summary' : 'full',
    // Off by default (0.2.0): opening a message to look at it must not mark it read; Mark read does.
    markReadOnOpen: s.markReadOnOpen === true,
  }
  return { cfg, problems }
}

/** Whether the Alerts lane exists: switched on and at least one alert bot. */
function alertsOn(cfg) {
  return Boolean(cfg.lanes.alerts && cfg.alertBots.length)
}

module.exports = { readSettings, alertsOn, LANE_IDS, LANE_DEFAULTS, MAX_BOT_NAME }
