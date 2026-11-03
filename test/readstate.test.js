'use strict'
// Mark read / Mark unread on their own (lib/readstate.js through lib/client.js): the read time moves
// forward only for read, one microsecond before the message for unread, never past where it is, one
// PATCH with updateMask=lastReadTime per space, and a failure stops the mark.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createClient } = require('../dist/lib/client')
const { applyMark } = require('../dist/lib/readstate')
const T = require('../dist/lib/time')
const { fakeGoogle, tokens, ago, S } = require('./fakes')

const TOKEN = 'ya29.mark-token'
function setup(opts = {}) {
  const reg = tokens()
  reg.valid.add(TOKEN)
  const g = fakeGoogle({ tokens: reg, ...opts })
  return { g, client: createClient({ getToken: async () => TOKEN, invalidate() {}, fetch: g.fetch }) }
}

test('read: the space read time moves to the message, with updateMask=lastReadTime', async () => {
  const { g, client } = setup()
  const r = await applyMark(client, { [S.dm]: ago(20) }, 'read')
  assert.deepEqual(r, { changed: [S.dm], unchanged: [] })
  assert.deepEqual(g.writes, [{ space: S.dm, lastReadTime: T.normalise(ago(20)), updateMask: 'lastReadTime' }])
  const patch = g.calls.find((c) => c.method === 'PATCH')
  assert.equal(patch.path, '/v1/users/me/spaces/DMANN/spaceReadState')
  assert.deepEqual(Object.keys(patch.body), ['lastReadTime'])
})

test('read never moves the read time back: a space read past the message is left alone', async () => {
  const { g, client } = setup()
  g.world.read[S.dm] = ago(5)
  const r = await applyMark(client, { [S.dm]: ago(20) }, 'read')
  assert.deepEqual(r, { changed: [], unchanged: [S.dm] })
  assert.deepEqual(g.writes, [])
})

test('unread: one microsecond before the message, so exactly that message and newer read as unread', async () => {
  const { g, client } = setup()
  g.world.read[S.random] = ago(60)
  const at = ago(300)
  await applyMark(client, { [S.random]: at }, 'unread')
  assert.equal(g.writes[0].lastReadTime, T.justBefore(at))
  assert.equal(T.after(at, g.writes[0].lastReadTime), true)
  // Already unread from there: no write.
  const again = await applyMark(client, { [S.random]: at }, 'unread')
  assert.deepEqual(again.unchanged, [S.random])
  assert.equal(g.writes.length, 1)
})

test('a space never read: read sets it, unread needs nothing', async () => {
  const { g, client } = setup()
  delete g.world.read[S.dm]
  assert.deepEqual((await applyMark(client, { [S.dm]: ago(20) }, 'unread')).unchanged, [S.dm])
  assert.deepEqual((await applyMark(client, { [S.dm]: ago(20) }, 'read')).changed, [S.dm])
})

test('an alert row over two spaces: both moved, one at a time; a failure stops and rejects', async () => {
  const { g, client } = setup()
  await applyMark(client, { [S.alerts]: ago(8), [S.team]: ago(10) }, 'read')
  assert.deepEqual(g.writes.map((w) => w.space), [S.alerts, S.team])
  const bad = setup({ fail: { [`patch:${S.team}`]: 403 } })
  await assert.rejects(applyMark(bad.client, { [S.alerts]: ago(8), [S.team]: ago(10) }, 'read'), (e) => e.kind === 'scope' && /chat\.users\.readstate/.test(e.message))
  assert.deepEqual(bad.g.writes.map((w) => w.space), [S.alerts])
})

test('junk targets are skipped; only read and unread exist', async () => {
  const { g, client } = setup()
  const r = await applyMark(client, { 'spaces/../x': ago(1), [S.dm]: 'not a time' }, 'read')
  assert.deepEqual(r, { changed: [], unchanged: [] })
  assert.equal(g.calls.length, 0)
  await assert.rejects(applyMark(client, {}, 'delete'), /read or unread/)
})

test('the write needs a Chat app: Google\'s "Chat app not found" is said with the setup step', async () => {
  const { client } = setup({ fail: { [`patch:${S.dm}`]: { status: 404, body: { error: { code: 404, message: 'Google Chat app not found. To create a Chat app, you must turn on the Chat API and configure the app in the Google Cloud console.' } } } } })
  await assert.rejects(applyMark(client, { [S.dm]: ago(20) }, 'read'), (e) => e.kind === 'noChatApp' && /setup step 3/.test(e.message))
})
