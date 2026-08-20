/**
 * Single source of truth for configuration.
 * `secret: true` fields are encrypted at rest and never sent to the browser
 * in full - the API returns a masked placeholder instead.
 */
export const DEFAULT_CONFIG = {
  web: {
    port: 8080,
    bindAddress: '0.0.0.0',
    adminPasswordHash: '',      // legacy single-password; migrated into `admins`
    // Portal accounts. First entry is the shared super-admin (created from the
    // legacy password on upgrade). Each: { username, passwordHash, role, createdAt, lastLogin }.
    // Password hashes are one-way scrypt, stored as-is (config.json is 0600).
    admins: [],
    sessionSecret: '',          // generated on first run
  },

  whatsapp: {
    phoneNumber: '',            // E.164 without '+', e.g. 15551234567
    loginMethod: 'pairing',     // 'pairing' (code pushed to phone) | 'qr'
    autoReconnect: true,
    markOnline: false,          // keeping this false leaves your phone's presence alone
    // Deliberate pacing between outbound actions. This exists so the bot does
    // not flood your own groups or hammer the connection, not to disguise it.
    // Messages, reactions and documents:
    minActionDelayMs: 1200,
    maxActionDelayMs: 3500,

    // Administrative actions - the ones WhatsApp watches for automation,
    // because no person does fifty of them in a row. Each value is the
    // MINIMUM quiet time before the next outbound action of that kind, and
    // the gap is shared across everything the bot does, so two bulk jobs at
    // once still add up to one paced stream rather than two.
    //
    // Calibrated at "a fast admin doing it by hand" - a little quicker than a
    // person, nowhere near as fast as a script. Slower is always safer; there
    // is no reason to turn these down. A deliberate 0 disables that gap and
    // is logged as a warning; anything that is not a number falls back to the
    // default below it.
    pacing: {
      // Random extra time added on top of every gap. A metronome-exact
      // interval is itself a signature - nobody taps a button every 5.000s.
      jitterMs: 2000,
      groupSettingMs: 5000,   // lock / unlock one group (lockdown.paceMs wins for lockdown runs)
      descriptionMs: 5000,    // rewrite one group's description
      participantMs: 4000,    // add / remove / promote / demote within one group
      crossGroupMs: 6000,     // act on the same person across many groups
      revokeMs: 2500,         // delete-for-everyone, one message
    },
  },

  plugins: {
    enabled: ['group-rules', 'moderation'],
  },

  // Rules text served on demand. Someone PMs the bot (or asks in a group) with
  // `rulesCommand` and gets the rules back. Seeded from the plugin's
  // default-rules.txt on first run; editable in the portal.
  groupRules: {
    rules: '',
    rulesCommand: '#rules',
    deleteChatAfterRules: true,  // clear the PM after answering, to keep the bot's chat list tidy
    // Per-group rule sets. Each is its own command (e.g. "#rules-support") the
    // bot answers with that text. `#rules` inside a group serves that group's
    // assigned set; in a DM it serves the master `rules` (or a menu of commands).
    ruleSets: [],          // [{ command: '#rules-support', label: 'Support groups', text: '...' }]
    groupRuleSet: {},      // { [groupJid]: '#rules-support' } - which set applies in which group
  },

  // Auto-moderation. Applies only inside `groups`, and only to rules an admin
  // has explicitly switched on - anything that breaks one is deleted for
  // everyone, exactly what an admin would otherwise do by hand.
  moderation: {
    enabled: false,             // master switch (off until an admin turns it on)
    groups: [],                 // group JIDs auto-moderation applies to
    exemptAdmins: true,         // group admins are never auto-moderated
    deleteMedia: false,         // pictures, screenshots, voice notes -> delete
    deleteLinks: false,         // messages containing a URL -> delete
    deleteOffFormat: false,     // enforce `prefix` / `minLength` below
    requirePrefix: false,       // if true, messages must start with `prefix`
    prefix: '',                 // e.g. '!post'
    minLength: 2,               // shorter than this (after the prefix) -> delete
    warnByDm: false,            // PM the person explaining why it was removed
    replyOnAction: false,       // also reply in the group, not just delete
    formatExample: '',          // shown in the warning DM, e.g. '!post Your message here'
    // Anti-flood: ignore further messages from the same person for this long.
    // 0 disables it.
    cooldownSecondsPerUser: 0,
  },

  // Optional announcements group: group admin events (joins, leaves, removals,
  // promotions) and lock/unlock are posted here as they happen. The person
  // involved is @-mentioned only when they are a member of that group.
  announce: {
    group: '',                  // JID of the announcements group ('' = off)
    tagActor: true,             // @mention the person the event is about
    tagGroup: true,             // @mention the group it happened in (same community only)
    noTag: [],                  // numbers that must NEVER be tagged (opt-out)
    events: {                   // which events post an update
      join: true,
      leave: true,
      remove: true,
      promote: true,
      demote: true,
      lock: true,
      unlock: true,
    },
  },

  // Shared serial job queue handed to every plugin as `ctx.queue`.
  queue: {
    concurrency: 1,
    maxLength: 50,
  },

  // Scheduled lockdown: lock all groups (admins-only messaging) during one or
  // more recurring weekly windows, evaluated in `timezone`.
  lockdown: {
    enabled: false,
    timezone: 'America/New_York',   // IANA zone the windows are read in
    // Each window: day 0=Sunday..6=Saturday (local to `timezone`), start
    // 'HH:MM' 24h, and how long it lasts. Windows may cross midnight and the
    // week boundary.
    windows: [],                    // [{ id, label, day, start, durationMinutes, enabled }]
    // A bulk lock/unlock walks the groups one at a time and waits this long
    // between each. Locking everything at once is a burst WhatsApp answers by
    // throttling or dropping the connection, so this stays generous: 5s a
    // group means ~5 minutes for 60 groups, which is the point.
    paceMs: 5000,
    // Groups that stay admins-only ALWAYS. Unlock (manual or scheduled) skips
    // these so a permanently-restricted group is never opened by the schedule.
    alwaysLocked: [],
  },

  // Locally-maintained banned numbers (from the "ban from all" action).
  bannedNumbers: [],

  logging: {
    level: 'info',            // console/UI verbosity; the file always gets debug
    retentionDays: 14,        // how long to keep rotated debug logs
    maxFileBytes: 33554432,   // roll over at 32 MB
  },

  email: {
    enabled: false,
    provider: 'gmail',        // gmail | outlook | yahoo | custom
    host: '',                 // custom only
    port: 587,                // custom only
    secure: false,            // custom only
    user: '',                 // your address, also the SMTP username
    appPassword: '',          // an APP password, not your account password
    from: '',                 // defaults to `user`
    to: '',                   // defaults to `user`
    // Email the log automatically when things go wrong, throttled so a
    // failing loop cannot fill your inbox.
    onError: false,
    errorThrottleMinutes: 30,
    dailySummary: false,
    dailySummaryHour: 8,
  },
};

/** Dot-paths whose values are encrypted at rest and masked in the API. */
export const SECRET_PATHS = [
  'web.adminPasswordHash',
  'web.sessionSecret',
  'email.appPassword',
];

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
    return o[k];
  }, obj);
  target[last] = value;
}

/** Recursive merge of stored config over defaults, so new keys appear on upgrade. */
export function mergeDefaults(stored, defaults = DEFAULT_CONFIG) {
  const out = Array.isArray(defaults) ? [] : {};
  for (const [k, dv] of Object.entries(defaults)) {
    const sv = stored?.[k];
    if (dv && typeof dv === 'object' && !Array.isArray(dv)) {
      out[k] = mergeDefaults(sv ?? {}, dv);
    } else {
      out[k] = sv !== undefined ? sv : dv;
    }
  }
  // Preserve keys the defaults don't know about (e.g. third-party plugin config)
  for (const k of Object.keys(stored ?? {})) {
    if (!(k in out)) out[k] = stored[k];
  }
  return out;
}
