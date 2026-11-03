'use strict'
// The Google sign-in of one project (design "Auth (per project, as Gmail)"): which OAuth client is in
// use, the refresh token in ctx.secrets, the access token in memory only. From bronos.gmail 0.2.0
// (its 0.1.0 keychain migration left out: this plugin never kept a client in the keychain), plus what
// the sign-in was granted (below).
//
// - The client: a pasted client file wins over the settings fields until it is removed. It is kept
//   whole (id and secret) in this project's ctx.storage, so it survives an uninstall and a
//   reinstall: cc-cockpit deletes a plugin's ctx.secrets on uninstall (on purpose: no credential
//   outlives the plugin) but keeps its ctx.storage. A Desktop app client's secret is not a secret in
//   Google's own terms (an installed app cannot keep one; Google's docs say so, and the downloaded
//   file sits in plain text in the person's Downloads), unlike the refresh token, which stays in
//   ctx.secrets.
// - ctx.secrets is app-wide while accounts are per project (a personal and a work project use
//   different Google accounts), so the refresh token's key carries a project key and the client:
//   `refresh:<projectKey>:<sha256(clientId) 12>`. The project key is a random id kept in this
//   project's ctx.storage: per project (each project has its own storage), kept over an uninstall
//   with the rest of the storage, and naming nothing about the project. Nothing in ctx is steadier:
//   ctx.storage and ctx.dataDir both follow the app's project id (a hash of the folder's real path),
//   and ctx.projectDir is the path itself. A key is 41 characters, under the 128 the app allows.
// - The refresh token cannot survive an uninstall (the app deletes it with the other secrets). A
//   storage marker (`signedIn`: the client's hash) remembers that this project was signed in, so
//   after a reinstall the panel says why the sign-in is gone instead of showing a first setup.
// - The access token is refreshed through ctx.oauth.refresh a minute before `expiresAt`, one
//   refresh at a time (the app allows 4 in flight; a burst of space reads must not spend them).
// - `invalid_grant` from Google = signed out: the refresh token is deleted and the reason kept for
//   the panel. The usual cause is a client still in "Testing" (Google lets its refresh tokens expire
//   after 7 days), so the message says that and how to fix it.
// - Changing the client (another id in the settings, a pasted file of another client, removing the
//   pasted one) signs out: the old client's refresh token is deleted.
// - What was granted: Google's consent page lets the person untick a scope, and ctx.oauth returns no
//   granted scope, so the host asks Google's token info (client.tokenInfo) and hands the answer to
//   `setGrant`: the missing scopes (oauth-client.missingScopes) and the account (address, user id).
//   Kept in the `signedIn` storage marker next to the client's hash, so a restart knows them without
//   asking; null = not known yet (asked again on the next poll).
//
// Nothing here logs or returns a token or a secret: errors carry Google's error code at most (the
// app's own `ctx.oauth` messages do the same, `the token endpoint refused the request: HTTP 400
// (invalid_grant)`).

const crypto = require('node:crypto')
const { oauthSpec, parseClientFile, shortClientId, SCOPES } = require('./oauth-client')
const { sha } = require('./util')

const EARLY_MS = 60000 // refresh this long before the access token expires (clock skew, a slow call)

const GONE_TEXT =
  'The stored Google sign-in of this project is gone: cc-cockpit deletes a plugin\'s keychain entries when it is uninstalled. ' +
  'Your OAuth client is kept: press Sign in with Google again.'

const INVALID_GRANT_TEXT =
  'Google no longer accepts the stored sign-in (invalid_grant). Sign in again. ' +
  'If this happens about every 7 days, your OAuth client is in "Testing": Google expires its sign-ins after 7 days. ' +
  'In the Google Cloud console > Google Auth Platform > Audience, set the user type to Internal (a Workspace account), or press Publish app (In production).'

/** Why there is no access token: `kind` is signedOut (no sign-in), invalidGrant, noClient, keyring, oauth, superseded (a newer sign-in replaced it). */
class AuthError extends Error {
  constructor(message, kind) {
    super(message)
    this.name = 'AuthError'
    this.kind = kind
  }
}

/** Whether a ctx.oauth rejection is Google's invalid_grant (the refresh token is dead). */
function isInvalidGrant(err) {
  const m = err && err.message ? err.message : String(err || '')
  return /\binvalid_grant\b/.test(m) || Boolean(err && err.code === 'invalid_grant')
}

/** The ctx.secrets key of a client's refresh token in a project. */
function refreshKey(projectKey, clientId) {
  return `refresh:${projectKey}:${sha(clientId, 12)}`
}

/**
 * @param {object} o
 * @param {object} o.oauth ctx.oauth
 * @param {object} o.secrets ctx.secrets
 * @param {object} o.storage ctx.storage
 * @param {{ info: Function, warn: Function }} o.log ctx.log
 * @param {() => number} [o.now]
 */
function createAuth(o) {
  const now = o.now || Date.now
  const A = {
    projectKey: null,
    pasted: null, // { clientId, clientSecret } of a pasted client file
    pastedBroken: null, // why the pasted client cannot be used (its secret is gone)
    fromSettings: null, // { clientId, clientSecret } from the settings fields, when both are set
    settingsMissing: [], // 'clientId' / 'clientSecret' when only one of the two is set
    hasRefresh: false, // a refresh token is stored for the current client
    access: null, // { token, expiresAt } in memory only
    refreshing: null, // the running refresh: one at a time
    signedOutReason: null, // shown in the panel after invalid_grant
    signingIn: false,
    signInGen: 0,
    grant: null, // { missing, email, sub } from Google's token info; null until known
  }

  /** The client in use: the pasted one, else the settings one, else null. */
  function client() {
    if (A.pasted) return { ...A.pasted, source: 'pasted' }
    if (A.fromSettings) return { ...A.fromSettings, source: 'settings' }
    return null
  }

  async function ensureProjectKey() {
    if (A.projectKey) return A.projectKey
    let k = await o.storage.get('projectKey').catch(() => undefined)
    if (typeof k !== 'string' || !/^[a-f0-9]{12}$/.test(k)) {
      k = crypto.randomBytes(6).toString('hex')
      await o.storage.set('projectKey', k)
    }
    A.projectKey = k
    return k
  }

  /** Reads the project key, the pasted client and whether a refresh token is stored. */
  async function load(settingsCfg) {
    await ensureProjectKey()
    const stored = await o.storage.get('client').catch(() => undefined)
    if (stored && typeof stored.clientId === 'string' && typeof stored.clientSecret === 'string' && stored.clientSecret) {
      A.pasted = { clientId: stored.clientId, clientSecret: stored.clientSecret }
    } else if (stored !== undefined) {
      A.pastedBroken = 'the pasted client record is damaged: paste the client file again'
    }
    applySettings(settingsCfg)
    await checkRefresh()
    // Signed in before, and the refresh token is gone: the plugin was uninstalled (or the keychain was
    // reset). Say so instead of looking like a first setup.
    const c = client()
    const mark = c ? await o.storage.get('signedIn').catch(() => undefined) : undefined
    const ours = Boolean(mark && c && mark.client === sha(c.clientId, 12))
    if (c && !A.hasRefresh && !A.signedOutReason && ours) A.signedOutReason = GONE_TEXT
    if (A.hasRefresh && ours && mark.grant && typeof mark.grant === 'object') A.grant = cleanGrant(mark.grant)
  }

  /** A grant record as kept: `{ missing: string[] | null, email, sub }`, nothing else. */
  function cleanGrant(g) {
    const keys = new Set(Object.keys(SCOPES))
    return {
      missing: Array.isArray(g.missing) ? g.missing.filter((k) => keys.has(k)) : null,
      email: typeof g.email === 'string' ? g.email.slice(0, 254) : '',
      sub: typeof g.sub === 'string' && /^[0-9]{1,40}$/.test(g.sub) ? g.sub : '',
    }
  }

  /**
   * What Google's token info said about the current sign-in (the host asks it). Kept in memory and in
   * the `signedIn` marker when the sign-in is stored.
   */
  async function setGrant(g) {
    A.grant = cleanGrant(g || {})
    const c = client()
    if (!c || !A.hasRefresh) return
    await o.storage.set('signedIn', { client: sha(c.clientId, 12), grant: A.grant }).catch((e) => o.log.warn(`keeping what the sign-in was granted failed: ${e.message}`))
  }

  function applySettings(cfg) {
    const id = cfg && cfg.clientId ? cfg.clientId : ''
    const secret = cfg && cfg.clientSecret ? cfg.clientSecret : ''
    A.fromSettings = id && secret ? { clientId: id, clientSecret: secret } : null
    A.settingsMissing = []
    if (id && !secret) A.settingsMissing.push('clientSecret')
    if (!id && secret) A.settingsMissing.push('clientId')
  }

  async function checkRefresh() {
    const c = client()
    if (!c) {
      A.hasRefresh = false
      return
    }
    try {
      A.hasRefresh = Boolean(await o.secrets.get(refreshKey(A.projectKey, c.clientId)))
    } catch (e) {
      o.log.warn(`reading the stored sign-in failed: ${e.message}`)
      A.hasRefresh = false
    }
  }

  /** Forget the current client's sign-in: its refresh token and the access token. */
  async function dropSignIn(clientId) {
    A.access = null
    A.hasRefresh = false
    A.grant = null
    await o.storage.delete('signedIn').catch(() => {})
    if (clientId && A.projectKey) await o.secrets.delete(refreshKey(A.projectKey, clientId)).catch((e) => o.log.warn(`deleting the stored sign-in failed: ${e.message}`))
  }

  /**
   * After a settings save. Returns true when the client in use changed (then the old one's sign-in
   * is gone and the host forgets the account's data).
   */
  async function settingsChanged(cfg) {
    const before = client()
    applySettings(cfg)
    const after = client()
    if ((before && before.clientId) === (after && after.clientId)) {
      // Same id, maybe a new secret: the refresh token still belongs to this client id.
      return false
    }
    if (before) await dropSignIn(before.clientId)
    A.signedOutReason = null
    await checkRefresh()
    return true
  }

  /**
   * A pasted client file (the panel's box or `ccc chat client`). Returns `{ ok, changed, error?,
   * clientId? }`. Kept whole in ctx.storage (see the top of this file); when the store refuses,
   * nothing changes.
   */
  async function pasteClient(text) {
    const p = parseClientFile(text)
    if (!p.ok) return { ok: false, error: p.error }
    await ensureProjectKey()
    try {
      await o.storage.set('client', { clientId: p.clientId, clientSecret: p.clientSecret })
    } catch (e) {
      return { ok: false, error: `The client could not be stored: ${e.message}` }
    }
    const before = client()
    A.pasted = { clientId: p.clientId, clientSecret: p.clientSecret }
    A.pastedBroken = null
    const changed = !before || before.clientId !== p.clientId
    if (changed) {
      if (before) await dropSignIn(before.clientId)
      A.signedOutReason = null
      await checkRefresh()
    }
    return { ok: true, changed, clientId: p.clientId }
  }

  /** Remove the pasted client; the settings fields (if set) are used again. */
  async function removeClient() {
    if (!A.pasted && !A.pastedBroken) return { ok: false, error: 'No pasted client to remove.' }
    await ensureProjectKey()
    const before = client()
    await o.storage.delete('client').catch(() => {})
    A.pasted = null
    A.pastedBroken = null
    const after = client()
    const changed = (before && before.clientId) !== (after && after.clientId)
    if (changed) {
      if (before) await dropSignIn(before.clientId)
      A.signedOutReason = null
      await checkRefresh()
    }
    return { ok: true, changed }
  }

  /**
   * The browser sign-in. Resolves `{ sessionOnly }` (true when the keychain refused the refresh
   * token: signed in until the access token expires). Rejects with an AuthError.
   */
  async function signIn() {
    const c = client()
    if (!c) throw new AuthError('No OAuth client yet: paste the client file or set clientId and clientSecret first.', 'noClient')
    // A second call while one is open starts over: cc-cockpit 0.9.2+ cancels the pending authorize
    // (Google's "Access blocked" page never redirects back, so the first one would wait 5 minutes).
    // Only the newest call owns `signingIn`; an older one that ends (cancelled) is 'superseded', and
    // the caller drops it quietly. An older app refuses the second authorize: that error is shown.
    const gen = ++A.signInGen
    A.signingIn = true
    let tokens
    try {
      tokens = await o.oauth.authorize(oauthSpec(c))
    } catch (e) {
      if (gen !== A.signInGen) throw new AuthError('A newer sign-in replaced this one.', 'superseded')
      throw new AuthError(`Google sign-in did not finish: ${e && e.message ? e.message : e}`, 'oauth')
    } finally {
      if (gen === A.signInGen) A.signingIn = false
    }
    if (gen !== A.signInGen) throw new AuthError('A newer sign-in replaced this one.', 'superseded')
    // The client may have changed while the browser was open (a paste, a settings save): these
    // tokens belong to `c`, so they are kept only when it is still the client in use.
    const still = client()
    if (!still || still.clientId !== c.clientId) throw new AuthError('The OAuth client changed during the sign-in: sign in again.', 'oauth')
    A.access = { token: tokens.accessToken, expiresAt: tokens.expiresAt }
    A.signedOutReason = null
    A.grant = null // another sign-in may be another account with other boxes ticked: asked anew
    let sessionOnly = false
    if (tokens.refreshToken) {
      try {
        await ensureProjectKey()
        await o.secrets.set(refreshKey(A.projectKey, c.clientId), tokens.refreshToken)
        A.hasRefresh = true
        await o.storage.set('signedIn', { client: sha(c.clientId, 12) }).catch(() => {})
      } catch (e) {
        // The keyring is locked or missing: no file fallback (by design); signed in for now.
        o.log.warn(`storing the sign-in failed, signed in until the access token expires: ${e.message}`)
        sessionOnly = e.message
      }
    } else {
      // access_type=offline&prompt=consent should always bring one; without it the sign-in lasts an hour.
      o.log.warn('Google sent no refresh token: signed in until the access token expires')
      sessionOnly = 'Google sent no refresh token'
    }
    return { sessionOnly }
  }

  async function signOut() {
    const c = client()
    await dropSignIn(c && c.clientId)
    A.signedOutReason = null
  }

  /**
   * A live access token: the one in memory, else a refresh with the stored refresh token. Rejects
   * with an AuthError: signedOut (never signed in), invalidGrant (Google refused it: now signed
   * out), or oauth (a refresh that failed for another reason: network, Google down; still signed in).
   */
  async function token() {
    if (A.access && A.access.expiresAt - now() > EARLY_MS) return A.access.token
    if (A.refreshing) return A.refreshing
    A.refreshing = (async () => {
      const c = client()
      if (!c) throw new AuthError('No OAuth client yet.', 'noClient')
      let rt = null
      try {
        rt = await o.secrets.get(refreshKey(await ensureProjectKey(), c.clientId))
      } catch (e) {
        throw new AuthError(`The stored sign-in cannot be read: ${e.message}`, 'keyring')
      }
      if (!rt) {
        A.hasRefresh = false
        A.access = null
        throw new AuthError(A.signedOutReason || 'Not signed in to Google.', 'signedOut')
      }
      let t
      try {
        t = await o.oauth.refresh(oauthSpec(c), rt)
      } catch (e) {
        if (isInvalidGrant(e)) {
          await dropSignIn(c.clientId)
          A.signedOutReason = INVALID_GRANT_TEXT
          o.log.warn('Google refused the refresh token (invalid_grant): signed out')
          throw new AuthError(INVALID_GRANT_TEXT, 'invalidGrant')
        }
        throw new AuthError(`Refreshing the Google sign-in failed: ${e && e.message ? e.message : e}`, 'oauth')
      }
      // Google does not rotate refresh tokens today; if it sends one, it replaces the stored one.
      if (t.refreshToken && t.refreshToken !== rt) await o.secrets.set(refreshKey(A.projectKey, c.clientId), t.refreshToken).catch((e) => o.log.warn(`storing the new refresh token failed: ${e.message}`))
      A.access = { token: t.accessToken, expiresAt: t.expiresAt }
      A.hasRefresh = true
      return t.accessToken
    })()
    try {
      return await A.refreshing
    } finally {
      A.refreshing = null
    }
  }

  /** After a 401 from Google: the access token is no good, the next `token()` refreshes. */
  function invalidate() {
    A.access = null
  }

  /** What the panel and `ccc chat status` show about the sign-in (no token, no secret). */
  function status() {
    const c = client()
    return {
      client: c ? { source: c.source, id: shortClientId(c.clientId), fullId: c.clientId } : null,
      pasted: Boolean(A.pasted),
      pastedBroken: A.pastedBroken,
      settingsMissing: [...A.settingsMissing],
      signedIn: Boolean(c) && (A.hasRefresh || Boolean(A.access && A.access.expiresAt > now())),
      sessionOnly: Boolean(c) && !A.hasRefresh && Boolean(A.access && A.access.expiresAt > now()),
      signingIn: A.signingIn,
      signedOutReason: A.signedOutReason,
      grant: A.grant ? { missing: A.grant.missing ? [...A.grant.missing] : null, email: A.grant.email, sub: A.grant.sub } : null,
    }
  }

  return { A, load, client, settingsChanged, pasteClient, removeClient, signIn, signOut, token, invalidate, status, ensureProjectKey, setGrant }
}

module.exports = { createAuth, AuthError, isInvalidGrant, refreshKey, INVALID_GRANT_TEXT, GONE_TEXT, EARLY_MS }
