'use strict'
// Chat's space and message shapes, cut down to what the lanes, triage, the marks and the CLI need
// (design "Fetching"), and the old connector's rule for what is new in a space (its `space_convs`,
// ported with its reasons). This is what state.json keeps per space: no full bodies, no cards, no
// attachments (those are read fresh when a conversation is opened).

const { cut, oneLine, firstLine, userName, threadName, messageName } = require('./util')
const { htmlToText } = require('./sanitize')
const T = require('./time')

const ALL = 'users/all' // an @all mention (Chat names no user, or users/all)
const CONTEXT = 3 // messages before the new ones that triage reads as context
const TEXT_MAX = 4000 // a kept message's text (triage reads at most 1500 of it)

/** A space as kept: its kind, threading, name and activity. */
function compactSpace(s) {
  const type = s.spaceType === 'DIRECT_MESSAGE' || s.spaceType === 'GROUP_CHAT' ? s.spaceType : 'SPACE'
  const mc = s.membershipCount && typeof s.membershipCount === 'object' ? s.membershipCount : null
  const members = mc ? (Number(mc.joinedDirectHumanUserCount) || 0) + (Number(mc.joinedGroupCount) || 0) : null
  return {
    name: s.name,
    type,
    // DMs and group chats report THREADED_MESSAGES too, but people talk in them as one flat
    // conversation (old connector): only a SPACE that is threaded has threads as conversations.
    threaded: type === 'SPACE' && s.spaceThreadingState === 'THREADED_MESSAGES',
    threading: typeof s.spaceThreadingState === 'string' ? s.spaceThreadingState : '',
    title: cut(oneLine(typeof s.displayName === 'string' ? s.displayName : ''), 200),
    active: typeof s.lastActiveTime === 'string' ? s.lastActiveTime : '',
    botDm: s.singleUserBotDm === true,
    members: members && members > 0 ? members : null,
  }
}

/** What the conversation kind of a key is: dm, group, thread or space (a flat one). */
function kindOf(space, key) {
  if (space.type === 'DIRECT_MESSAGE') return 'dm'
  if (space.type === 'GROUP_CHAT') return 'group'
  return key !== space.name ? 'thread' : 'space'
}

/**
 * The text of a bot's cards (v1 and v2): header title and subtitle, text rows, button labels, as
 * plain text (a card's text may hold Chat's HTML subset).
 */
function cardsText(m) {
  const lines = []
  for (const card of cardList(m)) {
    const head = card.header || {}
    const title = [head.title, head.subtitle].filter((x) => typeof x === 'string' && x).join(' · ')
    if (title) lines.push(title)
    for (const sec of Array.isArray(card.sections) ? card.sections : []) {
      if (sec && typeof sec.header === 'string' && sec.header) lines.push(htmlToText(sec.header))
      for (const w of Array.isArray(sec && sec.widgets) ? sec.widgets : []) {
        if (!w || typeof w !== 'object') continue
        if (w.textParagraph && typeof w.textParagraph.text === 'string') lines.push(htmlToText(w.textParagraph.text))
        for (const k of ['decoratedText', 'keyValue']) {
          const d = w[k]
          if (!d || typeof d !== 'object') continue
          const label = typeof d.topLabel === 'string' ? d.topLabel : ''
          const text = typeof d.text === 'string' ? d.text : typeof d.content === 'string' ? d.content : ''
          if (text) lines.push(`${label ? `${htmlToText(label)}: ` : ''}${htmlToText(text)}`)
        }
      }
    }
    if (lines.length > 60) break
  }
  return lines.filter(Boolean).join('\n')
}

/** The cards of a message: cardsV2's `card`s and the old `cards`. */
function cardList(m) {
  const out = []
  for (const c of Array.isArray(m.cardsV2) ? m.cardsV2 : []) if (c && c.card && typeof c.card === 'object') out.push(c.card)
  for (const c of Array.isArray(m.cards) ? m.cards : []) if (c && typeof c === 'object') out.push(c)
  return out.slice(0, 20)
}

/**
 * A message as kept: `{ id, thread, sender, bot, senderName, text, at, mentions, mentionNames, reply,
 * deleted }`. `mentions` lists the user ids it @mentions (ALL for @all); `mentionNames` the display
 * names Chat put on those annotations. `reply`: a reply inside a thread, not its first message (Chat's
 * `threadReply`; else the first message's id is `<thread id>.<thread id>`, old connector).
 */
function compactMessage(m) {
  const sender = m.sender && typeof m.sender === 'object' ? m.sender : {}
  const thread = m.thread && threadName(m.thread.name) ? m.thread.name : null
  const mentions = []
  const mentionNames = {}
  for (const a of Array.isArray(m.annotations) ? m.annotations : []) {
    if (!a || a.type !== 'USER_MENTION' || !a.userMention || typeof a.userMention !== 'object') continue
    const u = a.userMention.user || {}
    const id = typeof u.name === 'string' && userName(u.name) ? u.name : !u.name ? ALL : null
    if (!id) continue
    if (!mentions.includes(id)) mentions.push(id)
    if (id !== ALL && typeof u.displayName === 'string' && u.displayName.trim()) mentionNames[id] = cut(oneLine(u.displayName), 100)
  }
  let reply = false
  if (typeof m.threadReply === 'boolean') reply = m.threadReply
  else if (thread) {
    const root = thread.split('/').pop()
    reply = !String(m.name).endsWith(`/${root}.${root}`)
  }
  const deleted = Boolean(m.deleteTime || m.deletionMetadata)
  let text = typeof m.text === 'string' && m.text.trim() ? m.text : ''
  if (!text) text = cardsText(m)
  if (!text && Array.isArray(m.attachment) && m.attachment.length) text = `(attachment: ${m.attachment.map((a) => (a && a.contentName) || 'file').slice(0, 5).join(', ')})`
  return {
    id: m.name,
    thread,
    sender: userName(sender.name) || '',
    bot: sender.type === 'BOT',
    senderName: typeof sender.displayName === 'string' ? cut(oneLine(sender.displayName), 100) : '',
    text: deleted ? '(deleted)' : cut(text.replace(/\r\n?/g, '\n').trim(), TEXT_MAX),
    at: T.normalise(m.createTime) || '',
    mentions,
    mentionNames,
    reply,
    deleted,
  }
}

/** Whether a kept message is one of the person's own (`me` unknown: none is). */
function isMine(m, me) {
  return Boolean(me) && m.sender === me
}

/** Whether it @mentions the person by name. */
function mentionsMeDirectly(m, me) {
  return Boolean(me) && m.mentions.includes(me)
}

/** Whether it @mentions the person or everyone. */
function mentionsMe(m, me) {
  return mentionsMeDirectly(m, me) || m.mentions.includes(ALL)
}

/** How the thread's start (when in view, from someone else) @mentions the person: 'me', 'all' or null. */
function mentionedStart(msgs, me) {
  const start = msgs.find((m) => !m.reply && !isMine(m, me))
  if (!start) return null
  return mentionsMeDirectly(start, me) ? 'me' : start.mentions.includes(ALL) ? 'all' : null
}

/**
 * The messages of one space read this poll, grouped by conversation (a thread in a threaded space,
 * else the space), oldest first: `{ groups: Map<key, msg[]>, ask: string[] }`. `ask` lists the
 * threads whose own read time decides (a message of others in it @mentions the person or @all, or
 * its start does): their read times are asked before `conversations`.
 */
function groupMessages(space, msgs, me) {
  const sorted = [...msgs].filter((m) => m && m.at).sort((a, b) => T.compare(a.at, b.at))
  const groups = new Map()
  for (const m of sorted) {
    const key = space.threaded && m.thread ? m.thread : space.name
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(m)
  }
  const ask = []
  for (const [key, ms] of groups) {
    if (key === space.name) continue
    if (ms.some((m) => !isMine(m, me) && mentionsMe(m, me))) ask.push(key)
  }
  return { groups, ask }
}

/**
 * The conversations of one space (design "What is new", the old connector's rule, as Chat's sidebar
 * counts). In a DM, group chat or flat space every message of others after the space's read time is
 * new. In a threaded space: a thread's start against the space's read time; a reply only when it
 * @mentions the person (or @all), against the thread's read time (the space's when the thread is not
 * followed); in a thread whose start @mentions the person (or @all), every reply, against both read
 * times. Other replies are not new (Chat shows them only as counts inside the space).
 *
 * @param {object} o
 * @param {object} o.space compactSpace
 * @param {Map<string, object[]>} o.groups groupMessages' groups
 * @param {string|null} o.last the space's read time
 * @param {Record<string, string|null>} o.threadSeen thread -> its read time (null: not followed), for the asked threads
 * @param {string} o.me the person's user id ('' unknown)
 * @param {number} o.recentSince ms: a read conversation newer than this is kept (Recent)
 * @param {number} o.recentPerSpace
 * @returns {object[]} conversations: unread ones, then the newest read ones
 */
function conversations(o) {
  const { space, groups, last, threadSeen, me } = o
  const out = []
  const old = []
  for (const [key, msgs] of groups) {
    const others = msgs.filter((m) => !isMine(m, me))
    if (!others.length) continue
    let followed = null
    let newMsgs
    const isThread = key !== space.name
    if (isThread) {
      const own = Object.prototype.hasOwnProperty.call(threadSeen, key) ? threadSeen[key] : undefined
      const seen = own || last
      followed = mentionedStart(msgs, me)
      newMsgs = others.filter((m) => (m.reply ? (mentionsMe(m, me) && T.after(m.at, seen)) || (followed && T.after(m.at, last) && T.after(m.at, own || null)) : T.after(m.at, last)))
    } else {
      newMsgs = others.filter((m) => T.after(m.at, last))
    }
    const base = {
      id: key,
      space: space.name,
      thread: isThread ? key : null,
      kind: kindOf(space, key),
      followed,
      ...(isThread && Object.prototype.hasOwnProperty.call(threadSeen, key) ? { threadRead: threadSeen[key] } : {}),
    }
    if (newMsgs.length) {
      const at = msgs.indexOf(newMsgs[0])
      const before = msgs.slice(0, at)
      // A reply whose thread started out of view: the poll reads the thread's start for context.
      const needStart = isThread && before.length < CONTEXT && msgs[0].reply
      out.push({ ...base, unread: true, new: newMsgs, context: before.slice(-CONTEXT), latest: newMsgs[newMsgs.length - 1], ...(needStart ? { needStart: true } : {}) })
    } else {
      const latest = others[others.length - 1]
      if (T.ms(latest.at) < o.recentSince) continue
      const at = msgs.indexOf(latest)
      old.push({ ...base, unread: false, new: [], context: msgs.slice(Math.max(0, at - CONTEXT), at), latest })
    }
  }
  old.sort((a, b) => T.compare(a.latest.at, b.latest.at))
  return [...out, ...old.slice(-Math.max(1, o.recentPerSpace || 3))]
}

/** The message that started a thread conversation (or the first in view), for the row's title. */
function threadStart(conv) {
  const msgs = [...conv.context, ...conv.new, conv.latest]
  return msgs.find((m) => !m.reply) || msgs[0]
}

/** Every user id a conversation names: senders and mentions (the names to resolve). */
function userIds(conv) {
  const ids = new Set()
  for (const m of [...conv.context, ...conv.new, conv.latest]) {
    if (m.sender && !m.bot) ids.add(m.sender)
    for (const u of m.mentions) if (u !== ALL) ids.add(u)
  }
  return [...ids]
}

/** The first line of a message as a title or a preview: text, else "(no text)". */
function titleLine(m) {
  return cut(firstLine(m && m.text) || '(no text)', 200)
}

module.exports = { ALL, CONTEXT, compactSpace, compactMessage, cardsText, cardList, kindOf, isMine, mentionsMe, mentionsMeDirectly, mentionedStart, groupMessages, conversations, threadStart, userIds, titleLine, messageName }
