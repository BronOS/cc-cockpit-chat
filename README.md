# Google Chat for cc-cockpit

`bronos.chat` shows your Google Chat in a cc-cockpit panel, in lanes, sorted by
[Jev triage](https://github.com/BronOS/cc-cockpit-jev-triage), and hands a conversation to Claude to
discuss. **It changes nothing in Google Chat but your read state**: Mark read, Mark unread, and (with
`markReadOnOpen`, off by default) opening an unread row. It never sends, edits, deletes or reacts to a
message. There is no "open in Chat" link anywhere.

- **Lanes**: Mentions (unread, @you by name, outside DMs), Direct messages (unread DMs and group
  chats), Spaces (the rest that is unread, @all included), Alerts (only when you list alert bots:
  Grafana alerts grouped by alert name) and Recent (read conversations of the last days).
- **Triage**: each lane is sorted by priority (urgent, action, fyi, noise), then the newest message.
  An unread conversation that @mentions you by name is at least action; alert groups are noise; the
  rest is judged by Jev through jev-triage.
- **Discuss with Claude**: click a row and the conversation opens in the reviewer overlay as a clean
  page (every message as a card, its pictures, its files listed), where you select text to add notes
  and press Discuss (the Claude tab you are looking at) or New session.
- **Mark read / Mark unread** on each row, and `ccc chat read|unread <id>`.
- `ccc chat ...` from any tab of the project.

Each project signs in on its own: two projects can use different Google accounts.

## Requirements

- **cc-cockpit 0.9.2 or later** (plugin API 1 with `ctx.oauth`, `ctx.secrets`, the panel title bar,
  `ctx.openExternal`, and Start over for a stuck sign-in). On an older app the panel says so and the
  plugin does nothing.
- **A Google Workspace (work or school) account.** Google's Chat API does not work with a personal
  Google account; the panel says so if you sign in with one.
- **Your own Google Cloud OAuth client** (free; the steps are below and in the panel). There is no
  shared client: Chat's message scope is "restricted", so a client shared by every user would need
  Google's verification and a paid yearly security assessment. The client file of the Gmail plugin
  works here too.
- **Jev triage (`bronos.jev-triage`) for sorting** (it needs the Jev plugin). Without it the lanes
  work unsorted and the panel says triage is off.
- What opening a conversation shows, by reviewer: the bundled reviewer shows the clean page with its
  pictures, a details column, notes, Discuss and New session; a reviewer whose `annotate` takes text
  only gets the conversation as plain text; without one, the plugin's own read-only page with the
  same page and Discuss and New session buttons (no notes).

## Set up Google Cloud

About ten minutes, once per Google account. The panel shows the same steps with buttons that open
each console page.

1. **A project inside your Workspace organisation**: <https://console.cloud.google.com/projectcreate>
   (or the project you made for the Gmail plugin). It is yours alone: nobody else sees your messages
   through it.
2. **Enable two APIs** in that project: the **Google Chat API**
   (<https://console.cloud.google.com/apis/library/chat.googleapis.com>) and the **People API**
   (<https://console.cloud.google.com/apis/library/people.googleapis.com>, for colleagues' names).
3. **The Chat app configuration.** Google takes a read-state change only from a project that has a
   Chat app configured, even though this plugin is not a bot. Google Chat API > **Configuration**
   (<https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat>), the minimum:
   - App name: `cc-cockpit`
   - Avatar URL: `https://developers.google.com/chat/images/quickstart-app-avatar.png` (any https
     PNG)
   - Description: `Mark read from cc-cockpit`
   - **Enable interactive features**: off
   - Save. Nobody can add this "app" to a space or talk to it; it only lets the read-state calls
     through.
4. **The consent screen**: Google Auth Platform > Get started
   (<https://console.cloud.google.com/auth/branding>): an app name and your address. **Audience**
   (<https://console.cloud.google.com/auth/audience>): user type **Internal**. Only people of your
   organisation can use the app; there is no verification, no warning screen and no 7-day expiry.
   (An External app works too while your admin allows it, but must be **In production**: Google ends
   a Testing app's sign-ins every 7 days.)
5. **Data access** (<https://console.cloud.google.com/auth/scopes>): Add or remove scopes, and tick
   - `.../auth/chat.spaces.readonly` (Google Chat API: "View chat and spaces in Google Chat")
   - `.../auth/chat.messages.readonly` ("View messages and reactions in Google Chat")
   - `.../auth/chat.users.readstate` ("View and modify last read time for Google Chat
     conversations")
   - `.../auth/directory.readonly` (People API: "See and download your organization's Google
     Workspace directory")

   Update, Save.
6. **The client** (<https://console.cloud.google.com/auth/clients/create>): application type
   **Desktop app**, any name, Create, then **Download JSON**. A "Web application" client does not
   work (the sign-in returns to `127.0.0.1` on a random port, which only a Desktop client allows).
   The Gmail plugin's file is fine.
7. **Give the client to the plugin**: paste the whole file into the box in the Google Chat panel and
   press **Save client**, or from a tab `ccc chat client ~/Downloads/client_secret_<id>.json`. (Or
   enter the client ID and secret in Settings > This project > Google Chat; a pasted file wins.)
8. **Sign in**: **Sign in with Google** in the panel (or `ccc chat login`). Pick your Workspace
   account and leave every box ticked on the consent page. A box left unticked is named in the panel
   afterwards: without the spaces, messages or read-state permission nothing can be shown; without
   the directory one some senders show as "unknown user".

   **"Access blocked"** (Error 403 access_denied): the project is External and in Testing and this
   account is not a test user, or it belongs to another organisation. Set the user type to Internal
   (or add the account as a test user), then press **Start over** in the panel (or run `ccc chat
   login` again): Google's error page never returns to the app, and Start over cancels the stuck
   sign-in.

To stop: **Sign out** in the panel (or `ccc chat logout`) deletes the stored sign-in; to revoke the
app at Google: <https://myaccount.google.com/connections>. Uninstalling the plugin deletes its
keychain entries (the sign-in) on purpose; the pasted client file is kept with the project's plugin
storage, so after a reinstall you only sign in again.

## Inbox

Since 0.3.0 the plugin provides the `inbox-feed` service (v2) to the Inbox plugin, which merges Chat,
Mail, Jira and more into one list and applies its own rules. The feed is the plugin's scope: the
**unread conversations of every lane that is on** (Mentions, Direct messages, Spaces, Alerts) and the
**read conversations of the Recent lane** (the last `recentDays`, at most `maxRecent`); a lane you
switched off is not in it. Alert groups are a panel idea: each conversation of a group is its own
item, labelled `alert` and `alert:<name>`. Each item carries what rules can use: the conversation's
name, a preview of the latest message, who wrote it, whether it is a direct message (`direct`) or a
group chat or space (`group`), whether it names you (`mentionsMe`; `@all` is the label `mention:all`),
read or unread, the space's display name, the label `jira:ABC-12` for a Jira key in the text, and the
actions open, mark read / mark unread. An item's `rev` is its newest message, so a new message changes
it and a read change does not. A thread whose newest message is a reply cannot be marked in Chat's
API (see below), so its item offers only open. The triage verdicts of the panel stay in the panel.
It is built from the rows the panel already holds, never with a Google call. The plugin tells Inbox
what changed after each poll and each mark (an `item` per changed conversation, `gone` for one that
left the scope) and sends the whole list when it starts, after a sign-in and whenever its state
changes (an error, a recovery, a different error message). Inbox can open a conversation (the same
as a click on its row) and mark it read or unread (the same write as Mark read). The panel's footer
shows the scope line Inbox sees. Nothing leaves your machine: the data goes to another plugin of the
same project. Inbox 0.2.0 reads v2; an older Inbox (v1) no longer gets Chat from this version.
Providing needs no newer app; Inbox 0.2.0 reading it needs cc-cockpit 0.10.0, and the toolbar buttons below
need an app with `ctx.overlay.buttons` (0.10).

**Conversation overlays.** A conversation opens with the overlay type `inbox-item { source: "bronos.chat", id }`
(the reviewer gets it in `prepare` and `annotate`; our own reader page starts at once with
`ready: 'manual'`, before the conversation is read, and drops its loader once it is drawn). On an app
that has `ctx.overlay.buttons`, the overlay of one of this plugin's own conversations gets Mark read /
Mark unread in its toolbar (the same code as the feed's `act`; a failure shows in the panel's notice),
and the reader page's Discuss with Claude sends the latest messages (capped). Only a conversation still
in the feed gets the buttons. An alert group row has no type.

## Read state: what Mark read and Mark unread change

Google Chat keeps **one read time per space** (and one per followed thread, which only Chat itself
sets). A mark moves the space's read time, so it has side effects inside the same space:

- **Mark read** sets the space's read time to the newest message of others in the row (only forward,
  never back). Everything older in that space reads as read too, in Chat as well.
- **Mark unread** sets it one microsecond before that message (only back, never forward). Everything
  after it in the space reads as unread too.
- An **alert row** (one alert across spaces) moves each of its spaces to its newest alert message.
  Alert rows have Mark read only.
- A **thread you do not follow whose news is only replies** (it shows in Recent, not as unread) has
  no buttons: its replies are judged by the thread's own read time, which only Chat sets.
- The row changes at once; the call runs; the next poll replaces the guess with what Chat says. When
  the call fails, the row is put back and a notice says why ("Could not mark ... It is shown as
  before.").
- **Opening** an unread row marks it read once the view is up when `markReadOnOpen` is on (default off: opening only shows it).
  Discuss, New session and `ccc chat show` never mark.

## Settings (per project)

Settings > This project > Google Chat, or from a tab: `ccc plugin config bronos.chat <key>=<value>`
(everything but the client secret).

| Setting | Default | |
|---|---|---|
| `clientId` | | your Desktop client's ID (ends in `.apps.googleusercontent.com`); a pasted client file wins; changing it signs you out |
| `clientSecret` | | secret, Settings only; the same client's secret |
| `lanes` | all on | `mentions`, `direct`, `spaces`, `alerts`, `recent`: a hidden lane is never sent to triage |
| `alertBots` | `[]` | bot display names (as Chat shows them, e.g. `Grafana`) whose alerts go to Alerts; empty: no Alerts lane |
| `rowsPerLane` | 10 | rows a lane shows; the rest behind Show all (remembered per lane) |
| `days` | 14 | spaces quiet longer are not read; the mentions search looks this far back |
| `messagesPerSpace` | 12 | the newest messages read from a space that changed (5 to 100) |
| `recentDays` | 2 | how far back Recent looks (1 to 14) |
| `maxRecent` | 10 | the read conversations Recent shows |
| `recentPerSpace` | 3 | at most this many of one space in Recent |
| `pollMinutes` | 2 | only while the project's window is open |
| `markReadOnOpen` | `false` | opening an unread row marks it read |
| `triageText` | `full` | `full` or `summary` (see Privacy) |

```sh
ccc plugin config bronos.chat 'alertBots=["Grafana"]' pollMinutes=5
ccc plugin config bronos.chat markReadOnOpen=true
```

## How a poll works

Every `pollMinutes` while the window is open, and with the refresh icon in the panel's title bar
(which also shows the last poll and the account):

1. `spaces.list` (your spaces, DMs and group chats with their last activity), kept when active within
   `days`.
2. One mentions search (`messages:search`, @you since `days` ago), so a mention outside a space's
   newest messages still shows.
3. For each space whose activity changed, that had unread rows, that you marked from here, or that
   has an unread mention: its read time, then its newest `messagesPerSpace` messages. What is new
   follows Chat's own sidebar: in a DM, group chat or flat space every message of others after your
   read time; in a threaded space a new thread, a reply that @mentions you (or @all), or any reply in
   a thread whose start @mentioned you.
4. Names nobody gave (Chat leaves some out) from the People API, one call, cached per project.

A quiet poll is a handful of calls. When Chat is busy (429 or 5xx) the interval doubles, up to 30
minutes, with a notice. One space that fails keeps its last rows and is noted.

**Click a row** (or Enter) to open it. The hover buttons: the triage verdict (**action ▾**: change
how much it needs you), **Mark read** or **Mark unread**, **Discuss** and **New**. Keyboard: Tab to
a row, arrows move, Enter or Space opens, Tab goes on to the row's buttons.

## The conversation view

Opening reads the conversation fresh (a thread: its newest 100 messages; a DM, group chat or flat
space: its newest 50) and shows each message oldest first as a card: sender, time, an "unread"
mark, the message it quotes, its text, a bot's cards, its pictures and files, its reactions. The
details column has the space, kind, threading, members, the people and the unread count.

The page is built by the plugin itself, never shown as Chat sent it: Chat's text marks (`*bold*`,
`_italic_`, `~strike~`, code, links, @mentions) become plain tags, every text is escaped, links keep
only http(s) addresses, and a bot card's HTML goes through the same sanitizer as the Gmail plugin's.
Pictures uploaded to Chat are downloaded by the plugin (at most 15 a conversation, 700 KiB each,
PNG, JPEG, GIF, WebP checked on the bytes; cached in the project's data folder); other files are
listed by name, a Drive file linked. The page is at most 2 MB of HTML: the oldest messages give way
first, with a line saying how many.

## CLI

```
ccc chat status            client, account, user id, scopes, last poll, counts per lane, errors
ccc chat refresh           poll Google Chat now and print the counts
ccc chat list [lane]       mentions, direct, spaces, alerts, recent
ccc chat show <id>         a conversation as readable text (never marks it read)
ccc chat read <id>         mark it read in Google Chat
ccc chat unread <id>       mark it unread in Google Chat
ccc chat login             start the Google sign-in (the browser does the rest)
ccc chat logout            sign out: the stored sign-in is deleted
ccc chat client <file>     use the OAuth client file downloaded from Google Cloud
ccc chat help
```

Ids are `spaces/<id>` (a DM, group chat or flat space), `spaces/<id>/threads/<id>` (a thread) or
`alert:<name>`, as `ccc chat list` prints them.

## Privacy

- The plugin talks to Google only: the sign-in through cc-cockpit's OAuth (your browser,
  `accounts.google.com` and `oauth2.googleapis.com`), your Chat through `chat.googleapis.com`, names
  through `people.googleapis.com`, and who signed in through `oauth2.googleapis.com/tokeninfo`. The
  access token goes nowhere else, never in a URL, and never follows a redirect. Tokens and the
  client secret are never logged, shown in the panel or printed by `ccc chat`.
- The only change it makes in Chat is your read time of a space (see "Read state").
- The refresh token is in the OS keychain (cc-cockpit's secrets store) under a key of this project
  and client; the access token stays in memory. A pasted client file is kept in the plugin's storage
  for this project (Google does not treat a Desktop client's secret as confidential).
- With `triageText: full` (the default), who wrote, where, whom it addresses and the text of up to 3
  earlier and 5 new messages of each shown conversation (cut to 300 and 1500 characters) go to
  **Jev** (through jev-triage; Jev calls a model provider, see the Jev plugin) to be sorted. If your
  employer objects to chat text leaving, set `triageText` to `summary` (who, where and whom only), or
  turn jev-triage off for the project.
- Discuss and New session put the conversation's text into a Claude Code session, which sends it to
  Anthropic like anything else you type there.
- Kept in the project's data folder, all bounded: the spaces' activity and read times with the few
  messages per conversation the lanes need (`state.json`), up to 2000 colleagues' names
  (`names.json`), and downloaded pictures (300 files, 64 MiB).

## Development

Plain JavaScript, no build step and no dependencies: `dist/host.js` and `dist/lib/*.js` run as they
are. `npm test` (`node --test test/`) runs the suites (node:test, a fake Google Chat, People API and
sign-in with made-up data; nothing reaches the network). Design: `docs/design.md`. Where the
cc-cockpit guide fell short while building it: `FRICTION.md`.

Link a checkout from a cc-cockpit tab: `ccc plugin link <folder>`; logs: `ccc plugin logs bronos.chat`.

## License

MIT, see LICENSE.
