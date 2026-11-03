'use strict'
// The panel's row decisions (panels/rowlogic.js, free of the DOM) and the page sources' rules: no
// inline script, untrusted text only through textContent, no link to Chat.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { rowKeyAction, rowClickOpens, rowButtons, moveIndex, ageText, alertBadge } = require('../panels/rowlogic')

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

test('ages and the alert pill', () => {
  assert.equal(ageText(NOW - 10000, NOW), 'now')
  assert.equal(ageText(NOW - 5 * 60000, NOW), '5m')
  assert.equal(ageText(NOW - 3 * 3600000, NOW), '3h')
  assert.equal(ageText(NOW - 2 * 86400000, NOW), '2d')
  assert.equal(ageText(Date.parse('2026-10-03T08:00:00Z'), NOW), 'Oct 3')
  assert.equal(ageText(0, NOW), '')
  assert.equal(alertBadge({ kind: 'alert', firing: 2, count: 3 }), '2 firing')
  assert.equal(alertBadge({ kind: 'conv' }), '')
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
