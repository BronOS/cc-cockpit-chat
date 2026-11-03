'use strict'
// The setup guide the panel shows while not signed in (design "Setup"): numbered steps with the exact
// Google Cloud console pages. The page gets the steps with link ids only; a click posts the id and the
// host opens the fixed URL here with ctx.openExternal, so a page (or anything that reached it) cannot
// make the host open an address of its choosing. The README has the same steps in more words.
// (From bronos.gmail's setup.js; the steps are Chat's.)

const LINKS = {
  project: 'https://console.cloud.google.com/projectcreate',
  chatApi: 'https://console.cloud.google.com/apis/library/chat.googleapis.com',
  peopleApi: 'https://console.cloud.google.com/apis/library/people.googleapis.com',
  chatConfig: 'https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat',
  branding: 'https://console.cloud.google.com/auth/branding',
  audience: 'https://console.cloud.google.com/auth/audience',
  scopes: 'https://console.cloud.google.com/auth/scopes',
  clients: 'https://console.cloud.google.com/auth/clients/create',
  readme: 'https://github.com/BronOS/cc-cockpit-chat#set-up-google-cloud',
  permissions: 'https://myaccount.google.com/connections',
}

// Any https PNG works as the Chat app's avatar (the console asks for one); this is the one Google's
// own Chat quickstarts use.
const AVATAR_URL = 'https://developers.google.com/chat/images/quickstart-app-avatar.png'

/** The steps: `{ text, links: [{ id, label }] }`. */
const STEPS = [
  {
    text: 'Create a Google Cloud project inside your Google Workspace organisation (or use the one you made for the Gmail plugin). It is yours: nobody else sees your messages. A personal Google account cannot use the Chat API at all.',
    links: [{ id: 'project', label: 'New project' }],
  },
  { text: 'Enable the Google Chat API and the People API (for colleagues\' names) in that project.', links: [{ id: 'chatApi', label: 'Chat API' }, { id: 'peopleApi', label: 'People API' }] },
  {
    text: `Google Chat API > Configuration (Google takes "Mark read" only from a project with a Chat app): App name "cc-cockpit", Avatar URL ${AVATAR_URL} (any https PNG), Description "Mark read from cc-cockpit", Enable interactive features off, Save. Nobody can add this app to a space.`,
    links: [{ id: 'chatConfig', label: 'Configuration' }],
  },
  {
    text: 'Set up the consent screen (Google Auth Platform > Get started): an app name and your address. Audience: Internal (only your organisation; no verification, no expiry).',
    links: [{ id: 'branding', label: 'Branding' }, { id: 'audience', label: 'Audience' }],
  },
  {
    text: 'Data access: add the scopes .../auth/chat.spaces.readonly, .../auth/chat.messages.readonly, .../auth/chat.users.readstate (Google Chat API) and .../auth/directory.readonly (People API). The only change the plugin makes in Chat is the read state.',
    links: [{ id: 'scopes', label: 'Data access' }],
  },
  { text: 'Clients > Create client: application type "Desktop app", any name. Download the JSON file Google offers (the Gmail plugin\'s file works too).', links: [{ id: 'clients', label: 'Create client' }] },
  { text: 'Paste the whole file below and press Save client (or run `ccc chat client <file>`), then Sign in with Google and leave every box ticked on the consent page.', links: [] },
]

/** The URL of a link id from the page, or null for any other value. */
function linkUrl(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(LINKS, id) ? LINKS[id] : null
}

module.exports = { LINKS, STEPS, AVATAR_URL, linkUrl }
