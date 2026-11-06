'use strict'
// The panel's row decisions (panels/rowlogic.js, free of the DOM) and the page sources' rules: no
// inline script, untrusted text only through textContent, no link to Chat.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
// Local time is Berlin so the time column's boundaries are checkable.
process.env.TZ = 'Europe/Berlin'
const { rowKeyAction, rowClickOpens, rowButtons, moveIndex, whenText, fullTimeText, rowView, alertBadge } = require('../panels/rowlogic')

const ROOT = path.join(__dirname, '..')
const NOW = Date.parse('2026-11-03T08:00:00Z')

test('keys on a row: Enter and Space open, arrows move, modifiers and buttons are left alone', () => {
  assert.equal(rowKeyAction('Enter', true), 'open')
  assert.equal(rowKeyAction(' ', true), 'open')
  assert.equal(rowKeyAction('ArrowDown', true), 'next')
  assert.equal(rowKeyAction('ArrowUp', true), 'prev')
  assert.equal(rowKeyAction('Home', true), 'first')
  assert.equal(rowKeyAction('End', true), 'last')
  assert.equal(rowKeyAction('Enter', false), null, 'Enter on a button is its click')
  assert.equal(rowKeyAction('Enter', true, { meta: true }), null)
  assert.equal(rowKeyAction('x', true), null)
  assert.equal(rowClickOpens(false, false), true)
  assert.equal(rowClickOpens(true, false), false)
  assert.equal(rowClickOpens(false, true), false)
  assert.equal(moveIndex('next', 2, 3), null)
  assert.equal(moveIndex('next', 1, 3), 2)
  assert.equal(moveIndex('prev', 0, 3), null)
  assert.equal(moveIndex('last', 0, 3), 2)
  assert.equal(moveIndex('first', 2, 0), null)
})

test('row buttons: triage, Mark read on an unread row, Mark unread on a read one, Discuss, New; never an open-in-Chat', () => {
  const unread = rowButtons({ kind: 'conv', unread: true, canRead: true, verdict: { priority: 'action' } }, { triageOn: true })
  assert.deepEqual(unread.map((b) => b.action), ['wrong', 'read', 'discuss', 'newSession'])
  assert.equal(unread[0].label, 'action ▾')
  assert.equal(unread[1].label, 'Mark read')
  const read = rowButtons({ kind: 'conv', unread: false, canUnread: true }, { triageOn: false })
  assert.deepEqual(read.map((b) => b.action), ['unread', 'discuss', 'newSession'])
  assert.equal(read[0].label, 'Mark unread')
  const noTarget = rowButtons({ kind: 'conv', unread: false, noTarget: true }, { triageOn: true })
  assert.deepEqual(noTarget.map((b) => b.action), ['wrong', 'discuss', 'newSession'])
  const alert = rowButtons({ kind: 'alert', unread: true, canRead: true, pending: true }, { triageOn: false })
  assert.equal(alert[0].action, 'read')
  assert.equal(alert[0].disabled, true, 'a mark on its way: the button waits')
  assert.match(alert[0].title, /alert messages/)
  for (const set of [unread, read, noTarget, alert]) assert.ok(!set.some((b) => b.action === 'browser' || /Open in|↗/.test(b.label + b.title)))
})

test('the time column: now, minutes, hours the same day, Yesterday, the weekday, the date, another year', () => {
  // T is Tue 3 Nov 2026, 13:42 in Berlin: every boundary in local time.
  const T = Date.parse('2026-11-03T13:42:00+01:00')
  const W = (s, now = T) => whenText(Date.parse(s), now)
  assert.equal(whenText(T - 10000, T), 'now')
  assert.equal(whenText(T - 60000, T), '1m')
  assert.equal(whenText(T - 39 * 60000, T), '39m')
  assert.equal(whenText(T - 3 * 3600000, T), '3h')
  assert.equal(W('2026-11-03T00:00:00+01:00'), '13h', 'local midnight is still today')
  assert.equal(W('2026-11-02T23:59:00+01:00'), 'Yesterday')
  assert.equal(W('2026-11-01T12:00:00+01:00'), 'Sun')
  assert.equal(W('2026-10-28T00:00:00+01:00'), 'Wed', '6 days back: a weekday')
  assert.equal(W('2026-10-27T23:59:00+01:00'), '27 Oct', '7 days back: the date')
  assert.equal(W('2026-10-25T01:00:00+02:00'), '25 Oct', 'over the DST change, in calendar days')
  assert.equal(W('2026-10-29T12:00:00+01:00', Date.parse('2026-10-30T00:30:00+01:00')), 'Yesterday', 'at 00:30 a message of noon is Yesterday, not 12h')
  assert.equal(W('2026-10-29T23:50:00+01:00', Date.parse('2026-10-30T00:30:00+01:00')), '40m')
  assert.equal(W('2026-01-01T00:00:00+01:00'), '1 Jan')
  assert.equal(W('2025-12-31T23:59:00+01:00'), '31 Dec 2025')
  assert.equal(whenText(T + 5 * 60000, T), 'now', 'a clock a little ahead')
  assert.equal(W('2026-11-05T10:00:00+01:00'), '5 Nov')
  for (const bad of [0, null, undefined, NaN, '1']) assert.equal(whenText(bad, T), '')
  assert.equal(fullTimeText(Date.parse('2026-11-06T09:21:00+01:00')), 'Fri 6 Nov 2026, 09:21')
  assert.equal(fullTimeText(0), '')
  assert.equal(alertBadge({ kind: 'alert', firing: 2, count: 3 }), '2 firing')
  assert.equal(alertBadge({ kind: 'conv' }), '')
})

test('row view: space · sender, then the message; a DM is the person; a thread with a reply is Space › thread; the meta repeats neither', () => {
  // A flat space: the title is the space; the old sub line ("Max Example: Thank you") is not drawn.
  const sp = rowView({ kind: 'conv', conv: 'space', title: 'Acme Team', where: 'Acme Team', from: 'Max Example', preview: 'Thank you', sub: 'Max Example: Thank you', count: 1 })
  assert.deepEqual(sp, { head: { dm: false, place: 'Acme Team', thread: '', from: 'Max Example' }, message: 'Thank you', meta: [] })
  // A DM: the person (the title), never "Direct message" (where) nor "you" (the latest sender).
  const dm = rowView({ kind: 'conv', conv: 'dm', title: 'Bob Example', where: 'Direct message', from: 'you', preview: 'ok, merged', count: 2 })
  assert.deepEqual(dm, { head: { dm: true, place: 'Bob Example', thread: '', from: '' }, message: 'ok, merged', meta: ['2 new'] })
  // A thread whose latest is a reply: its start names it; a mention is in the meta.
  const th = rowView({ kind: 'conv', conv: 'thread', title: 'Failover alerts before the call?', where: 'Alerts', from: 'Ann Example', preview: 'the second spike is at 08:12', mentioned: 'me', count: 1 })
  assert.deepEqual(th, { head: { dm: false, place: 'Alerts', thread: 'Failover alerts before the call?', from: 'Ann Example' }, message: 'the second spike is at 08:12', meta: ['mentions you'] })
  // A thread whose start is the message shown (cut with an ellipsis in the title): just the space.
  assert.equal(rowView({ kind: 'conv', conv: 'thread', title: 'Lunch at…', where: 'Acme Team', from: 'Ann Example', preview: 'Lunch at noon today?' }).head.thread, '')
  // A group chat of one other person: the sender is the place, said once. @all in the meta.
  const g = rowView({ kind: 'conv', conv: 'group', title: 'Ann Example', where: 'Ann Example', from: 'Ann Example', preview: 'hi', mentioned: 'all' })
  assert.deepEqual([g.head.from, g.meta], ['', ['mentions @all']])
  // An alert row: the alert leads, its spaces are the second line, no new count (the firing pill says it).
  const al = rowView({ kind: 'alert', title: 'HighCPU: node-1', from: 'Grafana (bot)', sub: 'Acme Alerts', count: 3 })
  assert.deepEqual(al, { head: { dm: false, place: 'HighCPU: node-1', thread: '', from: 'Grafana (bot)' }, message: 'Acme Alerts', meta: [] })
})

test('the pages: no inline script, untrusted text never as markup, no link to Chat', () => {
  for (const f of ['panels/main.html', 'panels/thread.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    for (const [, attrs, body] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      assert.match(attrs, /src=/, `${f}: an inline script`)
      assert.equal(body.trim(), '')
    }
    assert.ok(!/\son[a-z]+=/i.test(html), `${f}: an inline handler`)
    assert.ok(!/<form/i.test(html), `${f}: a form (panels have no allow-forms)`)
    assert.ok(!/chat\.google\.com|id="browser"/.test(html), `${f}: a link to Chat`)
  }
  const main = fs.readFileSync(path.join(ROOT, 'panels/main.js'), 'utf8')
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(main), 'main.js builds with textContent only')
  assert.ok(!/chat\.google\.com|'browser'/.test(main))
  const reader = fs.readFileSync(path.join(ROOT, 'panels/thread.js'), 'utf8')
  assert.ok(!/'browser'/.test(reader))
  assert.match(reader, /function clean\(root\)/, 'the reader cleans the host html again')
})
