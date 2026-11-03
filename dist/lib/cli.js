'use strict'
// `ccc chat ...`: parsing and the printed text. The handler gets plain data from the host (`deps`),
// so the suites drive it without an app. No subcommand reads stdin (the manifest does not declare
// it: with `stdin: true` every subcommand would wait for an open pipe), so the client file is read
// from a path. Nothing printed here ever holds a token or the client secret. (bronos.gmail's cli.js,
// with Chat's lanes and the read / unread marks.)

const fs = require('node:fs')
const path = require('node:path')
const { ago, stamp, oneLine, cut, rowId } = require('./util')
const { LANES, LANE_IDS } = require('./lanes')
const { MAX_FILE, SCOPE_TEXT } = require('./oauth-client')

const HELP = `ccc chat: your Google Chat (bronos.chat)

  ccc chat status            client, account, user id, scopes, last poll, counts per lane, errors
  ccc chat refresh           poll Google Chat now and print the counts
  ccc chat list [lane]       the conversations of every lane, or of one: ${LANE_IDS.join(', ')}
  ccc chat show <id>         a conversation as readable text (an id from list: spaces/..., alert:<name>)
  ccc chat read <id>         mark it read in Google Chat
  ccc chat unread <id>       mark it unread in Google Chat
  ccc chat login             start the Google sign-in (your browser does the rest)
  ccc chat logout            sign out: the stored sign-in is deleted
  ccc chat client <file>     use the OAuth client file you downloaded from Google Cloud (Desktop app)
  ccc chat help              this text

The plugin changes nothing in Google Chat but your read state (read / unread, and opening a row
when markReadOnOpen is on). show never marks anything.
Settings: ccc plugin config bronos.chat (the client secret only in Settings > This project).
`

/**
 * @param {string[]} argv
 * @param {object} deps from the host: status(), refresh(signal), view(), show(id, signal),
 *   mark(id, 'read'|'unread'), login(), logout(), client(text)
 * @param {{ cwd?: string, signal?: AbortSignal }} [call]
 */
async function runCli(argv, deps, call = {}) {
  const [cmd, ...rest] = argv
  const ok = (stdout) => ({ stdout: stdout.endsWith('\n') ? stdout : stdout + '\n', code: 0 })
  const fail = (stderr, code = 1) => ({ stderr: stderr.endsWith('\n') ? stderr : stderr + '\n', code })
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || (rest[0] === '--help' && cmd)) return ok(HELP)
  try {
    switch (cmd) {
      case 'status':
        return ok(statusText(deps.status()))
      case 'refresh': {
        const st = deps.status()
        if (!st.ready) return fail(notReady(st))
        const r = await deps.refresh(call.signal)
        if (r && r.error) return fail(`refresh failed: ${r.error}`)
        if (r && r.pending) return ok('still polling; ccc chat status shows when it is done')
        return ok(countsLine(deps.status()))
      }
      case 'list': {
        const lane = rest[0]
        if (lane && !LANE_IDS.includes(lane)) return fail(`unknown lane "${cut(lane, 40)}": one of ${LANE_IDS.join(', ')}`, 2)
        const st = deps.status()
        if (!st.ready) return fail(notReady(st))
        if (!st.lastPoll) return fail('no poll yet: run ccc chat refresh')
        return ok(listText(deps.view(), lane))
      }
      case 'show':
      case 'read':
      case 'unread': {
        if (!rest.length) return fail(`usage: ccc chat ${cmd} <id> (spaces/..., spaces/.../threads/... or alert:<name>)`, 2)
        const raw = rest.join(' ')
        if (!rowId(raw)) return fail(`not a conversation id: "${cut(raw, 80)}" (ccc chat list shows them)`, 2)
        const st = deps.status()
        if (!st.ready) return fail(notReady(st))
        if (cmd === 'show') return ok(await deps.show(raw, call.signal))
        const r = await deps.mark(raw, cmd)
        if (r && r.error) return fail(r.error)
        return ok(r && r.message ? r.message : cmd === 'read' ? 'Marked read.' : 'Marked unread.')
      }
      case 'login': {
        const r = await deps.login()
        if (r && r.error) return fail(r.error)
        return ok(r && r.message ? r.message : 'Your browser opens the Google sign-in: finish it there. ccc chat status shows the result.')
      }
      case 'logout': {
        const r = await deps.logout()
        return ok(r && r.message ? r.message : 'Signed out.')
      }
      case 'client': {
        if (!rest[0]) return fail('usage: ccc chat client <path to the client JSON file>', 2)
        const file = path.resolve(call.cwd || process.cwd(), rest.join(' '))
        let text
        try {
          const st = await fs.promises.stat(file)
          if (!st.isFile()) return fail(`${file} is not a file`)
          if (st.size > MAX_FILE) return fail(`${file} is too big to be a Google client file`)
          text = await fs.promises.readFile(file, 'utf8')
        } catch (e) {
          return fail(`cannot read ${file}: ${e.code || e.message}`)
        }
        const r = await deps.client(text)
        if (!r.ok) return fail(r.error)
        return ok(r.message)
      }
      default:
        return fail(`unknown command "${cut(cmd, 40)}"\n\n${HELP}`, 2)
    }
  } catch (e) {
    return fail(e && e.message ? e.message : String(e))
  }
}

/** Why there is nothing to show yet: the first thing missing. */
function notReady(st) {
  if (st.tooOld) return st.tooOld
  if (!st.client) return 'No OAuth client yet: ccc chat client <file.json>, or set clientId and clientSecret (Settings > This project > Google Chat). ccc chat status says more.'
  if (!st.signedIn) return st.signedOutReason || 'Not signed in to Google: ccc chat login (or Sign in with Google in the Google Chat panel).'
  if (st.blocked) return st.blocked
  return 'Not ready yet: ccc chat status says more.'
}

function countsLine(st) {
  if (!st.counts) return 'no poll yet'
  return st.counts.map((c) => `${c.title} ${c.total}`).join(' · ') || 'no lane is on'
}

/** `ccc chat status`. */
function statusText(st, now = Date.now()) {
  const lines = []
  if (st.tooOld) return `${st.tooOld}\n`
  const c = st.client
  lines.push(`client    ${c ? `${c.id} (${c.source === 'pasted' ? 'pasted client file' : 'settings'})` : '(none)'}`)
  if (st.pastedBroken) lines.push(`problem   ${st.pastedBroken}`)
  for (const m of st.settingsMissing || []) lines.push(`problem   ${m} is not set (Settings > This project > Google Chat)`)
  lines.push(`sign-in   ${st.signedIn ? `signed in${st.sessionOnly ? ' for this session only (the keychain did not take the sign-in)' : ''}` : st.signingIn ? 'waiting for the browser' : 'not signed in'}`)
  if (!st.signedIn) {
    if (st.signedOutReason) lines.push('', st.signedOutReason)
    else if (!c) lines.push('', 'Set up an OAuth client first (the Google Chat panel shows the steps; README "Set up Google Cloud"), then: ccc chat client <file.json> and ccc chat login.')
    else lines.push('', 'Next: ccc chat login (or Sign in with Google in the Google Chat panel).')
    for (const p of st.problems || []) lines.push(`problem   ${p}`)
    return lines.join('\n') + '\n'
  }
  lines.push(`account   ${st.account || '(not known yet)'}`)
  lines.push(`user id   ${st.me ? `${st.me}${st.meChecked ? '' : ' (from the sign-in; not yet checked against a message of yours)'}` : 'not known: your own messages and @mentions of you cannot be told apart'}`)
  if (st.missing === null) lines.push('scopes    not checked yet')
  else if (!st.missing.length) lines.push('scopes    all granted')
  else for (const k of st.missing) lines.push(`scopes    missing ${SCOPE_TEXT[k] ? `${SCOPE_TEXT[k].label}: ${SCOPE_TEXT[k].loses}` : k}`)
  if (st.blocked) lines.push(`blocked   ${st.blocked}`)
  lines.push(`last poll ${st.lastPoll ? `${stamp(st.lastPoll)} (${ago(st.lastPoll, now)})` : 'none yet'}${st.polling ? ', polling now' : ''}; every ${st.pollMinutes} min while this project is open${st.backoffMinutes ? ` (now every ${st.backoffMinutes} min: Google Chat was busy)` : ''}`)
  lines.push(`lanes     ${countsLine(st)}`)
  lines.push(`triage    ${st.triage}`)
  lines.push(`view      ${st.annotate}`)
  lines.push(`marks     ${st.markReadOnOpen ? 'Mark read / unread, and opening an unread row marks it read (markReadOnOpen)' : 'Mark read / unread only (markReadOnOpen is off)'}`)
  for (const p of st.problems || []) lines.push(`problem   ${p}`)
  if (st.error) lines.push(`error     ${st.error}`)
  for (const n of (st.notes || []).slice(0, 5)) lines.push(`note      ${n}`)
  for (const e of (st.spaceErrors || []).slice(0, 5)) lines.push(`error     ${e.space}: ${e.message}`)
  return lines.join('\n') + '\n'
}

const DOT = { urgent: 'U', action: 'A', fyi: 'f', noise: '.' }

/** `ccc chat list [lane]`: one line per row, `*` for unread, the triage letter, the id to show. */
function listText(view, lane) {
  const out = []
  for (const l of view.lanes) {
    if (lane && l.id !== lane) continue
    out.push(`${l.title} (${l.rows.length})`)
    for (const r of l.rows) {
      const t = r.verdict ? DOT[r.verdict.priority] || '?' : ' '
      const n = r.count > 1 ? ` (${r.count} new)` : ''
      out.push(`  ${r.unread ? '*' : ' '} ${t} ${r.id}`)
      out.push(`      ${cut(oneLine(r.title), 70)}${n} · ${cut(oneLine(r.sub), 90)}`)
    }
  }
  if (lane && !view.lanes.some((l) => l.id === lane)) {
    const title = (LANES.find((l) => l.id === lane) || {}).title || lane
    return `${title}: this lane is off (the lanes setting${lane === 'alerts' ? ', or no alertBots' : ''})\n`
  }
  out.push('', '* unread   triage: U urgent, A action, f fyi, . noise')
  return out.join('\n') + '\n'
}

module.exports = { runCli, statusText, listText, notReady, HELP }
