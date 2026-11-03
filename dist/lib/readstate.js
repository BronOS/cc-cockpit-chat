'use strict'
// Mark read / Mark unread (design "Read state": the plugin's only writes). Chat keeps one read time
// per space and cannot have a thread's set, so a mark moves the space's read time, as the old
// connector's `mark` did:
//
// - read: per space, the read time is read fresh; when it is not already at or past the target it is
//   set to the target (forward only, never back: nothing newer turns unread).
// - unread: per space, the read time is set 1 µs before the target (Chat compares exactly, so the
//   message at the target reads as unread), only when it is not before that already (never forward).
//
// The calls run one space at a time (an alert row may name a few spaces); a failure stops the mark
// and rejects with what was done so far, so the host can say it and the next poll shows the truth.

const T = require('./time')
const { spaceName } = require('./util')

/**
 * @param {object} client lib/client.js (spaceReadState, setSpaceReadState)
 * @param {Record<string, string>} targets space -> the time of the message the mark is about
 * @param {'read'|'unread'} want
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ changed: string[], unchanged: string[] }>} spaces whose read time moved, and
 *   those already where the mark wanted them
 */
async function applyMark(client, targets, want, signal) {
  if (want !== 'read' && want !== 'unread') throw new Error('a mark is read or unread')
  const changed = []
  const unchanged = []
  for (const [space, at] of Object.entries(targets || {})) {
    if (!spaceName(space) || T.parse(at) === null) continue
    const current = await client.spaceReadState(space, signal)
    if (want === 'read') {
      if (!T.after(at, current)) {
        unchanged.push(space) // read that far already
        continue
      }
      await client.setSpaceReadState(space, at, signal)
    } else {
      const to = T.justBefore(at)
      // No read time yet: Chat counts the whole space unread, so there is nothing to move.
      if (!current || T.compare(current, to) <= 0) {
        unchanged.push(space) // unread from there already
        continue
      }
      await client.setSpaceReadState(space, to, signal)
    }
    changed.push(space)
  }
  return { changed, unchanged }
}

/** Why a row cannot be marked (no target): said by the panel's title and `ccc chat read`. */
const NO_TARGET_TEXT = "Chat's API cannot change this thread's read state: its new replies are judged by the thread's own read time, which only Google Chat sets, when the thread is read there."

module.exports = { applyMark, NO_TARGET_TEXT }
