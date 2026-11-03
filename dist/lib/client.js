'use strict'
// The Google client: the Chat REST v1 calls the plugin makes, the People API names lookup and the
// token info (design "Fetching", "Read state", "Auth"). One write only: `setSpaceReadState`, a
// space's read time for the signed-in user (users.spaces.updateSpaceReadState). No method here
// sends, edits, deletes or reacts to a message, and none could: http.js refuses any other write.
//
// The access token comes from `getToken` (auth.js) on every request. A 401 means it died early
// (revoked, the clock): the client drops it (`invalidate`), takes a fresh one and retries once.

const { CHAT, PEOPLE, OAUTH, ChatError, googleRequest } = require('./http')
const { spaceName, threadName, userName } = require('./util')
const T = require('./time')

const SPACES_PAGE = 1000
const SPACES_PAGES = 5
const MAX_JSON = 8 * 1024 * 1024
const MAX_MEDIA_BYTES = 700 * 1024

/**
 * @param {object} o
 * @param {() => Promise<string>} o.getToken
 * @param {() => void} o.invalidate
 * @param {typeof fetch} o.fetch
 */
function createClient(o) {
  async function call(origin, path, extra = {}) {
    let token = await o.getToken()
    try {
      return await googleRequest(origin, path, { token, fetch: o.fetch, ...extra })
    } catch (e) {
      if (!(e instanceof ChatError) || e.kind !== 'auth') throw e
      o.invalidate()
      token = await o.getToken()
      return googleRequest(origin, path, { token, fetch: o.fetch, ...extra })
    }
  }

  /**
   * The caller's spaces, DMs and group chats (all pages, at most 5 of 1000): the raw Space objects
   * with a name that checks out. Every page adds a space or the loop ends.
   */
  async function spaces(signal) {
    const out = []
    const seen = new Set()
    let pageToken = null
    for (let page = 0; page < SPACES_PAGES; page++) {
      const params = { pageSize: String(SPACES_PAGE) }
      if (pageToken) params.pageToken = pageToken
      const body = (await call(CHAT, '/v1/spaces', { params, signal, maxBytes: MAX_JSON })) || {}
      const got = Array.isArray(body.spaces) ? body.spaces : []
      for (const s of got) {
        if (!s || !spaceName(s.name) || seen.has(s.name)) continue
        seen.add(s.name)
        out.push(s)
      }
      pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : null
      if (!pageToken || !got.length) break
    }
    return out
  }

  /** The space's read time for the caller (RFC 3339), null when never read. */
  async function spaceReadState(space, signal) {
    const s = spaceName(space)
    if (!s) throw new ChatError('not a space name', { kind: 'unsafe' })
    const body = (await call(CHAT, `/v1/users/me/${s}/spaceReadState`, { signal })) || {}
    return typeof body.lastReadTime === 'string' && T.parse(body.lastReadTime) !== null ? body.lastReadTime : null
  }

  /**
   * The plugin's one write: the caller's read time of a space (design "Read state"). `updateMask`
   * names the one field; Google coerces a time past the newest message to it.
   */
  async function setSpaceReadState(space, time, signal) {
    const s = spaceName(space)
    if (!s) throw new ChatError('not a space name', { kind: 'unsafe' })
    const t = T.normalise(time)
    if (!t) throw new ChatError('not a time', { kind: 'unsafe' })
    const body = (await call(CHAT, `/v1/users/me/${s}/spaceReadState`, { method: 'PATCH', params: { updateMask: 'lastReadTime' }, json: { lastReadTime: t }, signal })) || {}
    return typeof body.lastReadTime === 'string' ? body.lastReadTime : t
  }

  /** A thread's own read time, null when the person does not follow it (Google answers 1970). */
  async function threadReadState(thread, signal) {
    const t = threadName(thread)
    if (!t) throw new ChatError('not a thread name', { kind: 'unsafe' })
    const body = (await call(CHAT, `/v1/users/me/${t}/threadReadState`, { signal })) || {}
    const at = typeof body.lastReadTime === 'string' ? body.lastReadTime : null
    return at && !T.isEpoch(at) ? at : null
  }

  /**
   * Messages of a space, newest first: `{ messages, more }` (`more`: Chat has older ones). `thread`
   * limits them to one thread (`filter=thread.name = …`).
   */
  async function messages(space, { pageSize = 12, thread = null } = {}, signal) {
    const s = spaceName(space)
    if (!s) throw new ChatError('not a space name', { kind: 'unsafe' })
    const params = { pageSize: String(Math.max(1, Math.min(1000, pageSize))), orderBy: 'createTime desc' }
    if (thread) {
      const t = threadName(thread)
      if (!t || !t.startsWith(`${s}/`)) throw new ChatError('not a thread of that space', { kind: 'unsafe' })
      params.filter = `thread.name = ${t}`
    }
    const body = (await call(CHAT, `/v1/${s}/messages`, { params, signal, maxBytes: MAX_JSON })) || {}
    const list = Array.isArray(body.messages) ? body.messages.filter((m) => m && typeof m.name === 'string' && m.name.startsWith(`${s}/messages/`)) : []
    return { messages: list, more: typeof body.nextPageToken === 'string' && Boolean(body.nextPageToken) }
  }

  /**
   * Messages that @mention the caller since `sinceMs` (one page of at most 100, newest first), with
   * Chat's `read` per result (view FULL, the readstate scope): `[{ message, read }]`. The search
   * leaves out bots' messages and muted spaces (design "Mentions search").
   */
  async function searchMentions(sinceMs, signal) {
    // Unread mentions only, the window cut here: Chat's search refuses every `createTime` filter,
    // the documented `createTime >= "..."` included, alone or as an interval ("Invalid filter
    // query", probed against a real account 2026-11-03), while `is_unread()` works. Results come
    // newest first, so the cut drops only the tail.
    const filter = 'annotations.user_mentions.user.name:"users/me" AND is_unread()'
    const body = (await call(CHAT, '/v1/spaces/-/messages:search', { method: 'POST', json: { filter, pageSize: 100, view: 'SEARCH_MESSAGES_VIEW_FULL' }, signal, maxBytes: MAX_JSON })) || {}
    const out = []
    for (const r of Array.isArray(body.results) ? body.results : []) {
      const m = r && r.message
      if (!m || typeof m.name !== 'string' || !/^spaces\/[A-Za-z0-9_-]{1,128}\/messages\//.test(m.name)) continue
      if (typeof m.createTime === 'string' && T.parse(m.createTime) !== null && T.ms(m.createTime) < sinceMs) continue
      out.push({ message: m, read: r.read === true ? true : r.read === false ? false : null })
    }
    return out
  }

  /** The caller's own user id from one message of theirs (`sender.name = "users/me"`), or null. */
  async function ownUserId(signal) {
    const body = (await call(CHAT, '/v1/spaces/-/messages:search', { method: 'POST', json: { filter: 'sender.name = "users/me"', pageSize: 1 }, signal })) || {}
    const r = Array.isArray(body.results) ? body.results[0] : null
    const name = r && r.message && r.message.sender && r.message.sender.name
    return userName(name) && name !== 'users/all' ? name : null
  }

  /** An uploaded attachment's bytes (media.download, `alt=media`), at most `maxBytes`. */
  async function media(resourceName, opts = {}) {
    const r = String(resourceName || '')
    if (!/^[A-Za-z0-9._~=+/-]{1,2048}$/.test(r) || r.includes('..') || r.includes('//') || r.startsWith('/')) throw new ChatError('not an attachment resource', { kind: 'unsafe' })
    return call(CHAT, `/v1/media/${r}`, { params: { alt: 'media' }, binary: true, maxBytes: opts.maxBytes || MAX_MEDIA_BYTES, signal: opts.signal, timeoutMs: opts.timeoutMs })
  }

  /**
   * People's names from the People API (`people:batchGet`, up to 200 a call): user id -> display
   * name, for the ids it named. A Chat user id is the People API person id.
   */
  async function people(userIds, signal) {
    const ids = [...new Set(userIds.filter((u) => userName(u) && u !== 'users/all'))].slice(0, 200)
    if (!ids.length) return {}
    const params = [...ids.map((u) => ['resourceNames', `people/${u.slice(6)}`]), ['personFields', 'names']]
    const body = (await call(PEOPLE, '/v1/people:batchGet', { params, signal })) || {}
    const out = {}
    for (const r of Array.isArray(body.responses) ? body.responses : []) {
      const p = r && r.person
      const rn = (p && p.resourceName) || (r && r.requestedResourceName) || ''
      const m = /^people\/([A-Za-z0-9_-]{1,64})$/.exec(rn)
      if (!m || !p) continue
      const names = Array.isArray(p.names) ? p.names : []
      const primary = names.find((n) => n && n.metadata && n.metadata.primary) || names[0]
      if (primary && typeof primary.displayName === 'string' && primary.displayName.trim()) out[`users/${m[1]}`] = primary.displayName.trim()
    }
    return out
  }

  /**
   * What Google says about the access token (`POST oauth2.googleapis.com/tokeninfo`, the token in the
   * Authorization header as Google's own client library sends it): `{ scope, email, sub }`.
   */
  async function tokenInfo(signal) {
    const body = (await call(OAUTH, '/tokeninfo', { method: 'POST', form: '', signal })) || {}
    return {
      scope: typeof body.scope === 'string' ? body.scope : '',
      email: typeof body.email === 'string' ? body.email.toLowerCase() : '',
      sub: typeof body.sub === 'string' && /^[0-9]{1,40}$/.test(body.sub) ? body.sub : '',
    }
  }

  return { call, spaces, spaceReadState, setSpaceReadState, threadReadState, messages, searchMentions, ownUserId, media, people, tokenInfo }
}

module.exports = { createClient, MAX_MEDIA_BYTES }
