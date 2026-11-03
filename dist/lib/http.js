'use strict'
// Token-to-host safety: the one place the Google access token leaves the plugin (the sign-in and the
// token refresh are ctx.oauth's, in the app; never from here).
//
// The rule (design "Auth": tokens go only to https://chat.googleapis.com, https://people.googleapis.com
// and the OAuth endpoints): every request is built here from one of three fixed origins and a path
// checked for that origin, so no address from a response (a link in a message, a `nextPageToken`, an
// attachment's resource name) can point the token elsewhere. Redirects are not followed at all
// (`redirect: 'manual'`): these APIs answer directly, so a 3xx means something is off (a proxy, a
// captive portal) and is an error, never a hop with the token. The token never goes into a URL.
//
// Methods: GET for reads; POST for `messages:search` (Chat's search takes a body) and the token info;
// PATCH for exactly one path shape, a space's read state (the plugin's only write, design "Read
// state"). Anything else is refused before a request is made.
// (From bronos.gmail's http.js, made to serve three Google hosts.)

const TIMEOUT_MS = 20000

const CHAT = 'https://chat.googleapis.com'
const PEOPLE = 'https://people.googleapis.com'
const OAUTH = 'https://oauth2.googleapis.com'

// Per origin: which paths, and which method on them. A path is plain (no `..`, `//`, `?`, `#`, `%`,
// white space or backslash) and starts with the origin's prefix.
const ROUTES = [
  { origin: CHAT, method: 'GET', path: /^\/v1\/(spaces(\/[A-Za-z0-9_-]{1,128}(\/messages)?)?|users\/me\/spaces\/[A-Za-z0-9_-]{1,128}(\/threads\/[A-Za-z0-9_.-]{1,128}\/threadReadState|\/spaceReadState)|media\/[A-Za-z0-9._~=+/-]{1,2048})$/ },
  { origin: CHAT, method: 'POST', path: /^\/v1\/spaces\/-\/messages:search$/ },
  { origin: CHAT, method: 'PATCH', path: /^\/v1\/users\/me\/spaces\/[A-Za-z0-9_-]{1,128}\/spaceReadState$/ },
  { origin: PEOPLE, method: 'GET', path: /^\/v1\/people:batchGet$/ },
  { origin: OAUTH, method: 'POST', path: /^\/tokeninfo$/ },
]

/** Why a request failed, as a kind the host and the panel can act on. */
class ChatError extends Error {
  /**
   * @param {string} message what the person reads
   * @param {{ kind: string, status?: number, retryAfter?: number, reason?: string, api?: string }} info
   *   kind: auth (401), forbidden (403), scope (403 insufficient scopes), disabled (the API is not
   *   enabled; `api` says which), workspace (a personal account), noChatApp (404 "Chat app not
   *   found" on a write), notfound (404), rate (429, or 403 rateLimitExceeded), server (5xx), http
   *   (another status), network, timeout, unsafe (a request that would leave the rule), json, toolarge
   */
  constructor(message, info) {
    super(message)
    this.name = 'ChatError'
    this.kind = info.kind
    if (info.status !== undefined) this.status = info.status
    if (info.retryAfter !== undefined) this.retryAfter = info.retryAfter
    if (info.reason) this.reason = info.reason
    if (info.api) this.api = info.api
  }
}

/** Whether an error is worth backing off for (design: 429 and 5xx double the poll interval). */
function isBusy(err) {
  return Boolean(err) && (err.kind === 'rate' || err.kind === 'server')
}

const HOST_NAME = { [CHAT]: 'Google Chat', [PEOPLE]: 'the People API', [OAUTH]: 'Google' }

/**
 * A request with the bearer token to one of the allowed routes.
 *
 * @param {string} origin CHAT, PEOPLE or OAUTH
 * @param {string} path
 * @param {object} o
 * @param {string} o.token the access token
 * @param {'GET'|'POST'|'PATCH'} [o.method]
 * @param {URLSearchParams|Record<string,string>|Array<[string,string]>} [o.params]
 * @param {object} [o.json] a JSON body (POST, PATCH)
 * @param {string} [o.form] a form body (the token info)
 * @param {boolean} [o.binary] resolve the body as a Buffer (media) instead of JSON
 * @param {typeof fetch} o.fetch injected (tests pass a fake; nothing here reaches the network itself)
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.timeoutMs]
 * @param {number} [o.maxBytes] the body's cap (default 8 MiB)
 */
async function googleRequest(origin, path, o) {
  const method = o.method || 'GET'
  if (typeof path !== 'string' || path.includes('..') || path.includes('//') || /[?#%\s\\]/.test(path) || !ROUTES.some((r) => r.origin === origin && r.method === method && r.path.test(path))) {
    throw new ChatError('not an allowed Google API request: the token is not sent', { kind: 'unsafe' })
  }
  const qs = o.params ? new URLSearchParams(o.params).toString() : ''
  const url = origin + path + (qs ? `?${qs}` : '')
  // The URL parser must agree that this is still the origin (a checked path cannot change it, but the
  // check costs nothing and keeps the rule in one visible place).
  if (new URL(url).origin !== origin) throw new ChatError('not an allowed Google API address: the token is not sent', { kind: 'unsafe' })
  const who = HOST_NAME[origin]
  const ms = o.timeoutMs || TIMEOUT_MS
  const timeout = AbortSignal.timeout(ms)
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
  const headers = { Authorization: `Bearer ${o.token}`, Accept: o.binary ? '*/*' : 'application/json' }
  let body
  if (o.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(o.json)
  } else if (o.form !== undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
    body = o.form
  }
  let res
  try {
    res = await o.fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal })
  } catch (e) {
    if (timeout.aborted) throw new ChatError(`${who} did not answer within ${Math.round(ms / 1000)} s`, { kind: 'timeout' })
    if (o.signal && o.signal.aborted) throw new ChatError('cancelled', { kind: 'network' })
    throw new ChatError(`cannot reach ${new URL(origin).host}: ${e && e.message ? e.message : e}`, { kind: 'network' })
  }
  let buf
  try {
    buf = await readLimited(res, o.maxBytes || 8 * 1024 * 1024)
  } catch (e) {
    if (e instanceof ChatError) throw e
    if (timeout.aborted) throw new ChatError(`${who} did not answer within ${Math.round(ms / 1000)} s`, { kind: 'timeout' })
    throw new ChatError(`reading the answer of ${who} failed: ${e && e.message ? e.message : e}`, { kind: 'network' })
  }
  if (res.status >= 200 && res.status < 300) {
    if (o.binary) return buf
    const text = buf.toString('utf8')
    if (!text.trim()) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new ChatError(`${who} answered with something that is not JSON`, { kind: 'json', status: res.status })
    }
  }
  throw statusError(res, buf.toString('utf8'), origin, method)
}

/**
 * A ChatError for a status that is not 2xx, as one readable line (design "Auth": never the raw body),
 * with Google's own reason when it gave one.
 */
function statusError(res, text, origin, method) {
  const status = res.status
  const who = HOST_NAME[origin]
  if (status >= 300 && status < 400) return new ChatError(`${who} answered with a redirect (${status}): not followed, the token stays here. A proxy in the way?`, { kind: 'http', status })
  const g = googleError(text)
  const all = `${g.reason} ${g.message}`
  const detail = g.message ? ` (${g.message})` : ''
  if (status === 401) return new ChatError(`Google refused the access token (401)${detail}`, { kind: 'auth', status })
  if (status === 429 || (status === 403 && /rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT_EXCEEDED/.test(g.reason))) {
    const ra = Number(res.headers.get('retry-after'))
    return new ChatError(`${who} is rate limiting the plugin; it polls less often until it answers again`, { kind: 'rate', status, ...(Number.isFinite(ra) ? { retryAfter: ra } : {}) })
  }
  if ((status === 403 || status === 400) && /accessNotConfigured|SERVICE_DISABLED|has not been used in project|is disabled/i.test(all)) {
    if (origin === PEOPLE || /people\.googleapis\.com|People API/i.test(all)) {
      return new ChatError('The People API is not enabled in your Google Cloud project: enable it (APIs & Services > Library > People API) so colleagues show by name', { kind: 'disabled', status, api: 'people', reason: g.reason })
    }
    return new ChatError('The Google Chat API is not enabled in your Google Cloud project: enable it (APIs & Services > Library > Google Chat API), then refresh', { kind: 'disabled', status, api: 'chat', reason: g.reason })
  }
  if (status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(all)) {
    return new ChatError(`Google did not grant the plugin this permission${origin === PEOPLE ? ' (colleagues\' names: directory.readonly)' : method === 'PATCH' ? ' (marking read: chat.users.readstate)' : ''}: sign in again and leave every box ticked on the consent page`, { kind: 'scope', status, reason: g.reason })
  }
  // Google states no rule for consumer accounts (design); its 403 for one names Workspace.
  if (origin === CHAT && (status === 403 || status === 400) && /workspace|consumer|not available for (this|your) account/i.test(g.message)) {
    return new ChatError(WORKSPACE_TEXT, { kind: 'workspace', status, reason: g.reason })
  }
  if (origin === CHAT && status === 404 && /chat app not found/i.test(g.message)) {
    return new ChatError(NO_CHAT_APP_TEXT, { kind: 'noChatApp', status })
  }
  if (status === 403) return new ChatError(`${who} refused the request (403)${detail}`, { kind: 'forbidden', status, reason: g.reason })
  if (status === 404) return new ChatError(`not found in ${who} (404)${detail}`, { kind: 'notfound', status })
  if (status >= 500) return new ChatError(`${who} had a problem (${status}); it polls less often until it answers again`, { kind: 'server', status })
  return new ChatError(`${who} answered ${status}${detail}`, { kind: 'http', status })
}

const WORKSPACE_TEXT = "Google Chat's API works only with Google Workspace (work or school) accounts, not with a personal Google account. Sign out, then sign in with your Workspace account."
const NO_CHAT_APP_TEXT = 'Google Chat takes the read-state change only from a Cloud project with a Chat app configured ("Chat app not found"). Once: Google Cloud console > APIs & Services > Google Chat API > Configuration: an app name, an avatar URL, a description, interactive features off, Save (setup step 3).'

/** Google's error body (`{ error: { code, message, errors: [{ reason }], status, details } }`) as short plain text. */
function googleError(text) {
  try {
    const body = JSON.parse(text)
    const e = body && body.error
    if (!e || typeof e !== 'object') {
      // The token info answers `{ error: 'invalid_token', error_description }` on a dead token.
      if (body && typeof body.error_description === 'string') return { message: body.error_description.slice(0, 200), reason: '' }
      return { message: '', reason: '' }
    }
    const reasons = [...(Array.isArray(e.errors) ? e.errors.map((x) => x && x.reason) : []), e.status, ...(Array.isArray(e.details) ? e.details.map((x) => x && x.reason) : [])].filter((x) => typeof x === 'string')
    return { message: typeof e.message === 'string' ? e.message.replace(/\s+/g, ' ').slice(0, 200) : '', reason: reasons.join(' ') }
  } catch {
    // Not JSON (an HTML error page from a proxy): no detail rather than markup in a notice.
    return { message: '', reason: '' }
  }
}

/**
 * A response body as a Buffer, refused past `max` bytes (a declared Content-Length over it is
 * refused before reading; a body that keeps coming is cut off at the limit and cancelled).
 */
async function readLimited(res, max) {
  const tooLarge = () => new ChatError(`the answer is over ${max} bytes`, { kind: 'toolarge', status: res.status })
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    if (res.body) await res.body.cancel().catch(() => {})
    throw tooLarge()
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > max) throw tooLarge()
    return buf
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  }
  return Buffer.concat(chunks, total)
}

module.exports = { CHAT, PEOPLE, OAUTH, ROUTES, ChatError, googleRequest, readLimited, isBusy, googleError, WORKSPACE_TEXT, NO_CHAT_APP_TEXT }
