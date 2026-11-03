'use strict'
// The opened conversation as one HTML document (the reviewer's HTML mode, and the plugin's own reader
// page; design "The conversation view"): the title, then each message oldest first as a card
// (sender, time, an "unread" mark, the message it quotes, its text as format.js builds it, a bot's
// cards, its pictures and files, its reactions), and the details column (`aside`): space, kind,
// threading, members, messages shown, unread. No link to Chat anywhere (answer 2). This file writes
// only fixed markup around the built bodies, with the classes the reviewer's allow-list keeps (card,
// card-header, meta, new, lozenge, lozenge-info, facts, person, attachment-list, muted), and escapes
// every value it puts in.
//
// Size: the reviewer takes at most 2 MiB of html and 100,000 characters of aside. When the cards do
// not fit, the oldest messages give way first, with a line that says how many are left out.

const { esc } = require('./entities')
const { chatHtml, cardsHtml } = require('./format')
const { cardList } = require('./model')
const { partKey, RASTER } = require('./images')
const { stamp, cut } = require('./util')
const T = require('./time')

const HTML_MAX_BYTES = 2000000
const ASIDE_MAX = 90000
const bytes = (s) => Buffer.byteLength(s, 'utf8')

const KIND = { dm: 'Direct message', group: 'Group chat', thread: 'Thread in a space', space: 'Space', alert: 'Alerts' }
const THREADING = { THREADED_MESSAGES: 'threaded', GROUPED_MESSAGES: 'grouped (no threads)', UNTHREADED_MESSAGES: 'unthreaded' }

/** The pictures of a message worth downloading: uploaded raster files with a media resource. */
function pictureParts(raw) {
  const out = []
  for (const a of Array.isArray(raw.attachment) ? raw.attachment : []) {
    const ref = a && a.attachmentDataRef && a.attachmentDataRef.resourceName
    if (a && a.source === 'UPLOADED_CONTENT' && RASTER.has(a.contentType) && typeof ref === 'string' && typeof a.name === 'string') {
      out.push({ messageId: raw.name, partId: a.name, mime: a.contentType, size: null, at: T.ms(raw.createTime), inline: false, name: cut(a.contentName || 'image', 200), resourceName: ref })
    }
  }
  return out
}

/** A Drive file's link, when its id is one (a file, not Chat: answer 2 is about Chat links). */
function driveUrl(a) {
  const id = a && a.driveDataRef && a.driveDataRef.driveFileId
  return typeof id === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(id) ? `https://drive.google.com/open?id=${id}` : null
}

/**
 * @param {object} o
 * @param {string} o.title
 * @param {object[]} o.messages raw Chat messages, any order (sorted here, oldest first)
 * @param {(raw: object) => string} o.senderOf the sender's name as the person reads it
 * @param {(userId: string) => string} o.nameOf a mentioned user's name
 * @param {(raw: object) => boolean} o.isUnread
 * @param {Map<string, string>} [o.assets] images.partKey -> asset id of the pictures downloaded
 * @param {string} [o.note] a line above the messages (older messages left out, an alert group)
 * @param {object} [o.facts] the details column: `{ space, kind, threading, members, unread }`; built only with `aside`
 * @param {boolean} [o.aside]
 * @returns {{ html: string, aside?: string, omitted: number }}
 */
function conversationDocument(o) {
  const assets = o.assets || new Map()
  const msgs = [...o.messages].sort((a, b) => T.compare(a.createTime, b.createTime))
  const cards = msgs.map((raw) => messageCard(raw, o, assets))
  const parts = [`<div class="card"><h1>${esc(o.title || '(no text)')}</h1>${o.aside || !o.facts ? '' : `\n<div class="meta">${esc(headerMeta(o.facts, msgs.length))}</div>`}</div>`]
  if (o.note) parts.push(`<p class="muted"><em>${esc(o.note)}</em></p>`)
  let room = HTML_MAX_BYTES - bytes(parts.join('\n')) - 2000
  const kept = []
  for (let i = cards.length - 1; i >= 0; i--) {
    const b = bytes(cards[i]) + 1
    if (b > room) break
    room -= b
    kept.unshift(cards[i])
  }
  const omitted = cards.length - kept.length
  if (omitted) parts.push(`<p><em>${omitted} earlier message${omitted === 1 ? ' is' : 's are'} not shown here (too long together).</em></p>`)
  parts.push(...kept)
  const out = { html: parts.join('\n'), omitted }
  if (o.aside) out.aside = details(o.facts || {}, msgs.length)
  return out
}

function headerMeta(f, shown) {
  return [f.space, KIND[f.kind] || '', `${shown} message${shown === 1 ? '' : 's'}`, f.unread ? `${f.unread} unread` : ''].filter(Boolean).join(' · ')
}

/** One message as a card. */
function messageCard(raw, o, assets) {
  const unread = o.isUnread(raw)
  const when = T.ms(raw.createTime)
  const head = `<div class="card-header"><strong>${esc(o.senderOf(raw))}</strong> · ${esc(stamp(when))}${unread ? ' · <span class="lozenge lozenge-info">unread</span>' : ''}</div>`
  const body = []
  const q = raw.quotedMessageMetadata && raw.quotedMessageMetadata.quotedMessageSnapshot
  if (q && typeof q === 'object') {
    const who = typeof q.sender === 'string' ? (/^users\//.test(q.sender) ? o.nameOf(q.sender) || 'someone' : q.sender) : ''
    const text = typeof q.formattedText === 'string' ? q.formattedText : typeof q.text === 'string' ? q.text : ''
    body.push(`<blockquote>${who ? `<strong>${esc(cut(who, 100))}</strong><br>` : ''}${chatHtml(cut(text, 5000), o.nameOf)}</blockquote>`)
  }
  const deleted = Boolean(raw.deleteTime || raw.deletionMetadata)
  const cards = cardList(raw)
  if (deleted) body.push('<p><em>(deleted)</em></p>')
  else {
    const text = typeof raw.formattedText === 'string' && raw.formattedText.trim() ? raw.formattedText : typeof raw.text === 'string' ? raw.text : ''
    if (text.trim()) body.push(`<div>${chatHtml(text, o.nameOf)}</div>`)
    if (cards.length) body.push(cardsHtml(cards))
    if (!text.trim() && !cards.length && !(raw.attachment || []).length) body.push('<p><em>(no text)</em></p>')
  }
  const files = deleted ? '' : attachmentsHtml(raw, assets)
  const react = reactions(raw)
  return `<div class="card${unread ? ' new' : ''}">${head}\n${body.join('\n')}${files ? `\n${files}` : ''}${react ? `\n<div class="meta">${react}</div>` : ''}</div>`
}

/** Pictures downloaded as figures; other files by name (a Drive file linked). */
function attachmentsHtml(raw, assets) {
  const items = []
  for (const a of Array.isArray(raw.attachment) ? raw.attachment : []) {
    if (!a || typeof a !== 'object') continue
    const name = cut(a.contentName || 'attachment', 200)
    const asset = typeof a.name === 'string' ? assets.get(partKey({ messageId: raw.name, partId: a.name })) : null
    if (asset) {
      items.push(`<li><figure><img data-asset="${esc(asset)}" alt="${esc(name)}" title="${esc(name)}"><figcaption>${esc(name)}</figcaption></figure></li>`)
      continue
    }
    const drive = driveUrl(a)
    items.push(drive ? `<li><a href="${esc(drive)}">${esc(name)}</a> (Google Drive)</li>` : `<li>${esc(name)}${a.contentType ? ` · <span class="muted">${esc(cut(a.contentType, 80))}</span>` : ''}</li>`)
  }
  if (!items.length) return ''
  return `<div class="meta">Attachments (${items.length})</div><ul class="attachment-list">${items.join('')}</ul>`
}

/** The reactions as one line: `👍 3 · 🎉 1`. */
function reactions(raw) {
  const out = []
  for (const r of Array.isArray(raw.emojiReactionSummaries) ? raw.emojiReactionSummaries.slice(0, 30) : []) {
    if (!r || typeof r !== 'object') continue
    const e = r.emoji || {}
    const glyph = typeof e.unicode === 'string' && e.unicode.length <= 16 ? e.unicode : e.customEmoji ? ':custom:' : '🙂'
    const n = Math.max(1, Math.floor(Number(r.reactionCount) || 1))
    out.push(`${esc(glyph)} ${n}`)
  }
  return out.join(' · ')
}

/** The details column (reviewer `aside`). */
function details(f, shown) {
  const row = (label, value) => (value ? `<dt>${esc(label)}</dt><dd>${value}</dd>` : '')
  const html = [
    '<dl class="facts">',
    row('Space', f.space ? `<span class="person">${esc(cut(f.space, 200))}</span>` : ''),
    row('Kind', esc(KIND[f.kind] || '')),
    row('Threading', esc(THREADING[f.threading] || '')),
    row('Members', f.members ? esc(String(f.members)) : ''),
    row('Messages', `${shown} shown${f.unread ? ` (${f.unread} unread)` : ''}`),
    row('People', Array.isArray(f.people) && f.people.length ? f.people.slice(0, 12).map((p) => `<span class="person">${esc(cut(p, 80))}</span>`).join(' ') + (f.people.length > 12 ? ` <span class="muted">+${f.people.length - 12} more</span>` : '') : ''),
    '</dl>',
  ].join('')
  return html.length > ASIDE_MAX ? `<dl class="facts">${row('Messages', String(shown))}</dl>` : html
}

module.exports = { conversationDocument, messageCard, pictureParts, driveUrl, reactions, details, HTML_MAX_BYTES, KIND }
