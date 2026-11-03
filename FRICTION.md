# Friction log

Each entry is one place where the cc-cockpit guide (`ccc guide`, every topic, `ccc guide types`, and
`ccc help`) was not enough, was ambiguous, or an API was missing, found while building
`bronos.chat` 0.1.0 against cc-cockpit 0.9.3 on 2026-11-03. Format: what I needed, what the guide
says, what I did instead. Status: **Open** unless marked.

Known gaps already reported in bronos.gmail's, bronos.jira's and bronos.jev-triage's FRICTION.md,
only referenced here: no project id for per-project secrets (a random `projectKey` in
`ctx.storage`, as Gmail); `invalid_grant` only in the rejection's text; panels cannot submit a
`<form>`; no host test kit (this repo has its own fake ctx in `test/fakes.js`); a consumer cannot
tell "the provider has no such method" from "the method failed" except by the rejection's text
(`isMissingAnnotate`); no `ccc plugin validate <dir>` for an unlinked folder.

## Sign-in

- **`types`: `ctx.oauth.authorize` returns no granted scope, no id token.** Open.
  Needed: Google lets the person untick a permission on its consent page, and Chat needs to know
  which ones were granted (without the read-state one nothing can be told unread) and who signed in
  (the address for the title bar, the user id to tell the person's own messages and @mentions
  apart). Guide: `OAuthTokens` is `{ accessToken, refreshToken, expiresAt }`; the token endpoint's
  `scope` and `id_token` are dropped. Did: one extra call after each sign-in and on the first poll
  of a run, `POST https://oauth2.googleapis.com/tokeninfo` with the token in the Authorization
  header (`dist/lib/client.js` `tokenInfo`), which answers `scope`, `email` and `sub`; the result
  is kept with the sign-in marker. Would help: `OAuthTokens.scope` (the granted scope string, as the
  token endpoint sent it) and `idToken` when present.

- **`types`: a granted scope of a refresh is unknown too.** Open.
  Needed: a person who re-consents with fewer boxes keeps the same refresh flow. Did: the token info
  is asked again when a call answers 403 insufficient scopes. Would help: `scope` on `refresh`'s
  answer as well.

## Plugin API

- **`api`: no way to say "this plugin writes"**, and nothing in the manifest scopes HTTP. Noted.
  Needed: the person should be able to see that this plugin changes only the read state. Guide: a
  host may `fetch` anywhere. Did: one place builds every request (`dist/lib/http.js`: fixed origins,
  a path table per method, one PATCH shape) and `test/manifest.test.js` checks the sources; the
  README says it. Would help: an optional `network: { hosts: [...] }` in the manifest that the app
  shows on install (and could enforce).

- **`reviewer`: annotate has no "mark as read" hook or result.** Noted.
  Needed: mark read on open only when the person actually saw the conversation. Guide: annotate
  resolves when the overlay opened. Did: mark once annotate resolved (the view is up), as Chat
  does on open; the plugin's own reader page marks once its first message is posted.

- **`panels`: no per-row busy state in the SDK.** Noted (not an app gap; noted for the guide).
  Needed: Mark read shows at once and waits for Chat. Did: the host keeps an optimistic mark per row
  (`pending`), the panel fades the row and disables the button, a failure puts it back with a
  notice. A `panels` guide note on optimistic updates (post the guess, then the truth) would save the
  next plugin the design work.

## Google, not cc-cockpit (for the README and the design)

- The read-state write (`users.spaces.updateSpaceReadState`) works only from a Cloud project with a
  Chat app configured (Google answers 404 "Chat app not found" otherwise), although the plugin is not
  a bot: setup step 3 configures a minimal, non-interactive one.
- A personal Google account cannot use the Chat API at all: detected by the address (`@gmail.com`,
  `@googlemail.com`) and by a 403 that names Workspace, and said in the panel.
