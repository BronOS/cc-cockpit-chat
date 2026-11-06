'use strict'
// The row decisions of the Google Chat panel, kept free of the DOM so node:test can check them
// (test/rowlogic.test.js requires this file; the page loads it as a classic script before main.js,
// where these functions become globals). As bronos.gmail's rowlogic.js.
//
// A row is one focusable element: a click on it or Enter / Space while it has the focus opens the
// conversation; the arrow keys move between rows. Its other actions are small buttons shown while the row
// is hovered or has the focus inside it (Tab reaches them; they are in the DOM all the time, only
// faded out, so the keyboard can get to them).

/**
 * What a key press on a row does: 'open', 'next', 'prev', 'first', 'last', or null (let it be).
 * Only presses on the row itself count: Enter on one of its buttons is that button's click.
 *
 * @param {string} key KeyboardEvent.key
 * @param {boolean} onRow the event's target is the row element (not a button inside it)
 * @param {{ alt?: boolean, ctrl?: boolean, meta?: boolean }} [mods]
 */
function rowKeyAction(key, onRow, mods) {
  if (!onRow) return null
  if (mods && (mods.alt || mods.ctrl || mods.meta)) return null
  switch (key) {
    case 'Enter':
    case ' ':
      return 'open'
    case 'ArrowDown':
      return 'next'
    case 'ArrowUp':
      return 'prev'
    case 'Home':
      return 'first'
    case 'End':
      return 'last'
    default:
      return null
  }
}

/**
 * Whether a click opens the conversation: anywhere on the row except its buttons and the triage chooser
 * (which act themselves), and not when the person was selecting text.
 */
function rowClickOpens(inControl, selecting) {
  return !inControl && !selecting
}

/**
 * The hover buttons of a row, in order: `{ action, label, title, disabled? }`. `action` is the
 * message type the page posts (`wrong` only toggles the chooser in the page). There is no "open in
 * Chat" button (design, answer 2).
 *
 * Mark read / Mark unread (design "Read state"): Mark read on an unread row, Mark unread on a read
 * one; an alert row is unread by nature, so it has Mark read only. A row Chat's API cannot move
 * (`noTarget`) has neither. While a mark is on its way (`pending`) the button stays, disabled.
 *
 * The triage button is labelled with the verdict itself ("action ▾"), not "Wrong?" (bronos.jira
 * 0.4.0): the label says what triage decided, the chooser asks the question.
 *
 * @param {{ kind: string, unread?: boolean, canRead?: boolean, canUnread?: boolean, pending?: boolean, verdict?: { priority: string } }} r
 * @param {{ triageOn: boolean }} s
 */
function rowButtons(r, s) {
  const out = []
  if (s && s.triageOn) {
    const p = r.verdict && r.verdict.priority
    out.push({ action: 'wrong', label: p ? `${p} ▾` : 'triage ▾', title: p ? `Triage says ${p}: change how much this needs you` : 'Not triaged yet: say how much this needs you' })
  }
  const what = r.kind === 'alert' ? 'these alert messages' : 'this conversation'
  if (r.canRead) out.push({ action: 'read', label: 'Mark read', title: `Mark ${what} read in Google Chat`, ...(r.pending ? { disabled: true } : {}) })
  else if (r.canUnread) out.push({ action: 'unread', label: 'Mark unread', title: `Mark ${what} unread in Google Chat`, ...(r.pending ? { disabled: true } : {}) })
  out.push({ action: 'discuss', label: 'Discuss', title: `Send ${what} to the Claude tab you are looking at` })
  out.push({ action: 'newSession', label: 'New', title: `Open a new Claude tab about ${what}` })
  return out
}

/** The index the focus moves to for a move action over `count` rows from `at`; null to stay. */
function moveIndex(action, at, count) {
  if (!count) return null
  if (action === 'first') return 0
  if (action === 'last') return count - 1
  if (action === 'next') return at < count - 1 ? at + 1 : null
  if (action === 'prev') return at > 0 ? at - 1 : null
  return null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `14:05` local. */
function clockText(ms) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Local calendar days from `at` to `now` (0 the same day, 1 yesterday). Midnights, rounded: a DST day has 23 or 25 hours. */
function dayDiff(at, now) {
  const mid = (ms) => {
    const d = new Date(ms)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  return Math.round((mid(now) - mid(at)) / 86400000)
}

/**
 * A row's time column, short, in local time (as bronos.inbox's rows): "now", "5m", "39m", "3h" (the
 * same day), "Yesterday", the weekday for the last week ("Mon": a name that cannot repeat within 7
 * days), "3 Nov" this year, "3 Nov 2025" another. Hours only within the same calendar day: at 00:30
 * a message of 22:00 is "Yesterday", which is how a person files it, not "2h". A time ahead of `now`
 * (a clock off by a little) is "now" on the same day, else its date. "" without a time.
 */
function whenText(at, now) {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return ''
  const days = dayDiff(at, now)
  const d = new Date(at)
  const date = () => `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`}`
  if (at > now) return days === 0 ? 'now' : date()
  const m = Math.floor((now - at) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  if (days === 0) return `${Math.floor(m / 60)}h`
  if (days === 1) return 'Yesterday'
  if (days < 7) return WEEKDAYS[d.getDay()]
  return date()
}

/** The time column's hover: "Fri 6 Nov 2026, 09:21", local. "" without a time. */
function fullTimeText(at) {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return ''
  const d = new Date(at)
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${clockText(at)}`
}

const str = (v) => (typeof v === 'string' ? v : '')

/**
 * What a row draws besides its buttons (the mockup "Chat rows", as bronos.inbox draws a chat item):
 * - `head`, the first line: `{ dm, place, thread, from }`, the place (the space) bold, the sender
 *   muted. A DM (the conversation kind `dm`) is only the person, with a DM tag: its title is the
 *   other person, and the latest sender would be "you" when the person wrote last. A thread
 *   (`thread`: the host's `where` is its space, the title its start's first line) is "Space ›
 *   thread", unless the start is the message shown (the title would only repeat the second line).
 *   A group chat's title is its name or its people; a flat space's is the space. An alert row: its
 *   alert ("CPU high: node-1") leads.
 * - `message`, the second line (2 lines at most, by CSS): the latest message, else the host's `sub`
 *   (an alert row: its spaces).
 * - `meta`, small under it: "mentions you" / "mentions @all", "3 new" (more than one new message).
 *   The place and the sender are not repeated here (the old `sub` line said both).
 *
 * @param {{ kind: string, conv?: string, title?: string, where?: string, preview?: string, sub?: string, from?: string, mentioned?: string|null, count?: number }} r
 */
function rowView(r) {
  const title = str(r.title)
  const from = str(r.from)
  const message = str(r.preview) || str(r.sub)
  const meta = []
  if (r.mentioned === 'me') meta.push('mentions you')
  else if (r.mentioned === 'all') meta.push('mentions @all')
  if (r.kind !== 'alert' && r.count > 1) meta.push(`${r.count} new`)
  let head
  if (r.kind === 'alert') head = { dm: false, place: title, thread: '', from }
  else if (r.conv === 'dm') head = { dm: true, place: title, thread: '', from: '' }
  else if (r.conv === 'thread') {
    const place = str(r.where)
    const t = title.replace(/…$/, '').trim()
    const thread = t && place && title !== place && !message.startsWith(t) ? title : ''
    head = { dm: false, place: place || title, thread, from }
  } else head = { dm: false, place: title || str(r.where), thread: '', from }
  // A sender that is the place itself (a group chat of one other person) is not said twice.
  if (head.from && head.from === head.place) head.from = ''
  return { head, message, meta }
}

/** The small pill of an alert row: "3 firing". */
function alertBadge(r) {
  if (r.kind !== 'alert') return ''
  return `${r.firing || r.count} firing`
}

if (typeof module !== 'undefined' && module.exports) module.exports = { rowKeyAction, rowClickOpens, rowButtons, moveIndex, whenText, fullTimeText, clockText, rowView, alertBadge }
