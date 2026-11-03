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

/** A row's age, short: "now", "5m", "3h", "2d", then "Oct 3" (a lane holds at most a few weeks). */
function ageText(ms, now) {
  if (!ms) return ''
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** The small pill of an alert row: "3 firing". */
function alertBadge(r) {
  if (r.kind !== 'alert') return ''
  return `${r.firing || r.count} firing`
}

if (typeof module !== 'undefined' && module.exports) module.exports = { rowKeyAction, rowClickOpens, rowButtons, moveIndex, ageText, alertBadge }
