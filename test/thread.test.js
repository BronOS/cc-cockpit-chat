'use strict'
// The opened conversation: Chat's text as HTML for the reviewer's allow-list (format.js), the whole
// document with its details column (document.js), the readable text and the Discuss prompt
// (readable.js). Hostile message text must come out as text, never markup.
const test = require('node:test')
const assert = require('node:assert/strict')
const { chatHtml, cardsHtml } = require('../dist/lib/format')
const { conversationDocument, pictureParts, driveUrl, HTML_MAX_BYTES } = require('../dist/lib/document')
const { readableText, discussPrompt, PROMPT_MAX } = require('../dist/lib/readable')
const { selectImages, sniff, partKey } = require('../dist/lib/images')
const { msg, ago, picture, U, S } = require('./fakes')

const TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img', 'strong', 'em', 's', 'u', 'sub', 'sup', 'span', 'div', 'details', 'summary', 'figure', 'figcaption', 'dl', 'dt', 'dd'])
const ATTRS = new Set(['class', 'href', 'title', 'alt', 'data-asset', 'colspan', 'rowspan'])

/** Every tag in the allow-list, every attribute allowed, every href http(s) or mailto (own regexes). */
function assertClean(html) {
  for (const [, close, name, attrs] of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
    assert.ok(TAGS.has(name.toLowerCase()), `tag ${name} in ${html.slice(0, 200)}`)
    if (close) continue
    for (const [, a, v] of attrs.matchAll(/\s([a-zA-Z-]+)="([^"]*)"/g)) {
      assert.ok(ATTRS.has(a), `attribute ${a}`)
      if (a === 'href') assert.match(v, /^(https?:\/\/|mailto:)/)
    }
    assert.ok(!/\son[a-z]+=/i.test(attrs), 'an event handler')
  }
  assert.ok(!/<script/i.test(html))
}

const nameOf = (u) => ({ [U.ann]: 'Ann Example', [U.me]: 'you' })[u] || ''

test('chatHtml: Chat\'s marks, code, links and mentions; everything else escaped', () => {
  const h = chatHtml('*bold* _it_ ~gone~ `x<y` <https://example.com/a?b=1|the docs> <users/2001> <users/all> <users/7> https://status.example.com/run/42.\n```\nif (a < b) {}\n```', nameOf)
  assert.match(h, /<strong>bold<\/strong> <em>it<\/em> <s>gone<\/s> <code>x&lt;y<\/code>/)
  assert.match(h, /<a href="https:\/\/example\.com\/a\?b=1">the docs<\/a>/)
  assert.match(h, /<strong>@Ann Example<\/strong> <strong>@all<\/strong> <strong>@someone<\/strong>/)
  assert.match(h, /<a href="https:\/\/status\.example\.com\/run\/42">https:\/\/status\.example\.com\/run\/42<\/a>\./)
  assert.match(h, /<pre><code>if \(a &lt; b\) \{\}<\/code><\/pre>/)
  assertClean(h)
})

test('chatHtml: hostile text stays text', () => {
  for (const evil of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<javascript:alert(1)|click>', '<a href="javascript:x">y</a>', '*<b onmouseover=x>*', '"><svg/onload=x>', '<https://example.com" onclick="x|y>']) {
    const h = chatHtml(evil, nameOf)
    assertClean(h)
    assert.ok(!/<(script|img|svg|b )/i.test(h), h)
  }
})

test('chatHtml: linear on long input (no catastrophic backtracking)', () => {
  const t0 = Date.now()
  chatHtml('*'.repeat(50000) + '_'.repeat(50000), nameOf)
  chatHtml('<https://' + 'a'.repeat(60000), nameOf)
  chatHtml('`'.repeat(100000), nameOf)
  assert.ok(Date.now() - t0 < 2000)
})

test('cardsHtml: a bot\'s card as a quote, its HTML through the sanitizer, button links http(s) only', () => {
  const h = cardsHtml([{ header: { title: 'HighCPU', subtitle: 'prod' }, sections: [{ widgets: [{ textParagraph: { text: '<b>node-1</b><script>x</script><img src=x onerror=y>' } }, { decoratedText: { topLabel: 'Value', text: '97%' } }, { buttonList: { buttons: [{ text: 'Dashboard', onClick: { openLink: { url: 'https://grafana.example.com/d/1' } } }, { text: 'Evil', onClick: { openLink: { url: 'javascript:alert(1)' } } }] } }] }] }])
  assertClean(h)
  assert.match(h, /^<blockquote><strong>HighCPU · prod<\/strong>/)
  assert.match(h, /<a href="https:\/\/grafana\.example\.com\/d\/1">Dashboard<\/a>/)
  assert.ok(!h.includes('Evil'))
  assert.ok(!h.includes('script'))
})

test('the document: cards oldest first, unread marked, pictures by asset, files listed, the details column, no Chat link', () => {
  const raws = [
    msg(S.dm, 'D2', { from: U.ann, at: ago(20), text: 'Can you look at the *deploy*?', attachment: { name: `${S.dm}/messages/D2/attachments/A1`, contentName: 'deploy.png', contentType: 'image/png', source: 'UPLOADED_CONTENT', attachmentDataRef: { resourceName: 'RES-A1' } } }),
    msg(S.dm, 'D1', { from: U.me, at: ago(90), text: 'Morning!' }),
    { ...msg(S.dm, 'D3', { from: U.ann, at: ago(10), text: 'and the plan' }), attachment: [{ name: `${S.dm}/messages/D3/attachments/A2`, contentName: 'plan.doc', source: 'DRIVE_FILE', driveDataRef: { driveFileId: 'abcdefghij0123' } }], emojiReactionSummaries: [{ emoji: { unicode: '👍' }, reactionCount: 2 }] },
  ]
  const pics = raws.flatMap(pictureParts)
  assert.deepEqual(pics.map((p) => p.resourceName), ['RES-A1'])
  const assets = new Map([[partKey({ messageId: `${S.dm}/messages/D2`, partId: `${S.dm}/messages/D2/attachments/A1` }), 'img1']])
  const senderOf = (r) => (r.sender.name === U.me ? 'you' : 'Ann Example')
  const d = conversationDocument({ title: 'Ann Example', messages: raws, senderOf, nameOf, isUnread: (r) => r.name.endsWith('D2') || r.name.endsWith('D3'), assets, note: 'Older messages are not shown.', facts: { space: 'Ann Example', kind: 'dm', threading: 'THREADED_MESSAGES', unread: 2, people: ['Ann Example'] }, aside: true })
  assertClean(d.html)
  assertClean(d.aside)
  const order = ['Morning!', 'deploy', 'and the plan'].map((t) => d.html.indexOf(t))
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'oldest first')
  assert.equal((d.html.match(/class="card new"/g) || []).length, 2)
  assert.match(d.html, /<img data-asset="img1" alt="deploy.png"/)
  assert.match(d.html, /<a href="https:\/\/drive\.google\.com\/open\?id=abcdefghij0123">plan\.doc<\/a> \(Google Drive\)/)
  assert.match(d.html, /👍 2/)
  assert.match(d.aside, /<dt>Kind<\/dt><dd>Direct message<\/dd>/)
  assert.match(d.aside, /2 unread/)
  assert.ok(!/chat\.google\.com|mail\.google\.com/.test(d.html + d.aside), 'no link to Chat (answer 2)')
  assert.equal(driveUrl({ driveDataRef: { driveFileId: '../x' } }), null)
})

test('the document stays under the reviewer\'s 2 MiB: the oldest messages give way, with a line', () => {
  const raws = []
  for (let i = 0; i < 400; i++) raws.push(msg(S.team, `M${i}`, { from: U.ann, at: ago(1000 - i), text: 'y'.repeat(9000) }))
  const d = conversationDocument({ title: 't', messages: raws, senderOf: () => 'Ann Example', nameOf, isUnread: () => false })
  assert.ok(Buffer.byteLength(d.html) <= HTML_MAX_BYTES)
  assert.ok(d.omitted > 0)
  assert.match(d.html, /earlier messages are not shown here/)
})

test('readable text and the Discuss prompt: oldest first, unread marked, mentions named, the app\'s refused first characters avoided', () => {
  const raws = [msg(S.team, 'T1R1', { from: U.cat, at: ago(25), text: 'I can help', thread: 'T1', reply: true }), msg(S.team, 'T1.T1', { from: U.bob, at: ago(30), text: 'Release plan <users/1001>', thread: 'T1', mentions: [U.me] })]
  const text = readableText({ title: '/Release plan', where: 'Acme Team', messages: raws, note: '', senderOf: (r) => (r.sender.name === U.bob ? 'Bob Example' : 'Cat Example'), isUnread: (r) => r.name.endsWith('T1R1'), nameOf, me: U.me })
  assert.ok(text.indexOf('Release plan @you') < text.indexOf('I can help'))
  assert.match(text, /\[unread\] Cat Example/)
  const p = discussPrompt('/Release plan', 'Acme Team', text)
  assert.match(p, /^About the Google Chat conversation "\/Release plan" in Acme Team/)
  assert.ok(!/^[/!#&]/.test(p))
  assert.ok(discussPrompt('x', 'y', 'z'.repeat(50000)).length <= PROMPT_MAX)
})

test('images: only uploaded rasters, the newest first within the caps; sniffed by their bytes', () => {
  const pics = [1, 2, 3].map((i) => ({ messageId: `m${i}`, partId: `a${i}`, mime: 'image/png', size: null, at: i, name: `p${i}.png`, resourceName: `R${i}` }))
  const { wanted } = selectImages(pics)
  assert.equal(wanted.length, 3)
  assert.equal(sniff(picture('png')), 'image/png')
  assert.equal(sniff(Buffer.from('<svg></svg>')), null)
})

test('mentions in the real API form (<chat-user data-user="users/ID">) are named like <users/ID>', () => {
  const { chatHtml } = require('../dist/lib/format')
  const { mentionText } = require('../dist/lib/names')
  // formattedText of a real account, 2026-11-03 (ids made up).
  const t = '<chat-user data-user="users/111"></chat-user> <chat-user data-user="users/222"></chat-user>\nFYI: the job failed'
  const html = chatHtml(t, (u) => (u === 'users/111' ? 'Ann Example' : ''))
  assert.equal(html, '<strong>@Ann Example</strong> <strong>@someone</strong><br>FYI: the job failed')
  assert.doesNotMatch(html, /chat-user/)
  assert.equal(mentionText(t, () => 'Bob Example', 'users/222'), '@Bob Example @you\nFYI: the job failed')
  // Not a mention: a look-alike with a bad id stays text (escaped by chatHtml).
  assert.match(chatHtml('<chat-user data-user="users/x y"></chat-user>', () => ''), /&lt;chat-user/)
})
