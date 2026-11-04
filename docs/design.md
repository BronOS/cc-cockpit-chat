# Google Chat (bronos.chat)

Status: design drafted 2026-11-03 from the decisions agreed with the user that day (a separate
plugin with its own sign-in, accounts per project, the old connector's shape, triage by Jev
triage); the open questions were answered the same day (section "Answers", below) and 0.1.0 is
built from this text. External plugin (own repo `BronOS/cc-cockpit-chat`, for the marketplace).
The third source plugin for jev-triage, after Jira and Gmail; built the same way
(`~/Projects/cc-cockpit-gmail` is the model: its docs/design.md, its auth, setup guide, panel,
reviewer use, tests and fakes; ported from it nearly as is: `auth.js`, `oauth-client.js`,
`images.js`, `header.js`, `actions.js`, `store.js`, `util.js`, `entities.js`, `sanitize.js`).

Prior art (port its decisions, not its user-specific text): the old cockpit's Chat connector
`~/Projects/claude-config/cockpit/connectors/chat.py`, `lib/convs.py` and `lib/readstate.py`
(which spaces, what counts as unread, conversations, alert grouping, triage text, the page, the
read / unread marks). It read messages through the `gws` CLI and the read state with a sign-in of
its own; this plugin talks to the Chat REST API itself with one sign-in.

Manifest: `services: { uses: { triage: 1, reviewer: 1 } }` (both optional at run time, as in
Gmail); a panel (default zone right) with lanes; CLI `ccc chat`. Needs cc-cockpit 0.9.2+
(`ctx.oauth`, `ctx.secrets`, `ctx.panels.header`, `ctx.openExternal`, reviewer `aside` came in
0.9.1; 0.9.2 opens the links of a message in the browser and has Start over for a stuck sign-in).
The reviewer's `companion` (0.9.3) is not used: no Jira issue beside a conversation in v1. On an
app without the 0.9.1 members the panel says so instead of half working (0.9.1 itself cannot be
told from 0.9.2 by the API: the README says 0.9.2).

## Answers (2026-11-03)

1. **Names**: yes, the People API for the names Chat leaves out (`directory.readonly`, sensitive:
   the colleagues' names of the Workspace directory). Setup enables the People API.
2. **Open in Chat**: not needed. No ↗ button, no "open in Chat" link anywhere (rows, conversation
   view, details column, reader page, CLI); the links people post inside messages still open.
3. **Triage floor**: a direct @mention of the person (in a new message, or at the start of a
   thread whose replies are new) is floor `action`. DMs have no floor: Jev decides.
4. **Alerts lane**: kept, only when `alertBots` is set.
5. **@all**: the Spaces lane, not Mentions.
6. **Mark read**: yes, writes now. The read-state scope `chat.users.readstate` (it reads too, so
   it replaces `.readonly`), a Chat app configuration in the Cloud project (Google takes no write
   without one), hover buttons Mark read / Mark unread, and mark read on open (project setting
   `markReadOnOpen`, default false since 0.2.0). Optimistic, with a rollback and a notice when Chat refuses.
   Writes only ever touch the read state.

## What Google's docs say (researched 2026-11-03)

- **Reads need no "Chat app"; writes do.** [Configure the Chat API](https://developers.google.com/workspace/chat/configure-chat-api):
  for read-only calls with user authentication "you only need to enable the API and create an
  OAuth client"; "to perform create, update, and delete API calls" the Configuration page is needed
  too (<https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat>). The old
  connector saw the same: reads worked, its read-state writes failed with 404 "Chat app not found"
  until the page was saved. Minimal fields (the page itself: "displayName (3 to 25 characters) and
  description (1 to 40 characters) are required"; the console also asks for an avatar): **App
  name** (up to 25 characters), **Avatar URL** (any https PNG or JPEG, square), **Description** (up
  to 40 characters), **Enable interactive features** off, Save. With interactive features off
  there is no endpoint, no visibility list and nobody can add the app to a space: it exists only so
  Chat takes the writes. A 404 "Chat app not found" on a write names that page (setup step 3).
- **Workspace only.** Every Chat API guide lists "A Business or Enterprise Google Workspace account
  with access to Google Chat" as a prerequisite ([user auth](https://developers.google.com/workspace/chat/authenticate-authorize-chat-user),
  [configure](https://developers.google.com/workspace/chat/configure-chat-api), [search](https://developers.google.com/workspace/chat/search-messages)).
  Google states no rule for consumer accounts; third-party reports say a personal `@gmail.com`
  account gets 403s. So the plugin is for Workspace accounts; a personal account (`@gmail.com`,
  `@googlemail.com` from the sign-in, or a 403 that says Workspace) is refused with a plain message
  (the panel says so, never a raw 403), and nothing is polled.
- **Scopes and classification** ([Chat API scopes](https://developers.google.com/workspace/chat/authenticate-authorize)):
  `chat.spaces.readonly` (sensitive; spaces.list/get), `chat.messages.readonly` (**restricted**;
  messages.list/get, messages.search, media.download), `chat.users.readstate` (sensitive, "View and
  modify last read time for Chat conversations": get and update the space read state, get the
  thread read state, `read` in search results). `chat.memberships.readonly` is not asked for: the
  names come from the messages and the People API (below). Restricted means a client shared by
  everyone would need restricted-scope verification and a yearly security assessment, which is
  why, as for Gmail, the person brings their own client. With user type **Internal** (an app only
  for one Workspace organisation) there is no verification and no unverified-app screen ([OAuth
  production readiness](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview));
  an admin can still block the app or have to allow it.
- **Read state.** [`users.spaces.getSpaceReadState`](https://developers.google.com/workspace/chat/api/reference/rest/v1/users.spaces/getSpaceReadState)
  (`users/me/spaces/{space}/spaceReadState`, `lastReadTime`) and
  [`users.spaces.threads.getThreadReadState`](https://developers.google.com/workspace/chat/api/reference/rest/v1/users.spaces.threads/getThreadReadState)
  (`users/me/spaces/{space}/threads/{thread}/threadReadState`), calling user only. Chat keeps one
  read time per space and one per *followed* thread; for a thread the person does not follow Google
  answers a 1970 time (seen by the old connector). Chat compares exactly: a read time 1 µs before a
  message leaves it unread, so times are compared parsed, at full precision (nanoseconds as BigInt).
- **Writing the read state.** [`users.spaces.updateSpaceReadState`](https://developers.google.com/workspace/chat/api/reference/rest/v1/users.spaces/updateSpaceReadState):
  `PATCH v1/users/me/spaces/{space}/spaceReadState?updateMask=lastReadTime`, body `{ lastReadTime }`,
  scope `chat.users.readstate`. "When the lastReadTime is before the latest message create time, the
  space appears as unread in the UI. To mark the space as read, set lastReadTime to any value later
  (larger) than the latest message create time. The lastReadTime is coerced to match the latest
  message create time." And: "the space read state only affects the read state of messages that are
  visible in the space's top-level conversation. Replies in threads are unaffected by this
  timestamp, and instead rely on the thread read state." `users.spaces.threads` has only
  `getThreadReadState`: **a thread's read state cannot be written.** So mark unread is: the space's
  read time set 1 µs before a message (as the old connector did, and as the doc's first sentence
  says), and mark read: forward to a message's time.
- **Search** ([`spaces.messages.search`](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/search),
  `POST v1/spaces/-/messages:search`, body `{ filter, pageSize, view }`, user auth only,
  `chat.messages.readonly`, page size up to 100, newest first): filters `createTime`,
  `annotations.user_mentions.user.name:"users/me"`, `sender.name`, `is_unread()`; view
  `SEARCH_MESSAGES_VIEW_FULL` adds `read` per result (with a readstate scope). It leaves out
  messages posted by Chat apps in spaces and group chats (Grafana and other bots), messages in muted
  spaces, Chat app DMs and private messages, so it cannot replace the per-space reads; it is used
  for mentions (below) and once to find the person's own user id.
- **Messages** ([`spaces.messages.list`](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/list)):
  `pageSize` default 25, max 1000; `orderBy createTime desc`; `filter` `createTime > "<RFC 3339>"`
  and/or `thread.name = spaces/S/threads/T` (one thread per call). A [Message](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages)
  has `sender {name: users/{id}, type HUMAN|BOT, displayName?}`, `createTime`, `text`,
  `formattedText` (markup with `<users/{id}>` mentions, `<url|label>` links), `annotations[]`
  (`USER_MENTION` with `userMention.user` and `type MENTION|ADD`), `thread.name`, `threadReply`,
  `attachment[]`, `quotedMessageMetadata.quotedMessageSnapshot`, `cardsV2[]`,
  `emojiReactionSummaries[]`, `deleteTime`. With user auth `space` carries only its name.
- **Spaces** ([`spaces.list`](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces/list),
  [Space](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces)): the caller's
  spaces, DMs and group chats (a DM or group chat only once it has a message), `pageSize` up to
  1000. Fields: `spaceType` `SPACE | GROUP_CHAT | DIRECT_MESSAGE`, `singleUserBotDm`,
  `displayName` ("for direct messages, this field might be empty"), `spaceThreadingState`
  `THREADED_MESSAGES | GROUPED_MESSAGES | UNTHREADED_MESSAGES`, `lastActiveTime` (the last message
  in the space: the cheap change check), `membershipCount`.
- **Names of people.** [User](https://developers.google.com/workspace/chat/api/reference/rest/v1/User):
  `displayName` is populated with user auth "provided the user is a member of the space or has
  prior affinity with the calling user"; else the user is anonymous. A Chat user id is the People
  API person id ([identify users](https://developers.google.com/workspace/chat/identify-reference-users):
  "`users/123456789` in the Chat API represents the same person as `people/123456789` in the People
  API"). The old connector found human senders without a name and looked each up in the People
  API. [`people:batchGet`](https://developers.google.com/people/api/rest/v1/people/getBatchGet)
  (`GET people.googleapis.com/v1/people:batchGet?resourceNames=people/ID&...&personFields=names`, up
  to 200 a call) gives a colleague's name from the domain profile only with `directory.readonly`
  (People API docs: domain data needs "the directory.readonly scope has been granted" and the admin
  sharing the domain profiles, the default). One more API to enable (setup step 2).
- **Pictures**: [`media.download`](https://developers.google.com/workspace/chat/api/reference/rest/v1/media/download)
  `GET v1/media/{attachmentDataRef.resourceName}?alt=media` with `chat.messages.readonly` (uploaded
  files only; a Drive attachment is a `driveDataRef.driveFileId`, linked, never downloaded).
- **Quotas** ([limits](https://developers.google.com/workspace/chat/limits)): per project per minute,
  3000 space reads, 3000 message reads, 3000 attachment reads; per space 15 reads a second shared by
  every app in it; read-state methods are not listed. The project is the person's own, so the only
  other user of it is the Gmail plugin (another API). 429: back off.
- **The Gmail client.** The same Cloud project and Desktop client work for Chat: enable the Chat API
  and the People API in the project, save the Chat app configuration, add the Chat and directory
  scopes on Data access (an Internal app may request scopes it does not list, but listing them
  keeps the consent page honest), and sign in to Chat separately. Each plugin holds its own refresh
  token for the same client; Google keeps at most 100 refresh tokens per account per client and
  drops the oldest silently ([OAuth 2.0](https://developers.google.com/identity/protocols/oauth2#expiration)),
  far above two plugins times a few projects. Revoking the app at
  <https://myaccount.google.com/connections> ends both sign-ins (one app at Google).

## Auth (per project, as Gmail)

- Google OAuth 2.0 through `ctx.oauth` (code + PKCE, loopback on 127.0.0.1), auth URL
  `https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent`, token URL
  `https://oauth2.googleapis.com/token`. Scopes: `chat.spaces.readonly`, `chat.messages.readonly`,
  `chat.users.readstate`, `directory.readonly`, plus `openid` and `email` (non-sensitive): the
  address for the title bar, and the account id, which is the person's Chat user id (`users/<id>`),
  needed to tell their own messages and mentions apart (the old connector had it as a setting).
- **Who signed in and what was granted**: `ctx.oauth` returns no granted scope, so after a sign-in
  and on the first poll of a run the host asks Google's token info endpoint (`POST
  https://oauth2.googleapis.com/tokeninfo`, the token in the Authorization header, as Google's own
  client library does; never in a URL): `scope`, `email`, `sub`. `sub` is the user id; checked once
  per account against `messages:search` `sender.name = "users/me"` (page size 1: when it finds a
  message, its sender is the id, and that wins). Neither answer: own messages and @mentions are not
  told apart, the panel and `ccc chat status` say it (no setting to fill in).
- The person brings the OAuth client, always (decided with Gmail: no shared client; Chat's message
  scope is restricted). The same client file as Gmail: the Gmail setup guide's project and client,
  plus the Chat steps below. Settings (project scope): `clientId`, `clientSecret`
  (`"format": "secret"`); the **Paste the client file** box and `ccc chat client <file>` check the
  file as Gmail's `oauth-client.js` does and keep `client: { clientId, clientSecret }` in this
  project's `ctx.storage` (survives an uninstall; Gmail 0.2.0's decision and reasons). No reading
  of Gmail's storage: plugins do not share storage, and the paste is one step.
- Refresh token in `ctx.secrets` under `refresh:<projectKey>:<sha256(clientId) 12>` (`projectKey`
  random, in this project's `ctx.storage`), access token in memory, refreshed by `ctx.oauth.refresh`
  a minute before `expiresAt`, one at a time. `invalid_grant` = signed out, with the 7-day Testing
  hint; Sign out deletes the secret; another client signs out; the `signedIn` storage marker gives
  "the stored sign-in is gone (uninstalled)". All as Gmail's `auth.js`.
- A sign-in that lacks a scope (the person unticked a box on the consent page: Google lets them)
  is kept but the panel names what is missing and offers Sign in again: without
  `chat.messages.readonly` or `chat.spaces.readonly` nothing is polled; without
  `chat.users.readstate` nothing can be unread, so nothing is polled either (the lanes would be
  guesses); without `directory.readonly` the lanes work and some senders show as "unknown user".
- A personal account: refused right after the sign-in (an `@gmail.com` / `@googlemail.com`
  address), or on the first 403 that names Workspace: "Google Chat's API works only with Google
  Workspace (work or school) accounts". Nothing is polled; Sign out or Sign in again with another
  account.
- Errors Google sends, as one readable line, never the raw body: 403 "Google Chat API has not been
  used in project … or it is disabled" -> enable the Chat API; the same for the People API (names
  only: the lanes keep working); 404 "Chat app not found" on a write -> the Configuration page
  (setup step 3); "Access blocked" (Error 403 access_denied on Google's page) -> the same hint and
  Start over as Gmail.
- Tokens go only to `https://chat.googleapis.com`, `https://people.googleapis.com` and the OAuth
  endpoints (`accounts.google.com` and `oauth2.googleapis.com/token` through `ctx.oauth`;
  `oauth2.googleapis.com/tokeninfo` here); never logged, never in a panel message or the CLI
  output; a redirect is not followed with the token. Every request is built in one place from a
  fixed origin and a checked path (`lib/http.js`).

## Setup (panel guide while not signed in; the README has the same steps in more words)

1. A Google Cloud project **inside the Workspace organisation** (the Gmail one when it is there):
   <https://console.cloud.google.com/projectcreate>.
2. Enable the **Google Chat API**
   (<https://console.cloud.google.com/apis/library/chat.googleapis.com>) and the **People API**
   (<https://console.cloud.google.com/apis/library/people.googleapis.com>, for colleagues' names).
3. The Chat app configuration (Google takes read-state writes only from a project with one):
   <https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat>: App name
   (`cc-cockpit`), Avatar URL (any https PNG, e.g.
   `https://developers.google.com/chat/images/quickstart-app-avatar.png`), Description (`Mark
   read from cc-cockpit`), **Enable interactive features** off, Save. Nobody can add it to a space.
4. Consent screen (<https://console.cloud.google.com/auth/branding>), Audience
   (<https://console.cloud.google.com/auth/audience>): user type **Internal**. A personal account
   cannot use the Chat API at all (say so in the step). An External app also works for a Workspace
   account while its admin allows it, but then it must be In production (7-day expiry in Testing)
   and shows the unverified screen.
5. Data access (<https://console.cloud.google.com/auth/scopes>): tick `chat.spaces.readonly`,
   `chat.messages.readonly`, `chat.users.readstate` (Google Chat API) and `directory.readonly`
   (People API); Update, Save. (`openid` and `email` need no entry.)
6. A Desktop app client (<https://console.cloud.google.com/auth/clients/create>), Download JSON; or
   reuse the Gmail one (same file).
7. Paste the file (Save client) or `ccc chat client <file>`.
8. Sign in with Google (`ccc chat login`); the consent page lists the Chat and directory
   permissions: leave all ticked. "Access blocked" hint and Start over as Gmail.

Links are ids posted by the page, opened by the host with `ctx.openExternal` from a fixed table
(Gmail's `setup.js`).

## Fetching (Chat API v1)

The old connector's model, with the API's own calls (settings in brackets, project scope):

- **Spaces**: `spaces.list pageSize=1000` (all pages, at most 5), kept when `lastActiveTime` is
  within `<days 14>` days; `singleUserBotDm` spaces are kept (a bot DM is a DM).
- **Conversations**: a thread in a `SPACE` with `THREADED_MESSAGES`; else the whole DM, group chat,
  `GROUPED_MESSAGES` or unthreaded space (DMs and group chats report threading too, but people talk
  in them flat: old connector). Ids: `spaces/S` or `spaces/S/threads/T` (checked by pattern), or
  `alert:<name>`.
- **Which spaces are read this poll**: one whose `lastActiveTime` changed, one that had unread rows
  last time (it may have been read in Chat since: a read moves no `lastActiveTime`), one marked from
  here since the last poll, one with an unread mention hit, one with a row judged by a thread read
  time that changed. For those: `getSpaceReadState`; unread when `lastActiveTime` is after
  `lastReadTime`; then `messages.list orderBy=createTime desc pageSize=<messagesPerSpace 12>` (the
  newest, one call). A space read and quiet since the last poll keeps last poll's rows; a read
  space quiet for longer than `recentDays` keeps none.
- **What is new** (the old connector's rule, as Chat's sidebar counts): in a DM, group chat or
  unthreaded space, every message of others after the space's read time. In a threaded space: a
  thread's start against the space's read time; a reply only when it @mentions the person (or
  @all), against the thread's read time (the space's when the thread is not followed: 1970); in a
  thread whose start @mentions the person (or @all), every reply, against both read times. Other
  replies are not new (Chat shows them only as counts inside the space). Thread read times are
  asked only for threads with such a mention (concurrency 4).
- **Context**: up to 3 earlier messages; a reply whose thread started out of view gets the start by
  `messages.list filter=thread.name = …, pageSize 10`.
- **Mentions search** (one call a poll): `messages:search` with
  `annotations.user_mentions.user.name:"users/me" AND is_unread()` (the window cut by the plugin: Chat refuses every
  `createTime` filter, the documented one included, probed against a real account 2026-11-03), view FULL, 100,
  so a mention outside a space's newest 12 still shows; each unread hit (`read: false`) makes its
  space read this poll, and its message joins that space's messages (a thread out of view is read
  with `filter=thread.name`, pageSize 10). It skips muted spaces and bot messages, which the
  per-space reads cover. A failed search is logged and the poll goes on without it.
- **Read rows** (Recent): conversations whose newest message of others is within `<recentDays 2>`
  days, at most `<recentPerSpace 3>` per space and `<maxRecent 10>` in all, alerts left out.
- **Names**: `sender.displayName` when present; else the mention annotations' `displayName`; else
  the cache; else one `people:batchGet` (`personFields=names`, up to 200 ids) for all the unknown
  ids of the poll. Bots show `<name> (bot)`; a person nobody could name is "unknown user" (a
  failed lookup is asked again after a day). The person's own messages: "you". Cache per project
  (`names.json` in the data dir, 2000 entries, least recently used go first).
- **Polling** every `<pollMinutes 2>` while the window is open. A quiet poll costs `spaces.list`
  (1 call), a read-state call per space that was unread, the mentions search (1): a handful a
  poll, far under 3000 a minute. Per-space reads at concurrency 4 (the 15 a second per space is
  shared with every app in the space). 429/5xx: interval doubled up to 30 min with a notice, as
  Gmail. State per project in the data dir (`state.json`: per space its active and read times and
  rows, bounded to the spaces kept).

## Read state: Mark read, Mark unread (the only writes)

Chat keeps one read time per space and cannot have a thread's set, so what a mark moves is the
space's read time, as the old connector did (its `mark_target`):

- **Target** of a row: `{ <space>: <time of the conversation's newest message of others> }`; an
  alert row has one per space it came from (the newest message of that alert there); a thread
  whose newest message of others is a reply and whose start did not @mention the person has none
  (those replies are judged by the thread's read time, which only Chat can set): no button, and
  `ccc chat read` says why.
- **Mark read**: per space, the read time is read fresh (`getSpaceReadState`); when it is not
  already at or past the target, it is set to the target (forward only, never back: nothing newer
  turns unread). Everything older in the space's top-level conversation reads as read too (one
  read time per space; the README says so).
- **Mark unread**: per space, the read time set 1 µs before the target (Chat compares exactly), only
  when it is not already before it (never forward). Everything after it in the space's top-level
  conversation reads as unread too.
- **Optimistic**: the row changes at once (unread rows move to Recent, a Recent row to its unread
  lane), the call runs; on success the next poll (started at once) checks those spaces again and
  replaces the guess with Chat's state; on failure the row is put back and a notice says why
  (`Could not mark … read in Chat: <reason>. It is shown as before.`). A mark the poll has not
  confirmed yet survives a poll that started before it finished.
- **Mark read on open** (`markReadOnOpen`, default false since 0.2.0: the user does not want a look to mark it read): opening an unread row (panel click,
  Enter) marks it read the same way once the view is up. `ccc chat show` never marks.
- No other write exists: no message is sent, edited, deleted or reacted to (`lib/client.js` has
  one write method, and a source test checks it).

## Alerts (as the old connector; only with `alertBots`)

`alertBots` (bot display names, default empty = no Alerts lane). An unread conversation made only
of messages from such a bot whose first line is Grafana's (`[RESOLVED:] <name> — <node> (labels)`)
folds into one row per alert name across spaces: count badge, the nodes still firing (a node whose
newest message is RESOLVED is gone; all gone = no row), the space when it is one. Opening shows the
alert messages of the last poll. Other bot messages are plain conversations.

## Lanes

| Lane | What |
|---|---|
| Mentions | unread conversations in group chats and spaces whose new messages @mention the person by name, or a thread whose start did |
| Direct messages | unread DMs and group chats (Chat's sidebar puts both there) not in Mentions |
| Spaces | the other unread conversations of spaces (threads and flat spaces), @all included |
| Alerts | grouped alerts (only with `alertBots`) |
| Recent | read conversations of the last `recentDays` |

A conversation shows once (Alerts, Mentions, Direct messages, Spaces, Recent). Settings `lanes`
(booleans: a hidden lane is not sent to triage; the fetch is shared), `rowsPerLane` with Show all /
Hide (as Gmail). Order inside a lane: triage priority, then newest. Unread is Chat's own read
state (the plugin's marks change it in Chat; it keeps no seen state of its own).

## Triage (jev-triage `triage` v1, source `chat`)

- item: `{ id, text, hint?, floor?, fields: { from, space, kind: dm|group|space|thread, to: me|all|others|none, lane, jira? } }`.
- text (`triageText: full`), the old connector's shape: `Google Chat, direct message with <name>` /
  `…, space '<name>', one thread` / `…, group chat '<name>'`; `Participants: …`; `Addressed to:`
  one of the person (direct message), the person (@mentioned)[, also …], everyone (@all), the
  person (@mentioned at the thread's start), `<names> (@mentioned) - not the person`, the group,
  nobody in particular; then `Earlier in the conversation (context only, do not judge these):`
  up to 3 messages (300 characters each) and `New messages to judge:` the newest 5 (1500 each). A
  Recent row shows its newest message as the one to judge. Bot cards as their text. `summary`:
  only the first line, participants and addressed-to, no message text.
- hints and floors: every alert row -> hint noise (the old rule); an unread conversation that
  @mentions the person directly (a new message, or the thread's start) -> floor `action`. DMs and
  everything else: Jev decides.
- `jira`: the first issue key (`[A-Z][A-Z0-9_]*-N`) in the thread's start or the new messages (a
  field for rules; there is no Jira lookup in v1).
- Classify only shown and changed items (hash), listen to triage `change`, unsorted with a note
  when triage is off (as Gmail).

## Panel

As Gmail's: a setup guide or Sign in while not signed in (with what is missing); title bar meta via
`ctx.panels.header` (last poll · address) and ↻. Rows: triage dot, title (a DM: the person; a group
chat: its name or its people; a thread: its start's first line; a flat space: the space), a second
line `<space> · <sender>: <preview>` (DMs without the space), age, a count badge of new messages,
bold when unread. Click / Enter opens the conversation; hover buttons: the triage verdict
("action ▾"), Mark read or Mark unread (when the row has a target), Discuss, New; keyboard as
Gmail. No ↗.

## The conversation view (reviewer annotate, as Gmail)

- Fresh on open: a thread is `messages.list filter=thread.name` (100, oldest first shown); a DM,
  group chat or flat space its newest 50; a note when older ones are left out. An alert row: the
  alert messages of the last poll.
- Each message a card: sender, time, an "unread" mark (the row's new messages, and those of others
  after the first of them), the quoted message as a quote, the body from `formattedText` by our own
  builder into the reviewer's allow-list (escape everything; `*bold*`, `_italic_`, `~strike~`,
  `` `code` ``, ```` ``` ```` blocks, `<url|label>` and bare links http(s) only, `<users/ID>` as
  **@Name**), bot `cardsV2` as quotes (header, text rows through Gmail's HTML sanitizer, buttons as
  links), reactions as one line, a deleted message as "(deleted)".
- Pictures: uploaded raster attachments through `media.download`, the newest first, magic-number
  checked, Gmail's budgets and cache (`images.js`: 15, 700 KiB, 7.5 MiB, 10 s); Drive files as
  `https://drive.google.com/open?id=<id>` links (a file, not Chat); other files listed by name.
- `aside`: space, kind, threading, members (`membershipCount`), messages shown, unread. No Chat link.
- Annotate gets no `url` (no "Open in browser" icon: answer 2).
- Discuss / New send `About the Google Chat conversation "<title>" in <space>` + readable text.
  Without a reviewer: the plugin's own read-only page (Discuss, New session), as Gmail.

## CLI

`ccc chat status | refresh | list [lane] | show <id> | read <id> | unread <id> | login | logout |
client <file> | help`. `status`: client, account, user id found or not, scopes granted, last poll,
counts per lane, triage on/off, errors. `show` takes `spaces/S`, `spaces/S/threads/T` or
`alert:<name>`; `read` / `unread` take a row id of the last poll. No stdin.

## Settings (project)

`clientId`, `clientSecret`, `lanes` (`mentions`, `direct`, `spaces`, `alerts`, `recent`),
`rowsPerLane` 10, `days` 14 (1..90), `messagesPerSpace` 12 (5..100), `recentDays` 2 (1..14),
`maxRecent` 10, `recentPerSpace` 3, `alertBots` [], `pollMinutes` 2, `triageText` full|summary,
`markReadOnOpen` false. No regexes.

## Left out of v1

Writing anything but the read state (replies, reactions, edits), a thread's own read state (no API),
open in Chat (answer 2), muted spaces shown apart (`spaceMuteSetting` needs
`chat.users.spacesettings`), push (Workspace Events API: a Pub/Sub endpoint), Drive file download,
the Jira issue beside a conversation, several accounts in a project, personal (consumer) accounts,
Chat messages in Gmail.
