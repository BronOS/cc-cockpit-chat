'use strict'
// A conversation as readable plain text: what `ccc chat show` prints, what the reviewer shows in its
// text mode, and what Discuss / New session hand to Claude (design: `About the Google Chat
// conversation "<title>" in <space>` + the readable text). No link to Chat (answer 2).

const { cut, oneLine, stamp } = require('./util')
const { cardsText } = require('./model')
const { mentionText } = require('./names')
const T = require('./time')

const MESSAGE_TEXT_MAX = 20000
const PROMPT_MAX = 16000

/** One message's text: its plain text (mentions as `@Name`), else its cards' text. */
function messageText(raw, nameOf, me) {
  if (raw.deleteTime || raw.deletionMetadata) return '(deleted)'
  const text = typeof raw.text === 'string' && raw.text.trim() ? mentionText(raw.text, nameOf, me) : cardsText(raw)
  return cut(String(text || '').replace(/\r\n?/g, '\n').trim(), MESSAGE_TEXT_MAX)
}

/**
 * The conversation as text, oldest message first: the title, where it is, then per message who,
 * when, its text, its files. Unread messages are marked `[unread]`.
 *
 * @param {{ title: string, where: string, messages: object[], note?: string, senderOf: Function, isUnread: Function, nameOf?: Function, me?: string }} c
 */
function readableText(c) {
  const msgs = [...c.messages].sort((a, b) => T.compare(a.createTime, b.createTime))
  const lines = [oneLine(c.title) || '(no text)']
  if (c.where) lines.push(c.where)
  if (c.note) lines.push(`(${c.note})`)
  lines.push(`${msgs.length} message${msgs.length === 1 ? '' : 's'}, oldest first.`)
  for (const raw of msgs) {
    lines.push('', '-'.repeat(60), `${c.isUnread(raw) ? '[unread] ' : ''}${c.senderOf(raw)} · ${stamp(T.ms(raw.createTime)) || '-'}`)
    const q = raw.quotedMessageMetadata && raw.quotedMessageMetadata.quotedMessageSnapshot
    if (q && typeof q.text === 'string' && q.text.trim()) lines.push(`> ${cut(oneLine(q.text), 500)}`)
    lines.push('', messageText(raw, c.nameOf, c.me) || '(no text)')
    const files = (Array.isArray(raw.attachment) ? raw.attachment : []).map((a) => a && (a.contentName || 'attachment')).filter(Boolean)
    if (files.length) lines.push('', `Attachments: ${files.join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * What Discuss and New session hand to Claude: it starts `About the Google Chat conversation
 * "<title>" in <space>` (never `/`, `!`, `#` or `&`, which the app refuses), then the readable text,
 * capped.
 */
function discussPrompt(title, where, text, max = PROMPT_MAX) {
  const head = `About the Google Chat conversation "${cut(oneLine(title) || '(no text)', 200)}" in ${cut(oneLine(where) || 'Google Chat', 120)}`
  const body = `${head}\n\nThe conversation as it is now (the plugin changes nothing in Google Chat but the read state):\n\n${text}`
  return cut(body, max)
}

module.exports = { readableText, messageText, discussPrompt, PROMPT_MAX }
