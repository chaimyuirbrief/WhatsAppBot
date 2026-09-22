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
  are one API call per group, which is exactly the pattern WhatsApp rate
  limits. The bot paces every one of them on purpose — see [Pacing](#pacing-1).
  Expect them to take minutes, and do not turn the gaps down.

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

**Backup**
- One encrypted file with the settings, admins, WhatsApp link and master key
- Restores onto a fresh machine without re-pairing the phone
- From the portal or the command line

**Accountability**
- Per-admin sign-in time limits, set by the super-admin
- Every portal action is recorded against the admin who took it
- Filter the log by kind of action, by admin, or by phrase
- Click an admin to see their own trail

**Scheduled lockdown**
- Lock every group on a recurring weekly window — weekday, start time,
  duration, in a timezone you pick, and as many windows as you want
- Groups on the always-locked list are never opened by an unlock
- A manual unlock overrides the current window without cancelling the schedule
- Locking and unlocking is paced: one group at a time, 5 seconds apart, so
  WhatsApp is never handed the whole set at once

**Automatic Shabbos lock**
- Locks at candle lighting and unlocks after Havdalah, from the zmanim for a
  place you enter — no fixed time to adjust twice a year
- Zmanim computed on your own machine (KosherJava's), so it needs no internet
- Pick which zman each end uses, and shift either by minutes, so any minhag is
  reachable
- Lock on one city's candle lighting and unlock on a different city's Havdalah
- Yom Tov too, one day or two, with a chag running into Shabbos handled as one
  continuous lock
- Starts early enough that the *last* group is shut before candle lighting

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

## Set it up with Claude

If you use [Claude Code](https://claude.com/claude-code), clone this repo, open
a session in it, and paste one of the prompts below. They carry the things a
fresh session cannot guess — that the master key decrypts everything, that the
pacing is deliberate, that the panel must not be exposed — and they say where
Claude has to stop and hand back to you.

Read what it proposes before approving. It will ask for `sudo`.

### A fresh install

````text
Set up the WhatsApp group bot in this repo on this machine (Ubuntu). Read
README.md first — especially "Read this first", "Install" and "Pacing".

Things you need to know that aren't obvious:
- Run ./install.sh as my normal user, never as root. It calls sudo itself.
- On first run the app writes MASTER_KEY into .env. That key decrypts every
  stored secret. Never commit it, never print it in full, and remind me to
  back it up.
- The panel binds 0.0.0.0:8080. Do NOT port-forward it or open a firewall
  hole. If I ask for remote access, set web.bindAddress to 127.0.0.1 and give
  me the SSH tunnel command instead.
- The gaps under whatsapp.pacing are deliberate anti-ban measures. Don't
  lower them, and don't "optimise" the bulk actions to run faster.

Please:
1. Check Node is 20+, run ./install.sh, then npm test.
2. Confirm it installed and enabled the systemd service (install.sh does that
   by default), and show me how to read its logs. Don't use `npm start` —
   that runs in the foreground and would hang your session.
3. Confirm the panel responds on this machine, then give me the URL to open
   and stop.

Two things you can't do — hand them back to me:
- Setting the admin password. I do that on first page load.
- Linking the phone. I enter the number in the panel and type the pairing
  code into WhatsApp myself. Don't invent a phone number.

Once I tell you it's linked, remind me to run `node bin/backup.js create` and
to keep that file somewhere safe.
````

### Moving an existing bot onto this machine

````text
I'm moving a WhatsApp group bot onto this machine from another one. I have its
backup file at PATH/TO/backup.wabak and I know the passphrase.

Read README.md, especially "Backup and moving to a new machine".

Please:
1. Run ./install.sh and npm test.
2. Run `node bin/backup.js inspect PATH/TO/backup.wabak` and show me the
   output. The "master key" line must say "included" before we go further —
   if it says MISSING, stop and tell me, because the encrypted settings won't
   survive and I need a fresh backup from the old machine.
3. Give me the exact restore command to run in my own terminal.

Do not ask me to paste the backup passphrase into this chat, and don't put it
in a command you run — I'll type it myself.

After I tell you the restore succeeded:
4. Start the bot and confirm it comes back connected WITHOUT re-pairing the
   phone. That's the point of the restore; if it asks for a pairing code,
   something went wrong — check what the restore reported as skipped.
5. Install the systemd service.
6. Remind me to stop the bot on the old machine. Two instances sharing one
   WhatsApp session will fight, and one gets kicked off.
````

### Nightly backups

````text
Set up a nightly encrypted backup of this WhatsApp bot. Read the "Unattended
backups" part of README.md.

- Propose where the backups go and how many to keep, and ask me before you
  write anything.
- The passphrase must not end up in the crontab, in the repo, or in this
  conversation. Suggest a root-only file outside the repo and show me how to
  reference it — I'll put the passphrase in place myself.
- Add rotation so old backups get pruned.
- Show me how to verify a backup actually restores, rather than assuming it
  does. An untested backup isn't a backup.
````

### Setting up the automatic Shabbos lock

````text
Set up the automatic Shabbos lock on this bot. Read the "Automatic Shabbos
lock" section of README.md first.

My community: CITY / NEIGHBOURHOOD. We light MINUTES minutes before sunset and
we go by ZMAN for Havdalah (e.g. "tzais 72 minutes", "8.5 degrees", "42
minutes after sunset"). ISRAEL OR DIASPORA. Lock for Yom Tov too: YES / NO.

Please:
1. Tell me the exact coordinates, elevation and IANA timezone you would use
   for my location, and where you got them. If the place is in the built-in
   list, say so and use those.
2. Work out which zman key and which offsetMinutes match the Havdalah time I
   gave you — remember an offset on `sunset` covers any "N minutes after
   sunset" custom, so don't tell me it isn't supported.
3. Show me, for the next four Shabbosos and the next Yom Tov, the candle
   lighting and Havdalah times this setting produces, in my own timezone. I
   will check them against my luach before we save anything. If they are off
   by more than a minute or two, we have the wrong coordinates — fix that
   rather than adding an offset to paper over it.
4. Only once I confirm the times: give me the settings to enter in
   Members → Group lockdown → Automatic Shabbos lock, or the exact JSON for
   `lockdown.shabbos` in data/config.json. Don't switch it on for me.

Don't compute the zmanim yourself from a formula and don't look them up on a
website — use this repo's own code, so what I check is what the bot will
actually do:
  node -e "import('./src/core/zmanim.js').then(z => console.log(z.previewZmanim({ date: { y: 2026, m: 1, d: 16 }, location: { name: 'X', latitude: 0, longitude: 0, elevation: 0, timezone: 'UTC' } })))"

Finally, sanity-check the head start: tell me how many groups I have and
confirm the lock will start early enough that the last one is shut before
candle lighting.
````

---

## Install

Doing it by hand. To have Claude walk it, see
[Set it up with Claude](#set-it-up-with-claude) above.

```bash
cd ~/whatsapp-bot
./install.sh
```

This installs Node 20, `npm install`s the dependencies, and **installs the bot
as a systemd service that starts on boot**. Run it as your normal user — it
calls `sudo` where it needs to.

Starting on boot is the default because a bot that does not come back after a
reboot silently stops moderating, and the reboot is usually an unattended
`apt upgrade` at 3am with nobody around to run `npm start`.

```bash
sudo systemctl status whatsapp-bot     # is it up?
sudo journalctl -u whatsapp-bot -f     # follow the log
sudo systemctl restart whatsapp-bot    # after editing settings on disk
```

Re-running `./install.sh` after a `git pull` restarts the service, so it picks
the new code up.

Pass `--no-service` to skip that and run it in the foreground yourself with
`npm start` — useful while developing, or on a machine without systemd (the
installer detects that and says so rather than failing).

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

### Pacing

A lock or unlock walks the groups **strictly one at a time, waiting 5 seconds
between each** (`lockdown.paceMs`) — see [Pacing](#pacing-1) for the policy
this belongs to and the gaps every other action gets.

Sixty groups therefore take about five minutes. That is the intended
behaviour, so the run outlives the request that asked for it:

- **"Lock all groups now"** in the portal returns as soon as the run has
  *started*. The card then shows live progress (`12/60 done · about 4 min
  left`) and the last group it got through.
- Only one run walks the groups at a time. A second lock or unlock asked for
  while one is in flight is **refused**, not queued — the portal says so, and
  you ask again once it has finished. That is what stops a manual lock and a
  scheduled unlock interleaving and leaving groups in mixed states.
- The saved lock state and the announcement land when the run finishes, with
  the real counts. So if the process dies part-way through a lock, the state
  still reads "unlocked" and a scheduled window will lock everything again on
  the next tick. Outside a window — a manual lock, or the schedule switched
  off — nothing re-drives it, so check the state after a restart mid-run.

---

## Automatic Shabbos lock

Instead of a fixed clock time, the groups can lock at **candle lighting** and
unlock after **Havdalah**, worked out from the zmanim for a place you enter.
The times move with the sunset week by week, so there is nothing to adjust
twice a year or at the solstices.

The calculations are done **on your own machine** by
[`kosher-zmanim`](https://github.com/BehindTheMath/KosherZmanim), the
JavaScript port of [KosherJava](https://github.com/KosherJava/zmanim). That is
deliberate: no zmanim web service is called, so this keeps working on a box
with no internet, and a network problem can never be the reason the groups
stayed open into Shabbos. (`kosher-zmanim` is LGPL-3.0 and is used unmodified
as an ordinary npm dependency; none of its code is copied into this
repository.)

Everything lives under `lockdown.shabbos`, and it has its **own switch** — it
works whether or not the weekly windows above are on.

### Entering a location

Members → Group lockdown → Automatic Shabbos lock. Either pick a place from
the list (Brooklyn, Lakewood, Monsey, Jerusalem, Bnei Brak, London, Manchester,
Antwerp, Toronto, Melbourne, Johannesburg and more, with coordinates filled in)
or type your own:

| Field | Meaning |
|---|---|
| `name` | What you call it. Shown in the panel and the log. |
| `latitude` / `longitude` | Decimal degrees. Negative is south / west. |
| `elevation` | Metres above sea level. It moves sunset by a minute or two. |
| `timezone` | IANA zone, e.g. `America/New_York`. Refused if this machine does not know it. |
| `candleOffsetMinutes` | How long before sunset your community lights — 18 in most places, 40 in Jerusalem, 30 in Haifa. |

A blank or nonsense coordinate is **refused with a reason**, never quietly read
as 0 — a bot silently following the zmanim of a spot in the Atlantic would lock
at the wrong minute all year. **"Check the times here"** computes that
location's zmanim for the coming Friday so you can hold them against your own
luach before trusting them with the groups.

### Choosing the two zmanim

The lock end and the unlock end are configured independently, each with its own
place, its own zman and its own offset in minutes:

```json
"shabbos": {
  "enabled": true,
  "includeYomTov": true,
  "inIsrael": false,
  "locations": [ /* the places above */ ],
  "start": { "locationId": "bk", "zman": "candleLighting", "offsetMinutes": 0 },
  "end":   { "locationId": "jm", "zman": "tzais72",        "offsetMinutes": 5 },
  "leadMinutes": null
}
```

Available zmanim: `candleLighting`, `sunset`, `seaLevelSunset`, `plagHamincha`,
and for the unlock `tzais8.5`, `tzais7.083`, `tzais5.95`, `tzais3.7`,
`tzais16.1`, `tzais50`, `tzais60`, `tzais72`, `tzais72Zmanis`. Every one is
offered at both ends — the split is only about which is listed first.

`offsetMinutes` shifts the zman, which is what makes any minhag reachable
without a new option: **tzais at 42 minutes is `sunset` with an offset of 42**,
and a negative offset locks earlier.

**Two different places is a supported setup, not an accident** — lock on the
candle lighting where the groups are and unlock on a stricter city's Havdalah.
If the unlock lands *before* the same zman where the lock was read (an eastward
city, whose Havdalah falls during your Shabbos afternoon), the panel says so and
by how much, but still does what you asked.

### Yom Tov

With `includeYomTov` on, every day melacha is forbidden is locked, not only
Shabbos. `inIsrael` switches between one day of Yom Tov and two.

**Consecutive days are one lock.** Two days of Pesach running into Shabbos is a
single window from Wednesday's candle lighting to Saturday night — the groups
are not reopened at nightfall in between — and it keeps one identity for the
whole stretch, so an admin who unlocks by hand during Yom Tov is not re-locked
an hour later. Chol hamoed is not locked.

### The head start

Locking is deliberately slow — one group every `lockdown.paceMs` — so a lock
that *begins* at candle lighting *finishes* minutes after it. The window
therefore opens early enough for the **last** group to be shut by the zman
itself.

Left as `null`, `leadMinutes` is worked out from how many groups you have and
the configured pace (60 groups at 5s each ⇒ 6 minutes). Set a number to
override it. Note that `0` means "start exactly at the zman", which finishes
late; blank is not the same as zero.

The unlock is not given a head start, so the groups reopen a few minutes
*after* Havdalah rather than before it.

### When a zman has no answer

Far enough north the sun never reaches 8.5° below the horizon in summer, so the
degree-based calculations genuinely have no answer. Rather than skip the lock,
an approximation from sunset is used and **flagged as approximate** in the
panel. Under a true midnight sun, where there is no sunset at all, no time is
invented and that Shabbos is skipped.

The panel lists the next few locks exactly as the bot will run them, each time
on its own location's clock, so what you check is what will happen.

---

## Pacing

Everything this bot does to WhatsApp is deliberately slow. Not slow enough to
be useless — roughly a fast admin working through a list by hand, and a little
quicker than a person would actually manage. That is the whole point: the
throughput a burst would buy you is exactly the signal that gets an account
rate-limited or banned.

One clock, two sizes of gap, both configured under `whatsapp`:

**Messages, reactions and documents** — `minActionDelayMs` (1200) to
`maxActionDelayMs` (3500), picked at random per message. Auto-moderation's
delete-for-everyone rides this one too, so a flood of rule-breaking posts
cannot turn into a flood of outbound revokes.

**Administrative actions** — `whatsapp.pacing`, the ones nobody does fifty of
in a row:

| Setting | Default | Covers |
|---|---|---|
| `groupSettingMs` | 5000 | Locking / unlocking one group |
| `descriptionMs` | 5000 | Rewriting one group's description |
| `participantMs` | 4000 | Add / remove / promote / demote inside one group |
| `crossGroupMs` | 6000 | The same person across many groups (ban-from-all) |
| `revokeMs` | 2500 | Delete-for-everyone, one message |
| `jitterMs` | 2000 | Random extra added on top of **every** gap above |

Restraint at the connection level, same section:

| Setting | Default | Covers |
|---|---|---|
| `groupRefreshMs` | 600000 | How long the cached group list stays fresh (10 min). A bulk job that changed the membership forces a refresh anyway — it knows the cache is wrong — but debounced, and through the paced socket like anything else. |
| `reconnectMinMs` | 5000 | First reconnect attempt after a drop |
| `reconnectMaxMs` | 300000 | ...doubling up to 5 minutes, and no faster |

A bot that retries a dropped connection every two seconds is making the same
noise as a burst of edits, aimed at an endpoint that is already unhappy. If
WhatsApp answers a group refresh with a rate-limit, the retry backs off
1m → 2m → 4m → 8m → 16m, and routine traffic cannot shorten or restart that
ladder — letting a finishing bulk job reset it to ten seconds would turn
"back off for a quarter of an hour" into "come straight back".

Four properties matter more than the numbers:

- **The socket paces itself.** The gate is not something each method remembers
  to call — it lives under `bot.sock`, so *every* call through it waits its
  turn (`src/core/paced-socket.js`). A call nobody has classified gets the
  conservative default rather than going out instantly, and assigning a socket
  wraps it, so there is no way to end up holding an unpaced one. Slow is what
  you get by doing nothing; being fast has to be asked for.
- **One clock, shared.** Every gap is measured against the last thing the bot
  sent, whatever sent it. Two bulk jobs running at once still add up to one
  paced stream rather than two — otherwise "5 seconds apart" quietly becomes
  2.5 while a second job is running.
- **One action in flight.** Nothing fans out. A bulk job is a queue of one.
- **Jitter.** A gap of exactly 5.000s every time is a signature no human
  produces. The jitter only ever *adds*, so a configured gap is a floor.

A bulk job can say what its calls really are without re-implementing anything:
removing one person from forty groups is a stream of ordinary participant
updates, so `banFromAllGroups` runs them under `{ participant: 'crossGroup' }`
and the wider gap applies for the length of the sweep.

Bulk jobs are slow enough to outlive the request that started them — a
ban-from-all across forty groups is four minutes of work. Run them from the
portal, which reports progress, or through `ctx.queue` in a plugin.

A value that is not a real number (`null`, `""`, `false`, a typo) falls back
to the default rather than coercing to zero, because a silent zero is the
flood this exists to prevent. A deliberate numeric `0` **is** honoured and
logs a warning — but there is no good reason to set one.

---

## Who did what

Every action taken in the portal is recorded with the admin who took it, and
the **Logs** tab shows the trail.

Actions are bucketed into the handful of things admins actually do — sign-ins,
admin accounts, lock/unlock, bans and members, group edits, settings,
connection, job queue, email, log maintenance — and the tab offers a chip per
bucket, plus a per-admin dropdown, a free-text search, and newest/oldest
ordering. Chip counts describe the whole log, not the current filter, so they
do not shift about as you click through them. Only buckets that contain
something are offered.

On the **Admins** tab, clicking an account opens that admin's own trail
underneath it: how many actions they have on record, when they were last
active, a breakdown of what kind of actions they were, and their most recent
ones. "Open in Logs →" jumps to the full log already filtered to them.

A bucket is just the **first segment of the request path** — `/lockdown/lock`
is lockdown, `/members/ban-all` is members — so a route added next year is
bucketed the day it ships instead of piling into "Other". Two small tables in
`src/core/audit.js` shape the result and neither is load-bearing: one folds
segments that mean the same thing (`/banned` is a members action), the other
gives the buckets worth naming a label and an icon. A bucket with no entry
still works; it gets its segment title-cased.

Bucketing happens when the log is read rather than when it is written, so
history recorded before this existed is categorised too, and a correction
applies to everything rather than only to what happens next.

One action is recorded once. A route that describes itself ("add admin
\"bob\"") is not also filed under its bare method and path — recording both
put a shadow copy beside every entry and doubled every count.

---

## How long admins stay signed in

The super-admin sets, per account, how many minutes it may stay signed in to
the panel before it has to sign in again. `Admins` tab → **Sign-out after**.

| | |
|---|---|
| A number of minutes | The account is signed out that long after signing in |
| `0` | No timeout — **only allowed on a super-admin account** |
| Left alone | 4 hours for an admin; no timeout for a super-admin |

An ordinary admin cannot be unlimited, and that is the point of the setting.
The panel holds a live WhatsApp session, it is reachable by anyone on the LAN,
and the realistic way it gets used by someone it was not issued to is a browser
left open on a desk. A super-admin may opt themselves out; nobody else may.

Three things make it actually hold:

- **It is checked on the server, every request.** The cookie is sized to match
  so the browser forgets too, but a cookie is something an attacker would
  already have — the check that matters reads the current config each time.
- **Changing a cap applies to the session that account already has.** Shorten
  someone to 5 minutes and their open session is governed by 5 minutes, not by
  whatever it was when they signed in. No waiting for a next login that may
  never come.
- **The role is resolved live.** Demote a super-admin who had no timeout and
  the stored `0` stops meaning unlimited immediately.

Removing an account now ends its session too. Before this, a deleted admin kept
working until their cookie expired.

Admins with a cap see a countdown in the header, which turns to seconds in the
last five minutes and signs them out on the dot. Being silently logged out
mid-task is otherwise indistinguishable from the panel being broken.

---

## Backup and moving to a new machine

One encrypted file holds everything needed to stand this bot up again
somewhere else. `Settings → Backup & restore` in the portal, or from a shell:

```bash
node bin/backup.js create -o ~/wa-backup.wabak   # or: npm run backup
node bin/backup.js inspect ~/wa-backup.wabak     # what is in it, no passphrase needed
node bin/backup.js restore ~/wa-backup.wabak
```

### What travels, and what does not

| | |
|---|---|
| `data/config.json` | Settings, admin accounts, encrypted secrets |
| **`MASTER_KEY` from `.env`** | What those secrets are encrypted *with* |
| `data/session/` | The WhatsApp link — no need to re-pair the phone |
| `data/state.json` | Audit log, lockdown state, member activity, banned numbers |
| `data/backups/` | Saved original group descriptions |
| ~~`data/logs/`~~ | Left out: large, regenerated, useless to a rebuild |

The master key is the part that is easy to miss. Copying `data/` alone
restores to settings nobody can read — and it looks like it worked right up
until the SMTP password and session secret come back blank. So the key travels
with the config it decrypts.

### It is always encrypted, and that is not optional

The file contains a working WhatsApp session and the key to every stored
secret. Anyone holding it and the passphrase can act as your account. So there
is no plaintext option, the passphrase is at least 12 characters, and it is
stretched with scrypt before it touches the data. Lose the passphrase and the
backup is gone — including for you.

Only a super-admin can take or restore one, and both are recorded in the audit
log. `*.wabak` is in `.gitignore`.

### Moving to a new Ubuntu box

```bash
# on the old machine
node bin/backup.js create -o ~/wa-backup.wabak

# copy it across, then on the new one
git clone <your repo> && cd WhatsAppBot
./install.sh
node bin/backup.js restore ~/wa-backup.wabak
npm start
```

The bot comes back with its settings, its admins and its WhatsApp link intact.
There is a paste-ready prompt for this in
[Set it up with Claude](#set-it-up-with-claude) if you would rather have Claude
drive it.

### Restoring safely

- **Stop the bot first.** Writing over session files WhatsApp has open corrupts
  the link the backup exists to preserve. The portal refuses while connected;
  the CLI refuses if the service is running.
- **Nothing is deleted.** Whatever is in `data/` is copied to
  `data.pre-restore-<timestamp>/` before anything is written, so the wrong file
  is recoverable by hand.
- **Try it first** with `--dry-run`, which reports what would happen and writes
  nothing.
- **Restart afterwards.** Settings are read into memory at startup, so a
  restore is not in effect until the process comes back up.
- **An archive is untrusted input, even your own.** A backup is a file that
  gets carried between machines and handed to people, so a restore only writes
  the paths a backup is actually made of — never a `.js` or anything outside
  those sections, and never through a symlink already sitting in `data/`.
  Anything else in an archive is skipped and reported, not followed.

### Unattended backups

Set `BACKUP_PASSPHRASE` and the CLI will not prompt, so a nightly copy is a
cron line:

```
0 3 * * *  cd /opt/WhatsAppBot && BACKUP_PASSPHRASE='…' node bin/backup.js create -o /backups/wa-$(date +\%F).wabak
```

Keep those somewhere you would keep a password.

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
is to WhatsApp itself — the zmanim behind the Shabbos lock are calculated
locally, so nothing about it depends on a service staying up.

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

Covers backup and restore (what travels, the refusals, a full rebuild onto a
bare machine, and that a hostile archive cannot write outside the data
directory), the per-admin sign-in limits (who may be unlimited, expiry at the
boundary, and a session whose account was removed or demoted underneath it),
the outbound pacing (every bulk path, the shared clock, and the
fallbacks that stop a bad config value meaning "no pacing"), the audit log's
bucketing and per-admin queries (both the pure rules and the live HTTP
endpoints), the scheduled-lock window maths (including both daylight-saving
transitions), the Shabbos lock end to end (zmanim against published times for
several cities, the Hebrew calendar including a two-day chag running into
Shabbos in the diaspora and in Israel, the head start before candle lighting,
a two-city lock, what happens where a zman has no answer, and a round trip of
the whole panel through the real markup), the moderation rule decisions and their false-positive guards,
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
| `modifyParticipants(jid, targets, action)` | add / remove / promote / demote, in paced chunks of five |
| `setGroupLocked(jid, bool)` / `setAllGroupsLocked(bool, { paceMs, onProgress })` | admins-only messaging; the bulk form walks the groups one at a time, 5s apart |
| `setGroupSubject` / `setGroupDescription` / `applyDescriptions(plan)` | rename and re-describe |
| `banFromAllGroups(number, { wipeMessages })` | remove everywhere, optionally wiping — minutes, not seconds |
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
    lockdown.js         recurring lock windows, DST-correct, and the
                        zmanim-driven Shabbos / Yom Tov windows
    zmanim.js           candle lighting, tzais and the Hebrew calendar,
                        computed locally - no zmanim service is called
    audit.js            bucketing portal actions, per-admin queries
    paced-socket.js     the socket wrapper that makes pacing automatic
    backup.js           what travels to a new machine, encrypted
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
- Per-account sign-in time limits, enforced server-side on every request. Only
  a super-admin account may have no timeout. Removing an account, demoting it,
  or shortening its limit all take effect on the session it already has.
- Every action through the panel is written to an audit log.
- Secrets encrypted at rest in `config.json`.
- `data/` is `0700`, `.env` is `0600`.
- Backups are always passphrase-encrypted (scrypt + AES-256-GCM), super-admin
  only, and audited. A `.wabak` is a working copy of the account — treat it
  exactly like the server itself, and keep it off shared storage.

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
| Restored on a new box, but email/settings are blank | The backup had no `MASTER_KEY` — check `node bin/backup.js inspect` says "master key: included" |
| "Wrong passphrase, or the backup file is damaged" | Exactly that. There is no recovery path; the passphrase is not stored anywhere |
| Restore says it skipped files | The archive held paths outside the backed-up sections, or a symlink was in the way. Skipped entries are listed; nothing outside `data/` is ever written |
| Restore says a restart is required | It does. Settings are read into memory at startup — `sudo systemctl restart whatsapp-bot` |
| Signed out sooner than expected | Check the account's **Sign-out after** on the Admins tab. Accounts that predate the setting default to 4 hours |
| Cannot set an admin to 0 minutes | By design. Only a super-admin account may have no timeout |
| Bot did not come back after a reboot | `sudo systemctl is-enabled whatsapp-bot`. If it was installed with `--no-service`, enable it: `sudo systemctl enable --now whatsapp-bot` |
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
