'use strict'
// What is new in a space (the old connector's rule), the kept shapes, the alert groups and the lanes.
const test = require('node:test')
const assert = require('node:assert/strict')
const { compactSpace, compactMessage, groupMessages, conversations, threadStart, userIds, titleLine, cardsText, ALL } = require('../dist/lib/model')
const { parseAlert, groupAlerts, groupTitle } = require('../dist/lib/alerts')
const { sortRows, unreadLane } = require('../dist/lib/lanes')
const { msg, ago, U, NOW } = require('./fakes')

const ME = U.me
const SP = 'spaces/TEAM'
const threaded = compactSpace({ name: SP, spaceType: 'SPACE', displayName: 'Acme Team', spaceThreadingState: 'THREADED_MESSAGES', lastActiveTime: ago(1) })
const flat = compactSpace({ name: 'spaces/FLAT', spaceType: 'SPACE', displayName: 'Acme Flat', spaceThreadingState: 'GROUPED_MESSAGES', lastActiveTime: ago(1) })
const dm = compactSpace({ name: 'spaces/DM', spaceType: 'DIRECT_MESSAGE', spaceThreadingState: 'THREADED_MESSAGES', lastActiveTime: ago(1) })

function convsOf(space, raws, last, threadSeen = {}) {
  const { groups, ask } = groupMessages(space, raws.map(compactMessage), ME)
  return { ask, convs: conversations({ space, groups, last, threadSeen, me: ME, recentSince: NOW - 2 * 86400000, recentPerSpace: 3 }) }
}

test('compactSpace: kind, threading (a DM is flat even when Chat says threaded), members', () => {
  assert.equal(threaded.threaded, true)
  assert.equal(flat.threaded, false)
  assert.equal(dm.type, 'DIRECT_MESSAGE')
  assert.equal(dm.threaded, false)
  assert.equal(compactSpace({ name: 'spaces/X', spaceType: 'SPACE', membershipCount: { joinedDirectHumanUserCount: 3, joinedGroupCount: 1 } }).members, 4)
  assert.equal(compactSpace({ name: 'spaces/X', spaceType: 'WEIRD' }).type, 'SPACE')
})

test('compactMessage: mentions (users/all as ALL), names on the annotations, reply, bot, cards, deleted', () => {
  const m = compactMessage({
    name: `${SP}/messages/R1`,
    sender: { name: U.bob, type: 'HUMAN' },
    createTime: ago(5),
    text: 'hi <users/1001> <users/all>',
    thread: { name: `${SP}/threads/T1` },
    threadReply: true,
    annotations: [
      { type: 'USER_MENTION', userMention: { user: { name: U.me, displayName: 'Me Example' } } },
      { type: 'USER_MENTION', userMention: { user: { name: 'users/all' } } },
      { type: 'SLASH_COMMAND' },
    ],
  })
  assert.deepEqual(m.mentions, [U.me, ALL])
  assert.deepEqual(m.mentionNames, { [U.me]: 'Me Example' })
  assert.equal(m.reply, true)
  assert.equal(m.thread, `${SP}/threads/T1`)
  assert.equal(m.at, T_(ago(5)))
  const start = compactMessage({ name: `${SP}/messages/T1.T1`, sender: { name: U.bob }, createTime: ago(9), text: 'x', thread: { name: `${SP}/threads/T1` } })
  assert.equal(start.reply, false, 'the start of a thread is <thread>.<thread> when threadReply is absent')
  const bot = compactMessage({ name: `${SP}/messages/B`, sender: { name: U.grafana, type: 'BOT', displayName: 'Grafana' }, createTime: ago(2), cardsV2: [{ card: { header: { title: 'HighCPU' }, sections: [{ widgets: [{ textParagraph: { text: '<b>node-1</b> is hot' } }] }] } }] })
  assert.equal(bot.bot, true)
  assert.equal(bot.text, 'HighCPU\nnode-1 is hot')
  assert.equal(compactMessage({ name: `${SP}/messages/D`, sender: { name: U.bob }, createTime: ago(1), text: 'secret', deletionMetadata: { deletionType: 'CREATOR' } }).text, '(deleted)')
  assert.equal(compactMessage({ name: `${SP}/messages/F`, sender: { name: U.bob }, createTime: ago(1), attachment: [{ contentName: 'plan.pdf' }] }).text, '(attachment: plan.pdf)')
})

function T_(t) {
  return require('../dist/lib/time').normalise(t)
}

test('a DM: every message of others after the read time is new; your own never', () => {
  const raws = [msg('spaces/DM', 'a', { from: U.ann, at: ago(50), text: 'old' }), msg('spaces/DM', 'b', { from: U.ann, at: ago(20), text: 'new 1' }), msg('spaces/DM', 'c', { from: U.me, at: ago(15), text: 'mine' }), msg('spaces/DM', 'd', { from: U.ann, at: ago(10), text: 'new 2' })]
  const { convs } = convsOf(dm, raws, ago(30))
  assert.equal(convs.length, 1)
  const c = convs[0]
  assert.equal(c.kind, 'dm')
  assert.equal(c.unread, true)
  assert.deepEqual(c.new.map((m) => m.text), ['new 1', 'new 2'])
  assert.deepEqual(c.context.map((m) => m.text), ['old'])
  assert.equal(c.latest.text, 'new 2')
  const read = convsOf(dm, raws, ago(5)).convs[0]
  assert.equal(read.unread, false)
  assert.equal(read.latest.text, 'new 2', 'a read row shows the newest message of others')
})

test('a threaded space: a new thread start is new; a reply alone is not, unless it @mentions you', () => {
  const raws = [
    msg(SP, 'T1.T1', { from: U.ann, at: ago(100), text: 'old start', thread: 'T1' }),
    msg(SP, 'R1', { from: U.bob, at: ago(10), text: 'plain reply', thread: 'T1', reply: true }),
    msg(SP, 'T2.T2', { from: U.cat, at: ago(9), text: 'new start', thread: 'T2' }),
    msg(SP, 'T3.T3', { from: U.ann, at: ago(200), text: 'another old start', thread: 'T3' }),
    msg(SP, 'R3', { from: U.bob, at: ago(8), text: 'hey <users/1001>', thread: 'T3', reply: true, mentions: [U.me] }),
  ]
  const { ask, convs } = convsOf(threaded, raws, ago(30), { [`${SP}/threads/T3`]: ago(60) })
  assert.deepEqual(ask, [`${SP}/threads/T3`], 'the thread read time is asked where a reply @mentions you')
  const by = Object.fromEntries(convs.map((c) => [c.thread, c]))
  assert.equal(by[`${SP}/threads/T1`].unread, false, 'a plain reply is not new')
  assert.equal(by[`${SP}/threads/T2`].unread, true)
  assert.equal(by[`${SP}/threads/T3`].unread, true)
  assert.equal(by[`${SP}/threads/T3`].threadRead, ago(60))
  // The thread read since the reply: not new, although the space is older.
  const again = convsOf(threaded, raws, ago(30), { [`${SP}/threads/T3`]: ago(5) }).convs
  assert.equal(again.find((c) => c.thread === `${SP}/threads/T3`).unread, false)
})

test('a thread whose start @mentions you: every reply after both read times is new (followed)', () => {
  const raws = [msg(SP, 'T1.T1', { from: U.bob, at: ago(100), text: 'plan <users/1001>', thread: 'T1', mentions: [U.me] }), msg(SP, 'R1', { from: U.cat, at: ago(10), text: 'a reply', thread: 'T1', reply: true })]
  const unfollowed = convsOf(threaded, raws, ago(30), { [`${SP}/threads/T1`]: null }).convs[0]
  assert.equal(unfollowed.followed, 'me')
  assert.equal(unfollowed.unread, true)
  assert.deepEqual(unfollowed.new.map((m) => m.text), ['a reply'])
  const seen = convsOf(threaded, raws, ago(30), { [`${SP}/threads/T1`]: ago(5) }).convs[0]
  assert.equal(seen.unread, false, 'the thread was read past the reply')
  const all = [msg(SP, 'T4.T4', { from: U.bob, at: ago(100), text: 'all hands <users/all>', thread: 'T4', mentions: ['all'] }), msg(SP, 'R4', { from: U.cat, at: ago(10), text: 'r', thread: 'T4', reply: true })]
  assert.equal(convsOf(threaded, all, ago(30)).convs[0].followed, 'all')
})

test('a reply whose thread started out of view asks for its start (context)', () => {
  const raws = [msg(SP, 'R1', { from: U.bob, at: ago(10), text: 'hey <users/1001>', thread: 'T9', reply: true, mentions: [U.me] })]
  const c = convsOf(threaded, raws, ago(30), { [`${SP}/threads/T9`]: null }).convs[0]
  assert.equal(c.needStart, true)
})

test('read conversations: the newest few of a space within the recent days, none older', () => {
  const raws = []
  for (let i = 0; i < 6; i++) raws.push(msg(SP, `T${i}.T${i}`, { from: U.ann, at: ago(100 + i), text: `t${i}`, thread: `T${i}` }))
  raws.push(msg(SP, 'OLD.OLD', { from: U.ann, at: ago(5 * 1440), text: 'ancient', thread: 'OLD' }))
  const { convs } = convsOf(threaded, raws, ago(1))
  assert.equal(convs.length, 3, 'recentPerSpace')
  assert.ok(!convs.some((c) => c.latest.text === 'ancient'))
  assert.deepEqual(convs.map((c) => c.latest.text), ['t2', 't1', 't0'])
})

test('threadStart, userIds, titleLine', () => {
  const raws = [msg(SP, 'T1.T1', { from: U.bob, at: ago(100), text: 'Plan\nmore', thread: 'T1', mentions: [U.cat] }), msg(SP, 'R1', { from: U.ann, at: ago(10), text: 'reply', thread: 'T1', reply: true, mentions: ['all'] })]
  const c = convsOf(threaded, raws, ago(300)).convs[0]
  assert.equal(threadStart(c).text, 'Plan\nmore')
  assert.deepEqual(userIds(c).sort(), [U.ann, U.bob, U.cat].sort())
  assert.equal(titleLine(threadStart(c)), 'Plan')
  assert.equal(titleLine({ text: '' }), '(no text)')
  assert.equal(cardsText({}), '')
})

test('alerts: Grafana first lines parsed; a firing node, resolved nodes gone; one row per alert name across spaces', () => {
  const bots = ['Grafana']
  const g = (text) => compactMessage({ name: 'spaces/A/messages/x', sender: { name: U.grafana, type: 'BOT', displayName: 'Grafana' }, createTime: ago(1), text })
  assert.deepEqual(parseAlert(g('[FIRING:2] HighCPU — node-1 (prod)'), bots), { name: 'HighCPU', node: 'node-1', resolved: false })
  assert.deepEqual(parseAlert(g('🔥 RESOLVED: HighCPU — node-1'), bots), { name: 'HighCPU', node: 'node-1', resolved: true })
  assert.equal(parseAlert(g('Deploy finished'), bots), null)
  assert.equal(parseAlert({ ...g('[FIRING:1] X — y'), senderName: 'Other bot' }, bots), null)
  assert.equal(parseAlert({ ...g('[FIRING:1] X — y'), bot: false }, bots), null)
  const conv = (space, id, msgs) => ({ id, space, unread: true, new: msgs, context: [], latest: msgs[msgs.length - 1] })
  const a = (space, n, text, min) => compactMessage({ name: `${space}/messages/${n}`, sender: { name: U.grafana, type: 'BOT', displayName: 'Grafana' }, createTime: ago(min), text })
  const convs = [
    conv('spaces/A', 'spaces/A', [a('spaces/A', 1, '[FIRING:1] HighCPU — node-1', 10), a('spaces/A', 2, '[FIRING:1] HighCPU — node-2', 9), a('spaces/A', 3, 'RESOLVED: HighCPU — node-1', 8)]),
    conv('spaces/B', 'spaces/B', [a('spaces/B', 4, '[FIRING:1] HighCPU — node-3', 7)]),
    conv('spaces/C', 'spaces/C', [a('spaces/C', 5, '[FIRING:1] DiskFull — db-1', 6), a('spaces/C', 6, 'RESOLVED: DiskFull — db-1', 5)]),
    conv('spaces/D', 'spaces/D', [a('spaces/D', 7, '[FIRING:1] HighCPU — node-9', 4), compactMessage({ name: 'spaces/D/messages/8', sender: { name: U.ann }, createTime: ago(3), text: 'looking' })]),
  ]
  const { groups, rest } = groupAlerts(convs, bots, { 'spaces/A': 'Acme Alerts', 'spaces/B': 'Acme Ops' })
  assert.deepEqual(rest.map((c) => c.id), ['spaces/D'], 'a conversation with a human message stays a conversation')
  assert.equal(groups.length, 1, 'DiskFull resolved everywhere: no row')
  const h = groups[0]
  assert.equal(h.id, 'alert:HighCPU')
  assert.deepEqual(h.nodes.sort(), ['node-2', 'node-3'])
  assert.equal(h.spaces.length, 2)
  assert.deepEqual(Object.keys(h.targets).sort(), ['spaces/A', 'spaces/B'])
  assert.match(groupTitle(h), /^HighCPU: /)
})

test('lanes: a direct @mention outside a DM is Mentions; DMs and group chats Direct; the rest Spaces; sort by priority then time', () => {
  assert.equal(unreadLane({ kind: 'thread' }, true), 'mentions')
  assert.equal(unreadLane({ kind: 'dm' }, true), 'direct', 'a DM never goes to Mentions')
  assert.equal(unreadLane({ kind: 'group' }, false), 'direct')
  assert.equal(unreadLane({ kind: 'space' }, false), 'spaces')
  const rows = sortRows([
    { id: 'a', at: 1, verdict: { priority: 'fyi' } },
    { id: 'b', at: 5, verdict: null },
    { id: 'c', at: 2, verdict: { priority: 'urgent' } },
    { id: 'd', at: 9, verdict: { priority: 'fyi' } },
  ])
  assert.deepEqual(rows.map((r) => r.id), ['c', 'd', 'a', 'b'])
})
