# WhatsApp Group Bot

A WhatsApp bot for **managing groups**, with a web control panel. It handles the
work admins otherwise do by hand — rosters, kicks, bans, locking groups on a
schedule, serving the rules, deleting posts that break them — and everything
else you want it to do is a folder in `src/plugins/`.

---

## Read this first

**WhatsApp's Terms of Service prohibit automated use of a personal account.**
This connects as a linked device using the same multi-device protocol
WhatsApp Web uses. Accounts used this way do get banned, and a ban usually
takes the phone number with it permanently.

Mitigations that actually help:

- Use a spare number you can afford to lose, not your main one.
- Keep the pacing delays on (Settings → WhatsApp account).
- Do not add the bot to groups you do not own.
- Keep volume low and human-shaped.
- Be careful with the bulk actions. "Lock all groups" and "ban from all groups"
  fan out one API call per group, which is exactly the pattern WhatsApp rate
  limits. The bot paces them deliberately; do not remove that.

If this becomes something you rely on, move to the **WhatsApp Business Cloud
API**, which is the sanctioned route. The plugin interface here is
transport-agnostic enough that swapping the connection layer is a contained
change.

---

## What it does

**Groups**
- Live roster of every group the bot is in: subject, size, whether the bot is
  an admin, and the community each group is linked to
- Edit group description and subject, in bulk if you want
- Add, remove, promote and demote participants
- Lock a group (admins-only messaging) or unlock it
- Activity feed of joins, leaves, removals, promotions and join requests

**Members**
- One roster across all groups, de-duplicated per person, with how many groups
  they are in, where they are an admin, and how much they post
- Per-member detail: which groups, and a timeline of their admin events
- Ban from all groups in one action, optionally wiping the messages they
  posted in the last couple of days (WhatsApp's delete-for-everyone window)
- Locally-maintained banned-number list

**Scheduled lockdown**
- Lock every group on a recurring weekly window — weekday, start time,
  duration, in a timezone you pick, and as many windows as you want
- Groups on the always-locked list are never opened by an unlock
- A manual unlock overrides the current window without cancelling the schedule

**Rules**
- Anyone sends `#rules` and gets the group rules back, in a group or by DM
- Per-group rule sets, each also reachable by its own `#rules-<name>` command
- The bot clears its own DM afterwards so its chat list stays usable

**Auto-moderation**
- In nominated groups only, delete messages that break rules you switch on:
  media, links, a required prefix, a minimum length
- Group admins are exempt by default; the rules command is never deleted
- Optionally DM the person to explain why, or post a note in the group
- Per-user cooldown to blunt flooding

**Announcements**
- Optionally mirror admin activity into one nominated group as it happens,
  @-mentioning the person involved when they are a member of it, with an
  opt-out list for people who would rather not be tagged

**Operations**
- Web control panel with accounts and roles, scrypt-hashed passwords and an
  audit log of every action taken through it
- Debug log always at full detail, rotated and gzipped, viewable and
  downloadable from the panel
- Email alerts on error, and a daily summary

---

## Install

```bash
cd ~/whatsapp-bot
./install.sh
```

This installs Node 20 and `npm install`s the dependencies. Run it as your
normal user — it calls `sudo` where it needs to. It also writes
`whatsapp-bot.service` for this install from the template.

Then start it:

```bash
npm start
```

Or as a service that survives reboots:

```bash
sudo cp whatsapp-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-bot
```

Open the panel from any device on the network: `http://<server-ip>:8080`

First load asks you to set an admin password.

---

## Linking your number

Settings → WhatsApp account → enter the number in full international form,
digits only (`15551234567`), then Dashboard → **Link / Connect**.

**Pairing code** (default): the panel shows an 8-character code. On the
phone: WhatsApp → Settings → Linked devices → Link a device → *Link with
phone number instead* → type the code. No QR scanning, which is what you
want for a headless server.

**QR**: the panel renders a QR to scan instead. Either works; pairing is
easier when the phone isn't next to the screen.

The session is saved in `data/session/`. It survives restarts — you only
link once. "Unlink & wipe session" clears it.

---

## Scheduled lockdown

A window is a weekday, a start time and a duration, read in the timezone you
configure:

| Field | Meaning |
|---|---|
| `timezone` | IANA zone, e.g. `America/New_York`. All windows are read in it. |
| `day` | 0 = Sunday … 6 = Saturday, local to that zone |
| `start` | `HH:MM`, 24-hour, local to that zone |
| `durationMinutes` | How long the lock lasts. May cross midnight and the week boundary. |

Times are civil, not absolute: a window that starts at 18:00 stays at 18:00
across a daylight-saving change rather than drifting by an hour. A start time
that falls in a spring-forward gap resolves forward; one that falls in a
fall-back repeat takes the first occurrence. Overlapping windows merge into a
single continuous lock.

Unlocking never touches a group on the **always locked** list, so a
permanently-restricted group cannot be opened by the schedule or by a bulk
unlock. A manual unlock during a window is remembered against that window, so
the scheduler will not immediately re-lock it — the next window locks as
normal.

---

## Auto-moderation

Everything here is off until you switch it on, because the action is
destructive: a message that breaks an enabled rule is deleted for everyone.

| Rule | Deletes |
|---|---|
| `deleteMedia` | Anything that isn't plain text — images, screenshots, voice notes, stickers |
| `deleteLinks` | Messages containing a URL |
| `deleteOffFormat` | Messages missing the required `prefix`, or shorter than `minLength` |

It applies only in the groups listed in `moderation.groups`, never in a DM.
Group admins are exempt unless you turn that off, the bot's own messages are
never touched, and a recognised rules command is never deleted — the rules
have to stay reachable even in a strictly moderated group.

The link rule is deliberately narrow: an explicit scheme, a `www.` prefix, or
a bare domain on a known TLD. "See section 3.2" and "ok...fine" are not links.
A false positive deletes a real person's message, so anything ambiguous is
left alone.

If a check or a delete throws, the message is left in place and the error is
logged. Silently eating messages is a worse failure than missing one.

---

## Configuration

Everything is in the web UI. Behind it, `data/config.json` holds the
settings, with the password hashes and the session secret encrypted at rest
using `MASTER_KEY` from `.env`.

**Back up `.env`.** Lose it and the saved secrets become unreadable.

No third-party API keys are needed. The only outbound connection the bot makes
is to WhatsApp itself.

---

## Debug log and email alerts

### The log

Everything is written to `data/logs/debug-YYYY-MM-DD.log`, **always at debug
level** regardless of what the console is set to. The console verbosity in
Settings only affects what you see live; the file always gets the full trace.
That is the point — you want the detail available after something has already
gone wrong, not to have to reproduce it with logging turned up.

- Rotates daily, and again at 32 MB within a day
- Yesterday's files are gzipped automatically
- Pruned after 14 days (both configurable in Settings)
- **Writes are synchronous**, so the last lines before a crash are on disk.
  A buffered log loses exactly the lines that matter most.

The **Logs** tab has two halves: a live view with level and text filters, and
the saved files, which you can view in-browser or download.

### Email

Settings → **Email alerts**. Gmail, Outlook and Yahoo are presets; anything
else is custom SMTP.

Gmail and Outlook need an **app password**, not your account password, and
two-factor must be on before you can create one:
`myaccount.google.com` → Security → App passwords.

Three buttons, in increasing order of commitment:

| Button | What it does |
|---|---|
| **Check credentials** | Opens an SMTP session and authenticates. Sends nothing. |
| **Send test email** | Sends a short message so you can confirm delivery. |
| **Email me the log now** | Sends today's log, gzipped, with an error/warning count. |

Tick **Email me when an error is logged** for unattended running. It is
throttled (30 minutes by default) because a failing loop can log thousands of
errors a minute; errors during the quiet period are counted and summarised in
the next message rather than dropped. Alerts about the mailer itself are
ignored, so a broken SMTP config cannot start a loop.

The app password is encrypted at rest like every other secret, and the API
returns a mask rather than the value.

---

## Tests

```bash
npm test
```

Covers the scheduled-lock window maths (including both daylight-saving
transitions), the moderation rule decisions and their false-positive guards,
rules routing, the member roster and identity merging, ban-and-wipe, group
admin actions, auth and rate limiting, log rotation, and a lint pass over the
control panel that checks every element the frontend drives actually exists.
No network and no WhatsApp connection needed.

---

## Writing your own plugin

Copy `src/plugins/echo/` and add its folder name to Settings → Plugins.

```js
export default {
  name: 'my-plugin',
  description: 'what it does',
  configKey: 'myPlugin',        // optional slice of config.json

  async setup(ctx) {},

  async onMessage(msg, ctx) {
    if (msg.text === '!hello') {
      await ctx.bot.sendText(msg.chatJid, 'hi', { quoted: msg });
    }
  },

  async onConfigChange(config, ctx) {},
  async teardown() {},
};
```

`msg` is normalized: `{ id, chatJid, senderJid, senderNumber, isGroup, fromMe,
text, pushName, timestamp, messageType, key, raw }`.

`ctx` gives you:

| | |
|---|---|
| `ctx.bot` | the group-management API below |
| `ctx.config` | live config — always current, never a stale copy |
| `ctx.queue` | the shared serial queue, for anything slow |
| `ctx.store` | persistent key/value scoped to your plugin |
| `ctx.configStore` | to write config back (used for first-run seeding) |
| `ctx.log` | namespaced logger, streams to the Logs tab |

The parts of `ctx.bot` a group-management plugin actually wants:

| | |
|---|---|
| `sendText(jid, text, { quoted, mentions, groupMentions })` | send, optionally tagging people or a group |
| `react(msg, emoji)` / `deleteMessage(msg)` | acknowledge or remove a message |
| `groups()` / `groupDetails(jid)` / `groupsWithMembers()` | what the bot can see |
| `isGroupAdmin(jid, { jid, number })` / `groupMemberInfo(...)` | who someone is in a group |
| `modifyParticipants(jid, targets, action)` | add / remove / promote / demote |
| `setGroupLocked(jid, bool)` / `setAllGroupsLocked(bool)` | admins-only messaging |
| `setGroupSubject` / `setGroupDescription` / `applyDescriptions(plan)` | rename and re-describe |
| `banFromAllGroups(number, { wipeMessages })` | remove everywhere, optionally wiping |
| `deleteRecentMessagesFrom({ number, jid })` | wipe within WhatsApp's delete window |
| `sendDocument(jid, path, { fileName, mimetype })` | send a file, e.g. a roster export |

Long work goes through the queue so it stays serialized and cancellable:

```js
ctx.queue.add({
  label: 'something slow',
  run: async (job) => {
    job.progress('working', 50);
    if (job.isCancelled()) return;
  },
});
```

Plugin errors are caught per-plugin — one throwing never stops the others.

---

## Layout

```
src/
  index.js              entry point, wiring, shutdown
  core/
    bot.js              Baileys connection, reconnect, message normalizing,
                        and the whole group-management API
    plugin-manager.js   plugin loading and dispatch
    lockdown.js         recurring lock windows, DST-correct
    members.js          the cross-group member roster
    member-activity.js  per-member post counts
    message-index.js    recent message keys, so a ban can wipe what they posted
    announce.js         admin-activity announcements, with mention handling
    admin-commands.js   local privileged ops via data/bot-cmd.json
    alerts.js           error/summary email triggers
    queue.js            serial job queue
    state.js            persistent key/value
  plugins/
    group-rules/        serves #rules and per-group rule sets
    moderation/         deletes messages that break the configured rules
    echo/               template plugin
  web/
    server.js  api.js  auth.js  session-store.js  public/
  config/
    schema.js  store.js
  util/
    crypto  logger  filelog  mailer  semaphore  format
data/                   config, session, state, logs  (gitignored)
certs/                  drop a TLS-filter root CA here if your network has one
```

---

## Security

The panel binds to `0.0.0.0:8080` so you can reach it at `IP:port` from
another machine. That means anyone on your LAN can reach it too — and it holds
a live WhatsApp session that can read and send as your number, kick and ban
members, and delete other people's messages.

- Password login, scrypt-hashed, with rate limiting (8 tries / 15 min).
- Accounts have roles; destructive account management is super-admin only.
- Every action through the panel is written to an audit log.
- Secrets encrypted at rest in `config.json`.
- `data/` is `0700`, `.env` is `0600`.

**Do not port-forward this to the internet without HTTPS in front.** If you
need remote access, use an SSH tunnel:

```bash
ssh -L 8080:localhost:8080 <user>@<server-ip>
```

and set the bind address to `127.0.0.1`.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Pairing code never arrives | Number must be digits only with country code, no `+` |
| "Session taken over" | Another WhatsApp Web session displaced this one |
| Nothing happens in a group | The bot must be a member; check the group JID in Settings |
| Can't lock a group / kick someone | The bot must be an **admin** of that group |
| `group refresh failed: rate-overlimit` | WhatsApp throttles group listing after a reconnect. The bot retries with backoff; the list fills in shortly |
| A ban wiped nothing | Delete-for-everyone only works for about two days; older messages cannot be removed |
| Scheduled lock fired an hour early or late | Check `timezone` — the window is civil time in that zone, not server time |
| `unable to get local issuer certificate` | A TLS-intercepting filter — see `certs/README.txt` |
| `npm install` fails on certificates | Same; `npm config set cafile ...` |
| Email: "Rejected the login" | Use an app password, not your account password, and enable two-factor first |
| Email: timeout | Ports 465/587 may be blocked outbound on this network |

Logs: the **Logs** tab, or `journalctl -u whatsapp-bot -f`.
