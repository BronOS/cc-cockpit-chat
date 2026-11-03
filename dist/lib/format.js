'use strict'
// A Chat message's text as HTML for the reviewer's allow-list (design "The conversation view"):
// our own builder, never Chat's markup passed on. Ported from the old connector's `chat_html`:
// the text is tokenized for the few constructs Chat's `formattedText` has, and everything between
// them is escaped. Out come only `<strong>`, `<em>`, `<s>`, `<code>`, `<pre>`, `<a href>` (http(s)
// only, normalised and checked by sanitize.safeHref) and `<br>`; a mention `<users/ID>` is
// **@Name**. A bot's card text holds Chat's HTML subset instead, and goes through the mail sanitizer
// (sanitize.sanitizeHtml, copied from bronos.gmail) like any hostile HTML.
//
// Linear in the input: the token regex has no nested quantifiers (each alternative is a run of one
// character class up to a fixed delimiter), and the style marks are applied to escaped plain
// stretches only, each a single non-nested pass.

const { esc } = require('./entities')
const { safeHref, sanitizeHtml, linkify } = require('./sanitize')
const { cut } = require('./util')
const { normaliseMentions } = require('./names')

const MAX_TEXT = 100000
// ```code block```, `code`, <url|label> or <url>, <users/ID>, a bare link.
const TOKEN = /```([\s\S]{0,50000}?)```|`([^`\n]{1,2000})`|<(https?:\/\/[^|>\s]{1,2048})(?:\|([^>]{0,500}))?>|<(users\/[A-Za-z0-9_-]{1,64})>|(https?:\/\/[^\s<>"']{1,2048}[^\s<>"'.,;:!?)\]])/g
// Chat's emphasis: *bold*, _italic_, ~strike~, not inside a word (the old connector's marks, plus strike).
const MARKS = [
  [/(^|[^\w*])\*(?=\S)([^*\n]{1,2000}?)(?<=\S)\*(?![\w*])/g, 'strong'],
  [/(^|[^\w_])_(?=\S)([^_\n]{1,2000}?)(?<=\S)_(?![\w_])/g, 'em'],
  [/(^|[^\w~])~(?=\S)([^~\n]{1,2000}?)(?<=\S)~(?![\w~])/g, 's'],
]

/** A plain stretch: escaped, emphasis as Chat shows it, line breaks kept. */
function styled(text) {
  let out = esc(text)
  for (const [rx, tag] of MARKS) out = out.replace(rx, (_, pre, inner) => `${pre}<${tag}>${inner}</${tag}>`)
  return out.replace(/\n/g, '<br>')
}

/**
 * `formattedText` (or `text`) as HTML.
 * @param {string} text
 * @param {(userId: string) => string} nameOf a mentioned user's name ('' when not known)
 */
function chatHtml(text, nameOf) {
  const s = cut(normaliseMentions(text).replace(/\r\n?/g, '\n'), MAX_TEXT)
  let out = ''
  let at = 0
  for (const m of s.matchAll(TOKEN)) {
    out += styled(s.slice(at, m.index))
    at = m.index + m[0].length
    const [whole, pre, code, url, label, user, bare] = m
    if (pre !== undefined) {
      out += `<pre><code>${esc(pre.replace(/^\n+|\n+$/g, ''))}</code></pre>`
    } else if (code !== undefined) {
      out += code.trim() ? `<code>${esc(code)}</code>` : esc(whole)
    } else if (url !== undefined) {
      const href = safeHref(url)
      const shown = label && label.trim() ? label : url
      out += href ? `<a href="${esc(href)}">${esc(shown)}</a>` : esc(whole)
    } else if (user !== undefined) {
      const name = user === 'users/all' ? 'all' : nameOf(user) || 'someone'
      out += `<strong>@${esc(name)}</strong>`
    } else if (bare !== undefined) {
      const href = safeHref(bare)
      out += href ? `<a href="${esc(href)}">${esc(bare)}</a>` : esc(bare)
    }
  }
  out += styled(s.slice(at))
  // A code block is a block of its own: the line breaks around it would show as blank lines.
  return out.replace(/(?:<br>)?(<pre><code>[\s\S]*?<\/code><\/pre>)(?:<br>)?/g, '$1')
}

/** A card's text (Chat's HTML subset) through the HTML sanitizer, inline. */
function cardText(html) {
  return sanitizeHtml(String(html || ''), { headingShift: 3 }).html
}

/**
 * The cards of a bot message as quotes: title, `label: text` rows, buttons as links (http(s) only).
 * @param {object[]} cards model.cardList(m)
 */
function cardsHtml(cards) {
  const out = []
  for (const card of cards) {
    const parts = []
    const head = card.header || {}
    const title = [head.title, head.subtitle].filter((x) => typeof x === 'string' && x).join(' · ')
    if (title) parts.push(`<strong>${esc(cut(title, 300))}</strong>`)
    const buttons = []
    for (const sec of Array.isArray(card.sections) ? card.sections : []) {
      if (sec && typeof sec.header === 'string' && sec.header) parts.push(`<em>${cardText(sec.header)}</em>`)
      for (const w of Array.isArray(sec && sec.widgets) ? sec.widgets : []) {
        if (!w || typeof w !== 'object') continue
        if (w.textParagraph && typeof w.textParagraph.text === 'string') parts.push(cardText(w.textParagraph.text))
        for (const k of ['decoratedText', 'keyValue']) {
          const d = w[k]
          if (!d || typeof d !== 'object') continue
          const label = typeof d.topLabel === 'string' ? d.topLabel : ''
          const text = typeof d.text === 'string' ? d.text : typeof d.content === 'string' ? d.content : ''
          if (text) parts.push(`${label ? `<em>${esc(cut(label, 200))}:</em> ` : ''}${cardText(text)}`)
        }
        const list = [...(w.buttonList && Array.isArray(w.buttonList.buttons) ? w.buttonList.buttons : []), ...(Array.isArray(w.buttons) ? w.buttons : [])]
        for (const b0 of list) {
          const b = b0 && b0.textButton ? b0.textButton : b0
          const url = b && b.onClick && b.onClick.openLink && b.onClick.openLink.url
          const href = typeof url === 'string' ? safeHref(url) : null
          if (b && typeof b.text === 'string' && b.text && href && !href.startsWith('mailto:')) buttons.push(`<a href="${esc(href)}">${esc(cut(b.text, 100))}</a>`)
        }
      }
    }
    if (buttons.length) parts.push(buttons.slice(0, 20).join(' · '))
    if (parts.length) out.push(`<blockquote>${parts.join('<br>')}</blockquote>`)
  }
  return out.join('')
}

module.exports = { chatHtml, cardsHtml, cardText, styled, linkify, TOKEN }
