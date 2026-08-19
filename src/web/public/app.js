/* Control panel front-end. Vanilla JS on purpose: no build step, no toolchain
   to maintain on the server, and it stays fast on a small box. */

const $ = (id) => document.getElementById(id);
const api = async (method, url, body) => {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

  if (!res.ok) {
    // A lapsed session must not be reported as "unauthorized" against
    // whatever button was pressed - that reads as the credentials being
    // wrong when the real problem is simply being logged out.
    if (res.status === 401 && !url.startsWith('/auth/')) {
      sessionExpired();
      throw Object.assign(new Error('Your session expired — please sign in again'),
                          { status: 401, handled: true });
    }
    throw Object.assign(new Error(data?.error ?? res.statusText), { status: res.status, data });
  }
  return data;
};

let gateShownForExpiry = false;
function sessionExpired() {
  if (gateShownForExpiry) return;
  gateShownForExpiry = true;
  SETUP_MODE = false;
  $('gate-title').textContent = 'Signed out';
  $('gate-sub').textContent = 'Your session ended. Sign in to continue.';
  $('gate-pw').value = '';
  $('gate-pw2').classList.add('hidden');
  $('gate-btn').textContent = 'Sign in';
  $('gate-err').textContent = '';
  showGate();
}

let CONFIG = null;
let GROUPS = [];
let SETUP_MODE = false;

/* ------------------------------ toast ------------------------------ */
let toastTimer;
function toast(msg, bad = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

/* ------------------------------ gate ------------------------------- */
let CURRENT_USER = null;

async function boot() {
  const status = await api('GET', '/auth/status');
  if (status.setupRequired) {
    SETUP_MODE = true;
    $('gate-title').textContent = 'Set a super-admin password';
    $('gate-sub').textContent = 'First run — create the super-admin login (username is "superadmin"). At least 8 characters.';
    $('gate-user').classList.add('hidden');
    $('gate-pw').placeholder = 'New password';
    $('gate-pw').autocomplete = 'new-password';
    $('gate-pw2').classList.remove('hidden');
    $('gate-btn').textContent = 'Create';
    showGate();
  } else if (!status.authed) {
    $('gate-user').classList.remove('hidden');
    showGate();
  } else {
    CURRENT_USER = status.user;
    await enterApp();
  }
}

function showGate() {
  $('gate').classList.remove('hidden');
  $('app').classList.add('hidden');
  setTimeout(() => $('gate-pw').focus(), 60);
}

$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('gate-pw').value;
  $('gate-err').textContent = '';
  try {
    let r;
    if (SETUP_MODE) {
      if (pw !== $('gate-pw2').value) { $('gate-err').textContent = 'Passwords do not match'; return; }
      r = await api('POST', '/auth/setup', { password: pw });
    } else {
      r = await api('POST', '/auth/login', { username: $('gate-user').value.trim(), password: pw });
    }
    CURRENT_USER = r.user ?? null;
    $('gate').classList.add('hidden');
    gateShownForExpiry = false;
    await enterApp();
  } catch (err) {
    $('gate-err').textContent = err.message;
  }
});

$('btn-logout').addEventListener('click', async () => {
  await api('POST', '/auth/logout');
  location.reload();
});

async function enterApp() {
  $('app').classList.remove('hidden');
  applyUser();
  await loadConfig();
  loadAdmins();
  loadAudit();
  loadLockdown();
  loadBanned();
  loadMembersRoster();
  setTimeout(initPortalNav, 120);
  await Promise.all([loadGroups(), loadDiagnostics(), loadQueue(), loadLogs(), loadLogFiles(), loadGroupActivity()]);
  connectEvents();
}

/* ------------------------------ tabs ------------------------------- */
/** Switch tabs programmatically, used by the "open full log →" links. */
function goTab(name) {
  const btn = document.querySelector(`.tab[data-tab="${name}"]`);
  if (btn) btn.click();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('.card-link');
  if (!link) return;
  e.preventDefault();
  goTab(link.dataset.goto);
});

$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`);
  });
});

/* ----------------------------- config ------------------------------ */
async function loadConfig() {
  CONFIG = await api('GET', '/config');
  fillForm(CONFIG);
}

/** Announcement events, in the order they appear in the settings card. */
const ANNOUNCE_EVENTS = ['join', 'leave', 'remove', 'promote', 'demote', 'lock', 'unlock'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* Working copies of the two repeatable lists. The rendered rows are what gets
   saved; these hold what was last loaded, so a row can be added or removed
   without losing edits made to the others. */
let RULE_SETS = [];
let LOCK_WINDOWS = [];

function fillForm(c) {
  const wa = c.whatsapp ?? {};
  const gr = c.groupRules ?? {};
  const an = c.announce ?? {};

  $('f-phone').value = wa.phoneNumber ?? '';
  $('f-loginmethod').value = wa.loginMethod ?? 'pairing';
  $('f-autoreconnect').checked = !!wa.autoReconnect;
  $('f-markonline').checked = !!wa.markOnline;
  $('f-mindelay').value = wa.minActionDelayMs;
  $('f-maxdelay').value = wa.maxActionDelayMs;

  $('f-rules').value = gr.rules ?? '';
  $('f-rules-cmd').value = gr.rulesCommand ?? '#rules';
  $('f-rules-delchat').checked = gr.deleteChatAfterRules !== false;
  RULE_SETS = (gr.ruleSets ?? []).map((s) => ({
    command: s.command ?? '', label: s.label ?? '', text: s.text ?? '',
  }));
  renderRuleSets();
  renderRuleAssign();

  // The auto-moderation card lives on the Members tab, next to the other
  // things that act on people, but it is saved with the rest of the settings.
  fillModeration(c.moderation ?? {});

  // Announcements. The group picker is filled once the group list arrives.
  $('f-ann-tagactor').checked = an.tagActor !== false;
  $('f-ann-taggroup').checked = an.tagGroup !== false;
  $('f-ann-notag').value = (an.noTag ?? []).join('\n');
  const ev = an.events ?? {};
  for (const k of ANNOUNCE_EVENTS) $(`f-ann-ev-${k}`).checked = ev[k] !== false;

  // Lockdown - card on the Members tab, same deal as moderation.
  $('f-lock-enabled').checked = !!c.lockdown?.enabled;
  $('f-lock-tz').value = c.lockdown?.timezone ?? '';
  LOCK_WINDOWS = (c.lockdown?.windows ?? []).map(normalizeWindow);
  renderLockWindows();

  $('f-queue-concurrency').value = c.queue?.concurrency ?? 1;
  $('f-queue-maxlength').value = c.queue?.maxLength ?? 50;

  $('f-port').value = c.web.port;
  $('f-bind').value = c.web.bindAddress;
  $('f-loglevel').value = c.logging.level;

  const em = c.email ?? {};
  $('f-em-enabled').checked = !!em.enabled;
  $('f-em-provider').value = em.provider ?? 'gmail';
  $('f-em-host').value = em.host ?? '';
  $('f-em-port').value = em.port ?? 587;
  $('f-em-secure').checked = !!em.secure;
  $('f-em-user').value = em.user ?? '';
  $('f-em-pass').value = em.appPassword ?? '';
  $('f-em-to').value = em.to ?? '';
  $('f-em-onerror').checked = !!em.onError;
  $('f-em-throttle').value = em.errorThrottleMinutes ?? 30;
  syncEmailSections();
  $('f-plugins').value = (c.plugins?.enabled ?? []).join('\n');
}

/* -------------------------- auto-moderation ------------------------- */
function fillModeration(m) {
  $('f-mod-enabled').checked = !!m.enabled;
  $('f-mod-admins').checked = m.exemptAdmins !== false;
  $('f-mod-media').checked = !!m.deleteMedia;
  $('f-mod-links').checked = !!m.deleteLinks;
  $('f-mod-offformat').checked = !!m.deleteOffFormat;
  $('f-mod-requireprefix').checked = !!m.requirePrefix;
  $('f-mod-prefix').value = m.prefix ?? '';
  $('f-mod-minlength').value = m.minLength ?? 0;
  $('f-mod-dm').checked = !!m.warnByDm;
  $('f-mod-reply').checked = !!m.replyOnAction;
  $('f-mod-example').value = m.formatExample ?? '';
  $('f-mod-cooldown').value = m.cooldownSecondsPerUser ?? 0;
}

function collectModeration() {
  const m = {
    enabled: $('f-mod-enabled').checked,
    exemptAdmins: $('f-mod-admins').checked,
    deleteMedia: $('f-mod-media').checked,
    deleteLinks: $('f-mod-links').checked,
    deleteOffFormat: $('f-mod-offformat').checked,
    requirePrefix: $('f-mod-requireprefix').checked,
    prefix: $('f-mod-prefix').value,
    minLength: +$('f-mod-minlength').value,
    warnByDm: $('f-mod-dm').checked,
    replyOnAction: $('f-mod-reply').checked,
    formatExample: $('f-mod-example').value,
    cooldownSecondsPerUser: +$('f-mod-cooldown').value,
  };
  // Only send the group list when the picker actually rendered. A save made
  // while the group list was unavailable must not wipe the configured groups.
  if (document.querySelectorAll('#group-checks input').length) {
    m.groups = [...document.querySelectorAll('#group-checks input:checked')].map((i) => i.value);
  }
  return m;
}

/* ----------------------------- rule sets ---------------------------- */
function renderRuleSets() {
  const box = $('rule-sets');
  if (!box) return;
  box.innerHTML = RULE_SETS.length ? RULE_SETS.map((s, i) => `
    <div class="item rs-row">
      <div class="row gap wrap">
        <label class="flex1">Command<input class="rs-cmd" value="${esc(s.command)}" placeholder="#rules-support"></label>
        <label class="flex1">Name<input class="rs-label" value="${esc(s.label)}" placeholder="Support groups"></label>
      </div>
      <label>Rules text<textarea class="rs-text" rows="5" placeholder="(rules for these groups)">${esc(s.text)}</textarea></label>
      <button class="btn tiny danger" onclick="removeRuleSet(${i})">Remove this set</button>
    </div>`).join('') : '<div class="empty">No extra rule sets.</div>';
}

/** The rendered rows are authoritative - they carry any unsaved edits. */
function collectRuleSets() {
  return [...document.querySelectorAll('#rule-sets .rs-row')].map((row) => ({
    command: row.querySelector('.rs-cmd').value.trim(),
    label: row.querySelector('.rs-label').value.trim(),
    text: row.querySelector('.rs-text').value,
  }));
}

window.removeRuleSet = (i) => {
  RULE_SETS = collectRuleSets();
  RULE_SETS.splice(i, 1);
  renderRuleSets();
  renderRuleAssign();
};

$('btn-ruleset-add')?.addEventListener('click', () => {
  RULE_SETS = collectRuleSets();
  RULE_SETS.push({ command: '', label: '', text: '' });
  renderRuleSets();
});

/** Which rule set answers `#rules` inside each group. */
function renderRuleAssign() {
  const box = $('rule-assign');
  if (!box) return;
  if (!GROUPS.length) { box.innerHTML = '<div class="empty">Connect WhatsApp to load groups.</div>'; return; }
  const assigned = CONFIG?.groupRules?.groupRuleSet ?? {};
  const sets = collectRuleSets().filter((s) => s.command);
  box.innerHTML = GROUPS.map((g) => {
    const cur = assigned[g.jid] ?? '';
    let opts = '<option value="">— master rules —</option>' +
      sets.map((s) => `<option value="${esc(s.command)}" ${s.command === cur ? 'selected' : ''}>${esc(s.label || s.command)}</option>`).join('');
    // A set that was renamed or removed must not silently drop the assignment.
    if (cur && !sets.some((s) => s.command === cur)) {
      opts += `<option value="${esc(cur)}" selected>${esc(cur)} (saved)</option>`;
    }
    return `<label>${esc(g.subject)}<select class="rs-assign" data-jid="${esc(g.jid)}">${opts}</select></label>`;
  }).join('');
}

function collectRuleAssign() {
  const out = { ...(CONFIG?.groupRules?.groupRuleSet ?? {}) };
  document.querySelectorAll('#rule-assign select').forEach((sel) => {
    const jid = sel.dataset.jid;
    if (!jid) return;
    // Sending back to the master rules writes an empty string rather than
    // dropping the key: the server merges this object into the stored one, so
    // a deleted key would simply keep its old value. An empty assignment reads
    // as "no set" everywhere it is used.
    out[jid] = sel.value || '';
  });
  return out;
}

function collectGroupRules() {
  return {
    rules: $('f-rules').value,
    rulesCommand: $('f-rules-cmd').value.trim() || '#rules',
    deleteChatAfterRules: $('f-rules-delchat').checked,
    ruleSets: collectRuleSets().filter((s) => s.command),
    groupRuleSet: collectRuleAssign(),
  };
}

/* ------------------------- lockdown windows ------------------------- */
function normalizeWindow(w) {
  return {
    id: w?.id || `w${Math.random().toString(36).slice(2, 8)}`,
    label: w?.label ?? '',
    day: Number.isFinite(+w?.day) ? +w.day : 0,
    start: /^\d{1,2}:\d{2}$/.test(w?.start ?? '') ? w.start : '09:00',
    durationMinutes: +w?.durationMinutes > 0 ? +w.durationMinutes : 60,
    enabled: w?.enabled !== false,
  };
}

function renderLockWindows() {
  const box = $('lock-windows');
  if (!box) return;
  box.innerHTML = LOCK_WINDOWS.length ? LOCK_WINDOWS.map((w, i) => `
    <div class="item win-row" data-id="${esc(w.id)}">
      <label class="check"><input type="checkbox" class="w-on" ${w.enabled ? 'checked' : ''}> Active</label>
      <div class="row gap wrap">
        <label class="flex1">Day
          <select class="w-day">${DAY_NAMES.map((d, n) => `<option value="${n}" ${n === w.day ? 'selected' : ''}>${d}</option>`).join('')}</select>
        </label>
        <label class="flex1">Starts<input class="w-start" type="time" value="${esc(w.start)}"></label>
        <label class="flex1">Lasts (minutes)<input class="w-dur" type="number" min="1" value="${w.durationMinutes}"></label>
      </div>
      <label>Label <span class="hint">optional - shown in the log and the announcement</span>
        <input class="w-label" value="${esc(w.label)}" placeholder="Weekly quiet hours">
      </label>
      <button class="btn tiny danger" onclick="removeLockWindow(${i})">Remove this window</button>
    </div>`).join('') : '<div class="empty">No windows yet.</div>';
}

function collectLockWindows() {
  return [...document.querySelectorAll('#lock-windows .win-row')].map((row) => normalizeWindow({
    id: row.dataset.id,
    label: row.querySelector('.w-label').value.trim(),
    day: +row.querySelector('.w-day').value,
    start: row.querySelector('.w-start').value,
    durationMinutes: +row.querySelector('.w-dur').value,
    enabled: row.querySelector('.w-on').checked,
  }));
}

window.removeLockWindow = (i) => {
  LOCK_WINDOWS = collectLockWindows();
  LOCK_WINDOWS.splice(i, 1);
  renderLockWindows();
};

$('btn-lockwin-add')?.addEventListener('click', () => {
  LOCK_WINDOWS = collectLockWindows();
  LOCK_WINDOWS.push(normalizeWindow({}));
  renderLockWindows();
});

function collectLockdown() {
  const out = {
    enabled: $('f-lock-enabled').checked,
    timezone: $('f-lock-tz').value.trim(),
    windows: collectLockWindows(),
  };
  // Same guard as the group picker: never blank a list the page never drew.
  if (document.querySelectorAll('.al-g').length) {
    out.alwaysLocked = [...document.querySelectorAll('.al-g:checked')].map((i) => i.value);
  }
  return out;
}

function collectForm() {
  const lines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);

  return {
    whatsapp: {
      phoneNumber: $('f-phone').value.replace(/[^0-9]/g, ''),
      loginMethod: $('f-loginmethod').value,
      autoReconnect: $('f-autoreconnect').checked,
      markOnline: $('f-markonline').checked,
      minActionDelayMs: +$('f-mindelay').value,
      maxActionDelayMs: +$('f-maxdelay').value,
    },
    groupRules: collectGroupRules(),
    moderation: collectModeration(),
    announce: {
      group: $('f-ann-group').value,
      tagActor: $('f-ann-tagactor').checked,
      tagGroup: $('f-ann-taggroup').checked,
      noTag: $('f-ann-notag').value.split(/[\n,]/).map((x) => x.replace(/[^0-9]/g, '')).filter(Boolean),
      events: Object.fromEntries(ANNOUNCE_EVENTS.map((k) => [k, $(`f-ann-ev-${k}`).checked])),
    },
    queue: {
      concurrency: +$('f-queue-concurrency').value,
      maxLength: +$('f-queue-maxlength').value,
    },
    lockdown: collectLockdown(),
    web: { port: +$('f-port').value, bindAddress: $('f-bind').value },
    logging: { level: $('f-loglevel').value },
    email: {
      enabled: $('f-em-enabled').checked,
      provider: $('f-em-provider').value,
      host: $('f-em-host').value,
      port: +$('f-em-port').value,
      secure: $('f-em-secure').checked,
      user: $('f-em-user').value,
      appPassword: $('f-em-pass').value,
      to: $('f-em-to').value,
      onError: $('f-em-onerror').checked,
      errorThrottleMinutes: +$('f-em-throttle').value,
    },
    plugins: { enabled: lines($('f-plugins').value) },
  };
}

$('btn-save').addEventListener('click', async () => {
  try {
    const form = collectForm();
    // The server refuses to blank a working group list, because a form saved
    // while the list was unavailable would otherwise wipe it. If the boxes
    // are on screen and you have genuinely unticked them all, say so.
    const listWasRendered = document.querySelectorAll('#group-checks input').length > 0;
    const deliberate = listWasRendered && (form.moderation.groups ?? []).length === 0;
    CONFIG = await api('PUT', `/config${deliberate ? '?allowEmptyGroups=1' : ''}`, form);
    fillForm(CONFIG);
    $('save-note').textContent = `Saved ${new Date().toLocaleTimeString()}`;
    toast('Settings saved');
    loadDiagnostics();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ----------------------------- groups ------------------------------ */
/** The API may answer with a bare array (SSE) or a wrapper object. */
function unwrapGroups(payload) {
  return Array.isArray(payload) ? payload : (payload?.groups ?? []);
}

async function loadGroups(refresh = false) {
  try {
    GROUPS = unwrapGroups(await api('GET', `/wa/groups${refresh ? '?refresh=1' : ''}`));
  } catch { GROUPS = []; }
  renderGroups();
}

function describeAge(ms) {
  if (!isFinite(ms)) return 'never fetched';
  const s = Math.round(ms / 1000);
  if (s < 60) return `updated ${s}s ago`;
  return `updated ${Math.round(s / 60)}m ago`;
}

function renderGroups() {
  renderGroupsList();
  renderMxGroups();
  const box = $('group-checks');
  const chosen = CONFIG?.moderation?.groups ?? [];

  // Any group that is configured but missing from the fetched list still gets
  // a checked row. Without this, saving while the list is unavailable (it is
  // rate-limited for a while after reconnecting) would submit zero checkboxes
  // and silently wipe the configuration.
  const known = new Set(GROUPS.map((g) => g.jid));
  const rows = [
    ...GROUPS.map((g) => ({ jid: g.jid, label: esc(g.subject), size: g.size, known: true })),
    ...chosen.filter((j) => !known.has(j)).map((j) => ({ jid: j, label: '(not in the fetched list)', known: false })),
  ];

  if (!rows.length) {
    box.innerHTML = '<div class="empty">No groups loaded. Connect WhatsApp, then hit Refresh.</div>';
    $('groups-note').textContent = '';
  } else {
    box.innerHTML = rows.map((g) => `
      <label class="check">
        <input type="checkbox" value="${esc(g.jid)}" ${chosen.includes(g.jid) ? 'checked' : ''}>
        <span>${g.known ? `${g.label} <span class="muted small">(${g.size})</span>` : `<span class="muted">${g.label}</span>`}
          <br><span class="gjid">${esc(g.jid)}</span></span>
      </label>`).join('');
    const missing = rows.length - GROUPS.length;
    $('groups-note').textContent = GROUPS.length
      ? `${GROUPS.length} groups${missing ? ` (+${missing} configured but not listed)` : ''}`
      : `${missing} configured group(s); list not loaded yet`;
  }

  renderAnnounceGroup();
  renderRuleAssign();
  // The lockdown card renders before the group list has arrived. Fill it in
  // once the groups are known, but never redraw over ticks already on screen.
  if (!document.querySelector('.al-g')) renderAlwaysLocked();
}

/** The announcements group picker, kept in step with the fetched group list. */
function renderAnnounceGroup() {
  const sel = $('f-ann-group');
  if (!sel) return;
  const cur = CONFIG?.announce?.group ?? '';
  sel.innerHTML = '<option value="">— none —</option>' +
    GROUPS.map((g) => `<option value="${esc(g.jid)}" ${g.jid === cur ? 'selected' : ''}>${esc(g.subject)}</option>`).join('');
  if (cur && !GROUPS.find((g) => g.jid === cur)) {
    sel.insertAdjacentHTML('beforeend', `<option value="${esc(cur)}" selected>${esc(cur)} (saved)</option>`);
  }
}

$('btn-refresh-groups').addEventListener('click', async () => {
  const btn = $('btn-refresh-groups');
  btn.disabled = true;
  $('groups-note').textContent = 'refreshing…';
  try {
    const r = await api('GET', '/wa/groups?refresh=1');
    GROUPS = unwrapGroups(r);
    renderGroups();
    // A cached answer is a normal outcome, not a failure worth alarming about.
    const detail = r.refreshed ? 'refreshed just now' : (r.note ?? describeAge(r.ageMs));
    $('groups-note').innerHTML = `${GROUPS.length} groups <span class="muted">· ${esc(detail)}</span>`;
    toast(r.refreshed ? `${GROUPS.length} groups refreshed` : `${GROUPS.length} groups · ${detail}`);
  } catch (err) {
    if (err.data?.groups?.length) { GROUPS = err.data.groups; renderGroups(); }
    $('groups-note').innerHTML = `<span style="color:var(--warn)">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
});

/* ---------------------------- connection --------------------------- */
function renderStatus(s) {
  const dot = $('conn-dot'), pill = $('conn-pill');
  const map = {
    connected: ['ok', 'Connected'],
    connecting: ['warn', 'Connecting…'],
    'awaiting-pairing': ['warn', 'Waiting for pairing'],
    'awaiting-qr': ['warn', 'Waiting for QR scan'],
    conflict: ['bad', 'Session taken over'],
    error: ['bad', 'Error'],
    stopped: ['', 'Not connected'],
  };
  const [cls, label] = map[s.state] ?? ['', s.state];
  dot.className = `dot ${cls}`;
  pill.className = `pill ${cls}`;
  pill.textContent = label;
  $('conn-state').textContent = label;
  $('conn-detail').textContent = s.me?.id
    ? `${s.me.name ?? ''} · ${s.me.id.split(':')[0]} · ${s.groupCount} groups`
    : (s.lastError ?? '');

  const area = $('link-area');
  if (s.pairingCode) {
    area.innerHTML = `
      <div class="pair-box">
        <div class="muted small">Enter this code on your phone</div>
        <div class="pair-code">${esc(s.pairingCode)}</div>
        <ol class="pair-steps">
          <li>Open WhatsApp on the phone for this number</li>
          <li>Settings → Linked devices → Link a device</li>
          <li>Tap <strong>Link with phone number instead</strong></li>
          <li>Type the code above</li>
        </ol>
      </div>`;
  } else if (s.qr) {
    area.innerHTML = `
      <div class="pair-box">
        <div class="muted small">Scan with WhatsApp → Linked devices</div>
        <img src="${s.qr}" alt="QR code">
      </div>`;
  } else {
    area.innerHTML = '';
  }
}

$('btn-start').addEventListener('click', async () => {
  try { await api('POST', '/wa/start'); toast('Connecting…'); }
  catch (err) { toast(err.message, true); }
});
$('btn-stop').addEventListener('click', async () => {
  await api('POST', '/wa/stop'); toast('Disconnected');
});
$('btn-wipe').addEventListener('click', async () => {
  if (!confirm('Unlink this number and delete the saved session?\n\nYou will need to link again from scratch.')) return;
  await api('POST', '/wa/logout');
  toast('Session wiped');
});

/* ---------------------------- job queue ---------------------------- */
/* The shared serial queue every plugin hands background work to. Nothing
   here knows what a job does - it only shows what is running and waiting. */
async function loadQueue() {
  try { renderQueue(await api('GET', '/queue')); } catch { /* not fatal */ }
}

/* Which job a skip has been asked for, so the button can say so straight away
   instead of looking like nothing happened until the queue next reports in.
   `lastQueue` is the snapshot on screen, so it can be redrawn without asking
   the server for one it has already sent. */
let pendingSkip = null;
let lastQueue = null;

function renderQueue(q) {
  lastQueue = q ?? lastQueue;
  const active = q?.active ?? [];
  const pending = q?.pending ?? [];
  if (pendingSkip && !active.some((j) => j.id === pendingSkip)) pendingSkip = null;
  $('queue-count').textContent = active.length + pending.length;

  const box = $('queue-list');
  if (!box) return;
  if (!active.length && !pending.length) {
    box.innerHTML = `<div class="empty">${q?.paused ? 'Queue paused — nothing waiting.' : 'Nothing queued.'}</div>`;
    return;
  }

  const running = active.map((j) => {
    const pct = j.progress?.pct ?? 0;
    const note = j.progress?.text ?? '';
    return `
      <div class="item">
        <div class="item-top">
          <span class="item-title">${esc(j.label)}</span>
          <span class="tag running">running</span>
        </div>
        ${note ? `<div class="item-sub">${esc(note)}</div>` : ''}
        ${pct ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
        <div class="row gap" style="margin-top:9px">
          ${pendingSkip === j.id
            ? '<button class="btn tiny warn" disabled>Skipping…</button>'
            : `<button class="btn tiny warn" title="Stop this job and move on to the next one" onclick="skipJob('${j.id}')">Skip${pending.length ? ` (${pending.length} waiting)` : ''}</button>`}
          <button class="btn tiny danger" onclick="cancelJob('${j.id}')">Cancel</button>
        </div>
      </div>`;
  }).join('');

  const waiting = pending.map((j, i) => `
      <div class="item">
        <div class="item-top">
          <span class="item-title">${i + 1}. ${esc(j.label)}</span>
          <span class="tag pending">waiting</span>
        </div>
        <div class="row gap" style="margin-top:9px">
          <button class="btn tiny" title="Move up"   onclick="moveJob('${j.id}','up')"   ${i === 0 ? 'disabled' : ''}>▲</button>
          <button class="btn tiny" title="Move down" onclick="moveJob('${j.id}','down')" ${i === pending.length - 1 ? 'disabled' : ''}>▼</button>
          <button class="btn tiny" title="Run next"  onclick="moveJob('${j.id}','top')"  ${i === 0 ? 'disabled' : ''}>⤒ next</button>
          <button class="btn tiny danger" onclick="cancelJob('${j.id}')">Cancel</button>
        </div>
      </div>`).join('');

  box.innerHTML = running + waiting +
    (q?.paused ? '<div class="item-sub" style="margin-top:8px">Queue paused — waiting jobs stay put until you resume.</div>' : '');
}

window.cancelJob = async (id) => {
  await api('DELETE', `/queue/${id}`);
  toast('Cancelled');
};

window.moveJob = async (id, dir) => {
  try { await api('POST', `/queue/${id}/move`, { dir }); }
  catch (err) { toast(err.message, true); }
};

/* Skip abandons the running job so the queue advances; cancel drops it
   outright. The distinction matters in the history - a skipped job is
   recorded as skipped rather than silently disappearing. */
window.skipJob = async (id) => {
  pendingSkip = id;
  if (lastQueue) renderQueue(lastQueue);   // show "Skipping…" at once
  toast('Skipping — stopping this job…');
  try {
    await api('POST', `/queue/${id}/skip`);
  } catch (err) {
    pendingSkip = null;
    if (!err.handled) toast(err.message, true);
    loadQueue();
  }
  // pendingSkip clears itself in renderQueue once the job leaves the active set.
};

/* ---------------------------- group rules --------------------------- */
$('btn-rules-save')?.addEventListener('click', async () => {
  $('rules-note').textContent = 'saving…';
  try {
    CONFIG = await api('PUT', '/config', { groupRules: collectGroupRules() });
    RULE_SETS = (CONFIG.groupRules?.ruleSets ?? []).map((s) => ({
      command: s.command ?? '', label: s.label ?? '', text: s.text ?? '',
    }));
    renderRuleSets();
    renderRuleAssign();
    $('rules-note').innerHTML = '<span style="color:var(--accent)">saved</span>';
    toast('Rules updated');
  } catch (err) { $('rules-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});

$('btn-pause').addEventListener('click', () => api('POST', '/queue/pause').then(() => toast('Paused')));
$('btn-resume').addEventListener('click', () => api('POST', '/queue/resume').then(() => toast('Resumed')));
$('btn-clearq').addEventListener('click', async () => {
  const r = await api('POST', '/queue/clear');
  toast(`Cleared ${r.cleared} waiting job(s)`);
});

/* --------------------------- diagnostics --------------------------- */
async function loadDiagnostics() {
  try {
    const d = await api('GET', '/diagnostics');
    $('diag').innerHTML = `
      <span class="k">node</span><span class="v">${esc(d.node)}</span>
      <span class="k">uptime</span><span class="v">${fmtDur(d.uptimeSec)}</span>
      <span class="k">memory</span><span class="v">${esc(d.memory?.rssHuman ?? '?')}</span>
      <span class="k">disk free</span><span class="v">${esc(d.disk?.freeHuman ?? '?')}</span>`;
    $('plugin-list').innerHTML = d.plugins.length
      ? d.plugins.map((p) => `<span class="k">${esc(p.name)}</span><span class="v">${esc(p.description)}</span>`).join('')
      : '<span class="k">none loaded</span><span class="v"></span>';
  } catch (err) {
    $('diag').innerHTML = `<span class="k">error</span><span class="v">${esc(err.message)}</span>`;
  }
}
$('btn-diag').addEventListener('click', loadDiagnostics);

/* ------------------------ connectivity check ----------------------- */
async function runConnCheck() {
  const box = $('conncheck');
  box.innerHTML = '<div class="empty">Checking…</div>';
  try {
    const d = await api('GET', '/test/connectivity');
    box.innerHTML = d.results.map((r) => `
      <div class="item">
        <div class="item-top">
          <span class="item-title">${esc(r.name)}</span>
          <span class="tag ${r.ok ? 'done' : 'failed'}">${r.ok ? `HTTP ${r.status}` : 'failed'}</span>
        </div>
        <div class="item-sub">${r.ok ? `${r.ms} ms` : esc(r.error)}${r.hint ? `<br><strong>${esc(r.hint)}</strong>` : ''}</div>
      </div>`).join('') +
      (d.anyCertProblem
        ? `<div class="verdict bad" style="margin-top:10px">TLS interception detected — see certs/README.txt</div>`
        : '') +
      (d.extraCaLoaded
        ? `<div class="item-sub" style="margin-top:8px">Extra CA bundle loaded: <code>${esc(d.extraCaLoaded)}</code></div>`
        : '');
  } catch (err) {
    box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`;
  }
}
$('btn-conncheck').addEventListener('click', runConnCheck);

/* ------------------------------- logs ------------------------------ */
async function loadLogs() {
  try {
    logLines = await api('GET', '/logs?n=300');
    renderLog();
  } catch { /* not fatal */ }
}
function logLine(l) {
  const t = new Date(l.ts).toLocaleTimeString();
  return `<span class="lg-${l.level}"><span class="lg-ts">${t}</span> [${l.level}] (${esc(l.scope)}) ${esc(l.msg)}</span>\n`;
}
function scrollLog() {
  if ($('log-follow').checked) { const b = $('log-out'); b.scrollTop = b.scrollHeight; }
}
$('btn-log-clear').addEventListener('click', () => { logLines = []; renderLog(); });

/* --------------------------- password ------------------------------ */
$('btn-chpw').addEventListener('click', async () => {
  try {
    await api('POST', '/auth/password', { current: $('f-pw-cur').value, next: $('f-pw-new').value });
    $('f-pw-cur').value = ''; $('f-pw-new').value = '';
    $('pw-result').innerHTML = '<span style="color:var(--accent)">updated</span>';
    toast('Password updated');
  } catch (err) {
    $('pw-result').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
});

/* ------------------------------ email ------------------------------ */
$('f-em-provider').addEventListener('change', syncEmailSections);
function syncEmailSections() {
  $('em-custom').classList.toggle('hidden', $('f-em-provider').value !== 'custom');
}

function emailBody() {
  return {
    provider: $('f-em-provider').value,
    host: $('f-em-host').value,
    port: +$('f-em-port').value,
    secure: $('f-em-secure').checked,
    user: $('f-em-user').value,
    appPassword: $('f-em-pass').value,
    to: $('f-em-to').value,
    enabled: true,
  };
}

async function emailAction(btn, url, body, okMsg) {
  const el = $('em-result');
  const b = $(btn);
  b.disabled = true;
  el.innerHTML = '<span class="muted">working…</span>';
  try {
    const r = await api('POST', url, body);
    el.innerHTML = r.ok
      ? `<span style="color:var(--accent)">${esc(okMsg)}${r.detail ? ` — ${esc(r.detail)}` : ''}</span>`
      : `<span style="color:var(--danger)">${esc(r.error)}</span>`;
    if (r.ok) toast(okMsg);
  } catch (err) {
    if (!err.handled) el.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  } finally {
    b.disabled = false;
  }
}

$('btn-em-verify').addEventListener('click', () =>
  emailAction('btn-em-verify', '/email/verify', emailBody(), 'Credentials accepted'));
$('btn-em-test').addEventListener('click', () =>
  emailAction('btn-em-test', '/email/test', emailBody(), 'Test email sent'));
$('btn-em-sendlog').addEventListener('click', () =>
  emailAction('btn-em-sendlog', '/email/send-log', {}, "Log emailed"));

/* --------------------------- saved log files ----------------------- */
async function loadLogFiles() {
  const box = $('logfiles');
  try {
    const files = await api('GET', '/logs/files');
    if (!files.length) { box.innerHTML = '<div class="empty">No log files yet.</div>'; return; }
    box.innerHTML = files.map((f) => `
      <div class="item">
        <div class="item-top">
          <span class="item-title">${esc(f.name)}</span>
          <span class="muted small">${fmtBytes(f.size)}${f.gzipped ? ' · gzipped' : ''}</span>
        </div>
        <div class="item-sub">${new Date(f.mtime).toLocaleString()}</div>
        <div class="row gap" style="margin-top:8px">
          <button class="btn small" onclick="viewLogFile('${esc(f.name)}')">View</button>
          <a class="btn small" href="/api/logs/download/${encodeURIComponent(f.name)}">Download</a>
        </div>
      </div>`).join('');
  } catch (err) {
    box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`;
  }
}

window.viewLogFile = async (name) => {
  const view = $('logfile-view');
  view.classList.remove('hidden');
  view.textContent = 'loading…';
  try {
    const res = await fetch(`/api/logs/file/${encodeURIComponent(name)}`);
    view.textContent = await res.text();
    view.scrollTop = view.scrollHeight;
  } catch (err) {
    view.textContent = `error: ${err.message}`;
  }
};

$('btn-logfiles-refresh').addEventListener('click', loadLogFiles);
$('btn-logfiles-email').addEventListener('click', () =>
  emailAction('btn-logfiles-email', '/email/send-log', { label: "today's debug log" }, 'Log emailed'));

/* --------------------------- live log filter ----------------------- */
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
let logLines = [];

/** Compact mirror of the live log, shown on the dashboard. */
function renderDashMirrors() {
  const dl = $('dash-log');
  if (dl) {
    dl.innerHTML = logLines.slice(-40).map(logLine).join('');
    dl.scrollTop = dl.scrollHeight;
  }
}

function renderLog() {
  const q = $('log-filter').value.toLowerCase();
  const min = $('log-level').value;
  const minRank = min ? LEVEL_RANK[min] : -1;
  const shown = logLines.filter((l) => {
    if (minRank >= 0 && LEVEL_RANK[l.level] < minRank) return false;
    if (min === 'error' && l.level !== 'error') return false;
    if (q && !(`${l.scope} ${l.msg}`.toLowerCase().includes(q))) return false;
    return true;
  });
  $('log-out').innerHTML = shown.map(logLine).join('');
  $('log-count').textContent = `${shown.length} of ${logLines.length} lines`;
  scrollLog();
  renderDashMirrors();
}

$('log-filter').addEventListener('input', renderLog);
$('log-level').addEventListener('change', renderLog);

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B','KB','MB','GB'];
  const i = Math.min(u.length-1, Math.floor(Math.log(n)/Math.log(1024)));
  return `${(n/1024**i).toFixed(i?1:0)} ${u[i]}`;
}

/* --------------------------- members / lockdown -------------------- */
let lockPollTimer = null;

/** Seconds the server leaves between groups during a bulk lock/unlock. */
function lockPaceSeconds(st) {
  const ms = Number(st?.paceMs ?? CONFIG?.lockdown?.paceMs);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 5;
}

/**
 * A lock/unlock walks the groups one at a time, seconds apart, so it is still
 * running long after the button click returns. Render how far along it is.
 */
function renderLockRun(run, paceSecs) {
  if (!run) return '';
  const verb = run.action === 'lock' ? 'Locking' : 'Unlocking';
  const total = Number.isFinite(run.total) ? run.total : null;
  const pct = total ? Math.round((run.done / Math.max(1, total)) * 100) : 0;
  const left = total ? Math.max(0, total - run.done) * paceSecs : null;
  const eta = left === null ? '' : ` · about ${left < 60 ? `${left}s` : `${Math.ceil(left / 60)} min`} left`;
  return `
    <div class="muted small" style="margin-top:8px">
      ⏳ ${verb} groups one at a time, ${paceSecs}s apart — ${run.done}${total === null ? '' : `/${total}`} done${eta}
      ${run.current ? `<br>last done: ${esc(run.current)}` : ''}
    </div>
    <div class="bar" style="margin-top:6px"><i style="width:${pct}%"></i></div>`;
}

/**
 * `statusOnly` refreshes just the status panel. The 3s poll that follows a
 * paced run uses it: re-seeding the form from CONFIG on every tick would throw
 * away whatever the admin is part-way through typing into the schedule.
 */
async function loadLockdown({ statusOnly = false } = {}) {
  const box = $('lock-status');
  if (!box) return;
  try {
    const st = await api('GET', '/lockdown/status');
    const paceSecs = lockPaceSeconds(st);
    box.innerHTML = `
      <div class="status-row">
        <span class="dot ${st.locked ? 'bad' : 'ok'}"></span>
        <div>
          <div class="status-title">${st.locked ? '🔒 Groups are LOCKED' : '🔓 Groups are open'}${st.source ? ` <span class="muted small">(${esc(st.source)})</span>` : ''}</div>
          <div class="muted small">
            ${st.enabled ? 'Scheduled lockdown ON' : 'Scheduled lockdown off'}
            ${st.nextLockAt ? ` · next lock ${new Date(st.nextLockAt).toLocaleString()}` : ''}
            ${st.nextUnlockAt ? ` · unlock ${new Date(st.nextUnlockAt).toLocaleString()}` : ''}
          </div>
          ${renderLockRun(st.run, paceSecs)}
          ${!st.run && st.lastRun?.error ? `<div class="muted small" style="margin-top:8px">last ${esc(st.lastRun.action)} failed: ${esc(st.lastRun.error)}</div>` : ''}
        </div>
      </div>`;
    if (!statusOnly) {
      $('f-lock-enabled').checked = !!CONFIG?.lockdown?.enabled;
      $('f-lock-tz').value = CONFIG?.lockdown?.timezone ?? '';
      LOCK_WINDOWS = (CONFIG?.lockdown?.windows ?? []).map(normalizeWindow);
      renderLockWindows();
      renderAlwaysLocked();
    }
    // Keep refreshing while a paced run is still walking the groups.
    clearTimeout(lockPollTimer);
    if (st.run) lockPollTimer = setTimeout(() => loadLockdown({ statusOnly: true }), 3000);
  } catch (err) { box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`; }
}

function renderAlwaysLocked() {
  const box = $('always-locked');
  if (!box) return;
  const set = new Set(CONFIG?.lockdown?.alwaysLocked ?? []);
  if (!GROUPS.length) { box.innerHTML = '<div class="empty">No groups loaded.</div>'; return; }
  box.innerHTML = GROUPS.map((g) => `
    <label class="check"><input type="checkbox" class="al-g" value="${esc(g.jid)}" ${set.has(g.jid) ? 'checked' : ''}>
      <span>${esc(g.subject)} <span class="muted small">(${g.size})</span></span></label>`).join('');
}

// A refused run is flagged as a warning, not a success - nothing was queued,
// so the admin has to ask again once the run in flight has finished.
const lockRunToast = (r, verb) => (r?.started
  ? toast(`${verb} groups one at a time, ${lockPaceSeconds(r)}s apart — this runs in the background`)
  : toast('A lockdown run is already in progress — try again once it has finished', true));

$('lock-now')?.addEventListener('click', async () => {
  if (!confirm('Lock ALL groups now? Only admins will be able to post until you unlock.\n\n'
    + 'Groups are locked one at a time with a pause between each so WhatsApp is not flooded, '
    + 'so this takes a few minutes to work through them all.')) return;
  // statusOnly: pressing the button is not a request to discard settings edits.
  try { lockRunToast(await api('POST', '/lockdown/lock'), 'Locking'); loadLockdown({ statusOnly: true }); }
  catch (err) { toast(err.message, true); }
});
$('unlock-now')?.addEventListener('click', async () => {
  try { lockRunToast(await api('POST', '/lockdown/unlock'), 'Unlocking'); loadLockdown({ statusOnly: true }); }
  catch (err) { toast(err.message, true); }
});
$('lock-save')?.addEventListener('click', async () => {
  $('lock-save-note').textContent = 'saving…';
  try {
    CONFIG = await api('PUT', '/config', { lockdown: collectLockdown() });
    $('lock-save-note').innerHTML = '<span style="color:var(--accent)">saved</span>';
    loadLockdown();
  } catch (err) { $('lock-save-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});

function renderMxGroups() {
  const box = $('mx-groups');
  if (!box) return;
  if (!GROUPS.length) { box.innerHTML = '<div class="empty">No groups loaded.</div>'; return; }
  box.innerHTML = GROUPS.map((g) => `
    <label class="check"><input type="checkbox" class="mx-g" value="${esc(g.jid)}">
      <span>${esc(g.subject)} <span class="muted small">(${g.size})</span></span></label>`).join('');
}
function mxSelected() { return [...document.querySelectorAll('.mx-g:checked')].map((i) => i.value); }
$('mx-all')?.addEventListener('click', () => document.querySelectorAll('.mx-g').forEach((i) => (i.checked = true)));
$('mx-none')?.addEventListener('click', () => document.querySelectorAll('.mx-g').forEach((i) => (i.checked = false)));

async function mxAcross(action, verb) {
  const number = $('mx-num').value.replace(/[^0-9]/g, '');
  const groupJids = mxSelected();
  if (!number) return toast('Enter a number', true);
  if (!groupJids.length) return toast('Select at least one group', true);
  if ((action === 'demote') && !confirm(`Remove admin from +${number} on ${groupJids.length} group(s)?`)) return;
  $('mx-note').textContent = `${verb}…`;
  try {
    const r = await api('POST', '/members/across', { number, groupJids, action });
    const okc = r.results.filter((x) => !x.error).length;
    $('mx-note').innerHTML = `<span style="color:var(--accent)">${verb} done on ${okc}/${r.results.length} group(s)</span>` +
      r.results.filter((x) => x.error).map((x) => `<br><span class="muted">${esc(x.subject)}: ${esc(x.error)}</span>`).join('');
  } catch (err) { $('mx-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
}
$('mx-add')?.addEventListener('click', () => mxAcross('add', 'Adding'));
$('mx-promote')?.addEventListener('click', () => mxAcross('promote', 'Promoting'));
$('mx-demote')?.addEventListener('click', () => mxAcross('demote', 'Demoting'));

$('mx-banall')?.addEventListener('click', async () => {
  const number = $('mx-num').value.replace(/[^0-9]/g, '');
  if (!number) return toast('Enter a number', true);
  if (!confirm(`BAN +${number} from ALL groups and add to the banned list? This removes them everywhere.`)) return;
  $('mx-note').textContent = 'banning from all groups…';
  try {
    const r = await api('POST', '/members/ban-all', { number });
    const w = r.wiped || {};
    $('mx-note').innerHTML = `<span style="color:var(--accent)">removed from ${r.results.length} group(s) and added to the banned list</span>` +
      (w.deleted ? `<br><span class="muted small">🧹 deleted ${w.deleted} recent message(s)${w.failed ? ` — ${w.failed} were too old or the bot isn't admin there` : ''}</span>` : '');
    loadBanned();
  } catch (err) { $('mx-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});

async function loadBanned() {
  const box = $('banned-list');
  if (!box) return;
  try {
    const list = await api('GET', '/banned');
    $('banned-count').textContent = list.length;
    box.innerHTML = list.length ? list.map((n) => `
      <div class="item compact">
        <div class="item-top">
          <span class="item-title">+${esc(n)}</span>
          <button class="btn tiny" onclick="unban('${esc(n)}')">Remove from list</button>
        </div>
      </div>`).join('') : '<div class="empty">No banned numbers.</div>';
  } catch { /* ignore */ }
}
window.unban = async (n) => { await api('DELETE', `/banned/${encodeURIComponent(n)}`); toast(`+${n} removed from banned list`); loadBanned(); };
$('ban-add')?.addEventListener('click', async () => {
  const n = $('ban-add-num').value.replace(/[^0-9]/g, '');
  if (!n) return;
  // banning locally only (no group removal) — just add to the list
  try {
    const cur = await api('GET', '/banned');
    if (!cur.includes(n)) { CONFIG = await api('PUT', '/config', { bannedNumbers: [...cur, n] }); }
    $('ban-add-num').value = ''; loadBanned();
  } catch (err) { toast(err.message, true); }
});

/* --------------------------- accounts / audit ---------------------- */
function applyUser() {
  const u = CURRENT_USER;
  $('who').textContent = u ? `${u.username}${u.role === 'superadmin' ? ' · super-admin' : ''}` : '';
  const isSuper = u?.role === 'superadmin';
  document.querySelectorAll('.superadmin-only').forEach((el) => el.classList.toggle('hidden', !isSuper));
}

async function loadAdmins() {
  const box = $('admins-list');
  if (!box) return;
  try {
    const r = await api('GET', '/admins');
    box.innerHTML = r.admins.map((a) => `
      <div class="item compact">
        <div class="item-top">
          <span class="item-title">${esc(a.username)} ${a.role === 'superadmin' ? '<span class="tag done">super-admin</span>' : '<span class="tag">admin</span>'}</span>
          ${CURRENT_USER?.role === 'superadmin' ? `
            <span class="row gap">
              <button class="btn tiny" onclick="adminReset('${esc(a.username)}')">Reset password</button>
              ${a.username !== CURRENT_USER.username ? `<button class="btn tiny danger" onclick="adminRemove('${esc(a.username)}')">Remove</button>` : ''}
            </span>` : ''}
        </div>
        <div class="item-sub">${a.lastLogin ? 'last login ' + new Date(a.lastLogin).toLocaleString() : 'never signed in'}</div>
      </div>`).join('');
  } catch { /* non-super admins can still see their own via /admins */ }
}

$('na-add')?.addEventListener('click', async () => {
  const username = $('na-user').value.trim(), password = $('na-pass').value, role = $('na-role').value;
  $('na-note').textContent = 'adding…';
  try {
    await api('POST', '/admins', { username, password, role });
    $('na-user').value = ''; $('na-pass').value = '';
    $('na-note').innerHTML = '<span style="color:var(--accent)">added</span>';
    loadAdmins();
  } catch (err) { $('na-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});
window.adminRemove = async (u) => {
  if (!confirm(`Remove admin "${u}"? They will no longer be able to sign in.`)) return;
  try { await api('DELETE', `/admins/${encodeURIComponent(u)}`); toast(`Removed ${u}`); loadAdmins(); }
  catch (err) { toast(err.message, true); }
};
window.adminReset = async (u) => {
  const pw = prompt(`New password for "${u}" (8+ chars):`);
  if (!pw) return;
  try { await api('POST', `/admins/${encodeURIComponent(u)}/reset`, { password: pw }); toast(`Password reset for ${u}`); }
  catch (err) { toast(err.message, true); }
};

async function loadAudit() {
  const box = $('audit-list');
  if (!box) return;
  try {
    const evs = await api('GET', '/audit');
    if (!evs.length) { box.innerHTML = '<div class="empty">No actions recorded yet.</div>'; return; }
    box.innerHTML = evs.map((e) => `
      <div class="item compact">
        <div class="item-top">
          <span class="item-title">${esc(e.user)} <span class="muted">${e.role === 'superadmin' ? '(super)' : ''}</span></span>
          <span class="muted small">${new Date(e.ts).toLocaleString()}</span>
        </div>
        <div class="item-sub">${esc(e.action)}${e.detail && e.detail !== e.action ? ` · ${esc(e.detail)}` : ''}</div>
      </div>`).join('');
  } catch (err) { box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`; }
}
$('btn-audit-refresh')?.addEventListener('click', loadAudit);
$('btn-audit-clear')?.addEventListener('click', async () => {
  await api('DELETE', '/audit'); loadAudit(); toast('Audit log cleared');
});

/* --------------------------- groups admin -------------------------- */
let gaCurrent = null;   // jid of the group being edited

function renderGroupsList() {
  const box = $('ga-list');
  if (!GROUPS.length) { box.innerHTML = '<div class="empty">No groups loaded. Connect WhatsApp, then Refresh.</div>'; return; }
  box.innerHTML = GROUPS.map((g) => `
    <div class="item">
      <div class="item-top">
        <span class="item-title">${esc(g.subject)} <span class="muted small">(${g.size})</span></span>
        <button class="btn small" onclick="gaOpen('${esc(g.jid)}','${esc(g.subject)}')">Manage</button>
      </div>
      <div class="gjid">${esc(g.jid)}</div>
    </div>`).join('');
}

window.gaOpen = async (jid, name) => {
  gaCurrent = jid;
  $('ga-detail').classList.remove('hidden');
  $('ga-name').textContent = name;
  $('ga-subject').value = name;
  $('ga-desc').value = ''; $('ga-members').innerHTML = '<div class="empty">Loading…</div>';
  $('ga-desc-note').textContent = ''; $('ga-add-note').textContent = '';
  $('ga-subject-note').textContent = '';
  $('ga-detail').scrollIntoView({ behavior: 'smooth' });
  try {
    const d = await api('GET', `/groups/${encodeURIComponent(jid)}/details`);
    $('ga-desc').value = d.desc || '';
    $('ga-count').textContent = d.members.length;
    $('ga-adminwarn').innerHTML = d.botIsAdmin
      ? '<span style="color:var(--accent)">✓ the bot is an admin here — edits and member actions will work</span>'
      : '<span style="color:var(--warn)">⚠ the bot is NOT an admin here — description/member changes will be rejected by WhatsApp</span>';
    renderMembers(d.members);
  } catch (err) {
    $('ga-members').innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`;
  }
};

function renderMembers(members) {
  window._gaMembers = members;
  const q = $('ga-member-filter').value.toLowerCase();
  const shown = members.filter((m) => !q || (m.number || '').includes(q) || (m.id || '').toLowerCase().includes(q));
  const box = $('ga-members');
  // Is the group being managed the announcements group? If so, offer a
  // per-member tag mute so specific people opt out of being @-pinged.
  const announceJid = CONFIG?.announce?.group ?? '';
  const isAnnounceGroup = gaCurrent && gaCurrent === announceJid;
  const muted = new Set((CONFIG?.announce?.noTag ?? []).map((x) => String(x).replace(/[^0-9]/g, '')));

  box.innerHTML = shown.map((m) => {
    const label = m.number ? `+${m.number}` : `<span class="muted">${esc(m.id)}</span>`;
    const badge = m.admin === 'superadmin' ? '<span class="tag done">owner</span>'
                : m.admin === 'admin' ? '<span class="tag done">admin</span>' : '';
    const who = m.number || m.id;
    const isMuted = m.number && muted.has(m.number);
    const tagBtn = (isAnnounceGroup && m.number)
      ? (isMuted
          ? `<button class="btn tiny" onclick="gaTag('${esc(m.number)}',false)">🔔 Tag again</button>`
          : `<button class="btn tiny warn" onclick="gaTag('${esc(m.number)}',true)">🔕 Don't tag</button>`)
      : '';
    return `
      <div class="item">
        <div class="item-top">
          <span class="item-title">${label} ${badge} ${isMuted ? '<span class="tag">not tagged</span>' : ''}</span>
        </div>
        <div class="row gap wrap" style="margin-top:8px">
          ${tagBtn}
          ${m.admin
            ? `<button class="btn tiny" onclick="gaAct('demote','${esc(who)}')">Remove admin</button>`
            : `<button class="btn tiny" onclick="gaAct('promote','${esc(who)}')">Make admin</button>`}
          <button class="btn tiny danger" onclick="gaAct('remove','${esc(who)}')">Remove from group</button>
        </div>
      </div>`;
  }).join('') || '<div class="empty">No members match.</div>';
}

window.gaTag = async (number, muted) => {
  try {
    const r = await api('POST', '/notify/no-tag', { number, muted });
    // keep the local config in sync so the toggle reflects immediately
    if (CONFIG?.announce) CONFIG.announce.noTag = r.noTag;
    if ($('f-ann-notag')) $('f-ann-notag').value = (r.noTag ?? []).join('\n');
    toast(muted ? `+${number} will no longer be tagged` : `+${number} will be tagged again`);
    renderMembers(window._gaMembers || []);
  } catch (err) { toast(err.message, true); }
};

window.gaAct = async (action, who) => {
  const verb = { remove:'remove', promote:'make admin', demote:'remove admin from' }[action];
  if ((action === 'remove' || action === 'demote') &&
      !confirm(`Really ${verb} ${who}? This affects a real person in the group.`)) return;
  try {
    const r = await api('POST', `/groups/${encodeURIComponent(gaCurrent)}/participants`, { action, numbers: [who] });
    const st = r.results?.[0]?.status;
    toast(st && st !== '200' ? `WhatsApp said: ${st}` : `Done: ${verb} ${who}`);
    gaOpen(gaCurrent, $('ga-name').textContent);   // reload
  } catch (err) { toast(err.message, true); }
};

$('ga-close').addEventListener('click', () => { $('ga-detail').classList.add('hidden'); gaCurrent = null; });
$('ga-member-filter').addEventListener('input', () => renderMembers(window._gaMembers || []));

$('ga-subject-save').addEventListener('click', async () => {
  const subject = $('ga-subject').value.trim();
  if (!subject) { $('ga-subject-note').innerHTML = '<span style="color:var(--danger)">a group must have a name</span>'; return; }
  $('ga-subject-note').textContent = 'renaming…';
  try {
    await api('PUT', `/groups/${encodeURIComponent(gaCurrent)}/subject`, { subject });
    $('ga-subject-note').innerHTML = '<span style="color:var(--accent)">renamed</span>';
    $('ga-name').textContent = subject;
    // Keep the cached list (and every picker built from it) in step.
    const g = GROUPS.find((x) => x.jid === gaCurrent);
    if (g) { g.subject = subject; renderGroups(); }
    toast('Group renamed');
  } catch (err) {
    $('ga-subject-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
});

$('ga-desc-save').addEventListener('click', async () => {
  $('ga-desc-note').textContent = 'saving…';
  try {
    await api('PUT', `/groups/${encodeURIComponent(gaCurrent)}/description`, { description: $('ga-desc').value });
    $('ga-desc-note').innerHTML = '<span style="color:var(--accent)">saved</span>';
    toast('Description updated');
  } catch (err) {
    $('ga-desc-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
});

$('ga-add-btn').addEventListener('click', async () => {
  const num = $('ga-add-num').value.replace(/[^0-9]/g, '');
  if (!num) return;
  $('ga-add-note').textContent = 'adding…';
  try {
    const r = await api('POST', `/groups/${encodeURIComponent(gaCurrent)}/participants`, { action: 'add', numbers: [num] });
    const st = r.results?.[0]?.status;
    $('ga-add-note').innerHTML = st && st !== '200'
      ? `<span style="color:var(--warn)">WhatsApp returned ${esc(st)} (they may need to be invited, or privacy settings block it)</span>`
      : '<span style="color:var(--accent)">added</span>';
    $('ga-add-num').value = '';
    if (!st || st === '200') gaOpen(gaCurrent, $('ga-name').textContent);
  } catch (err) {
    $('ga-add-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
  }
});

async function loadGroupActivity() {
  const box = $('ga-activity');
  if (!box) return;
  try {
    const evs = await api('GET', '/group-activity');
    if (!evs.length) { box.innerHTML = '<div class="empty">No activity recorded yet.</div>'; return; }
    const verb = { add:'joined/added', remove:'left/removed', promote:'promoted to admin', demote:'demoted', 'join-request':'requested to join' };
    box.innerHTML = evs.map((e) => {
      const tgt = (e.targets || []).map((t) => t.number ? `+${t.number}` : t.jid).filter(Boolean).join(', ');
      const by = e.actorNumber ? ` · by +${e.actorNumber}` : '';
      return `
        <div class="item compact">
          <div class="item-top">
            <span class="item-title">${esc(verb[e.action] || e.action)}: ${esc(tgt || '?')}</span>
            <span class="muted small">${new Date(e.ts).toLocaleString()}</span>
          </div>
          <div class="item-sub">${esc(e.groupName)}${by}</div>
        </div>`;
    }).join('');
  } catch (err) { box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`; }
}

$('btn-ga-refresh').addEventListener('click', async () => {
  try { GROUPS = unwrapGroups(await api('GET', '/wa/groups?refresh=1')); } catch {}
  renderGroupsList();
});
$('btn-ga-activity-refresh').addEventListener('click', loadGroupActivity);
$('btn-ga-activity-clear').addEventListener('click', async () => {
  await api('DELETE', '/group-activity'); loadGroupActivity(); toast('Activity cleared');
});

/* ------------------------------ SSE -------------------------------- */
let eventSource = null;
function connectEvents() {
  // Re-entering the app after a re-login must not leave the previous stream
  // open, or every update arrives twice.
  if (eventSource) { try { eventSource.close(); } catch {} }
  const es = new EventSource('/events');
  eventSource = es;
  es.addEventListener('status', (e) => renderStatus(JSON.parse(e.data)));
  es.addEventListener('queue', (e) => renderQueue(JSON.parse(e.data)));
  es.addEventListener('groups', (e) => { GROUPS = unwrapGroups(JSON.parse(e.data)); renderGroups(); });
  es.addEventListener('groupevent', () => loadGroupActivity());
  es.addEventListener('log', (e) => {
    logLines.push(JSON.parse(e.data));
    if (logLines.length > 600) logLines.shift();
    renderLog();
  });
  es.onerror = () => { /* EventSource retries on its own */ };
}

/* ----------------------------- helpers ----------------------------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDur(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

boot().catch((err) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#f0553c">Failed to start: ${esc(err.message)}</pre>`;
});

/* ----------------------- members roster (all groups) ---------------- */
let ROSTER = [];
let ROSTER_SHOWN = 100;

const fmtWhen = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days === 0) return `today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString();
};

const memberLabel = (m) =>
  m.name || (m.number ? `+${m.number}` : (m.id || '').split('@')[0]);

async function loadMembersRoster() {
  const box = $('mr-list');
  if (!box) return;
  try {
    const d = await api('GET', '/members');
    ROSTER = d.members || [];
    $('mr-count').textContent = ROSTER.length;
    renderRoster();
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

function renderRoster() {
  const box = $('mr-list');
  if (!box) return;
  const q = ($('mr-filter').value || '').toLowerCase().trim();
  const sort = $('mr-sort').value;

  let list = ROSTER.filter((m) => !q
    || memberLabel(m).toLowerCase().includes(q)
    || (m.number || '').includes(q)
    || (m.id || '').toLowerCase().includes(q)
    || m.groups.some((g) => g.subject.toLowerCase().includes(q)));

  const cmp = {
    active: (a, b) => b.msgCount - a.msgCount || b.groupCount - a.groupCount,
    groups: (a, b) => b.groupCount - a.groupCount || b.msgCount - a.msgCount,
    admin: (a, b) => b.adminCount - a.adminCount || b.groupCount - a.groupCount,
    recent: (a, b) => (b.lastSeen || 0) - (a.lastSeen || 0),
    name: (a, b) => memberLabel(a).localeCompare(memberLabel(b)),
  }[sort] || ((a, b) => b.msgCount - a.msgCount);
  list = [...list].sort(cmp);

  const shown = list.slice(0, ROSTER_SHOWN);
  box.innerHTML = shown.length ? shown.map((m) => `
    <div class="item compact member-row" onclick="openMember('${esc(m.key)}')" style="cursor:pointer">
      <div class="item-top">
        <span class="item-title">${esc(memberLabel(m))}${m.adminCount ? ` <span class="pill ok">admin ×${m.adminCount}</span>` : ''}</span>
        <span class="muted small">${m.msgCount} msg${m.msgCount === 1 ? '' : 's'}</span>
      </div>
      <div class="item-sub">
        ${m.groupCount} group${m.groupCount === 1 ? '' : 's'}
        ${m.number ? ` · +${esc(m.number)}` : ' · no phone number visible'}
        ${m.lastSeen ? ` · last seen ${esc(fmtWhen(m.lastSeen))}` : ''}
      </div>
    </div>`).join('') : '<div class="empty">Nobody matches that search.</div>';

  $('mr-more').innerHTML = list.length > ROSTER_SHOWN
    ? `<button class="btn small" onclick="moreRoster()">Show ${Math.min(100, list.length - ROSTER_SHOWN)} more (${list.length - ROSTER_SHOWN} hidden)</button>`
    : '';
}

window.moreRoster = () => { ROSTER_SHOWN += 100; renderRoster(); };

window.openMember = async (key) => {
  const box = $('mr-detail');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="empty">Loading…</div>';
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const d = await api('GET', `/members/${encodeURIComponent(key)}/detail`);
    const admin = d.groups.filter((g) => g.admin);
    const plain = d.groups.filter((g) => !g.admin);
    const per = d.perGroup || {};

    const groupLine = (g) => {
      const a = per[g.jid];
      return `<div class="item-sub">• ${esc(g.subject)}${g.admin ? ` <span class="pill ok">${esc(g.admin)}</span>` : ''}${a ? ` <span class="muted">— ${a.count} msg${a.count === 1 ? '' : 's'}, last ${esc(fmtWhen(a.lastSeen))}</span>` : ''}</div>`;
    };

    const timeline = (d.timeline || []).length
      ? d.timeline.map((t) => `<div class="item-sub">${esc(new Date(t.ts).toLocaleString())} — <b>${esc(t.action)}</b> in ${esc(t.groupName)}${t.by ? ` <span class="muted">by ${esc(t.by)}</span>` : ''}</div>`).join('')
      : '<div class="item-sub muted">No join/leave events recorded — they were already in these groups before the bot started watching. WhatsApp doesn\'t expose historical join dates.</div>';

    box.innerHTML = `
      <div class="card" style="margin-bottom:14px;border:1px solid var(--accent)">
        <div class="row gap" style="justify-content:space-between;align-items:flex-start">
          <div>
            <h3 style="margin:0">${esc(memberLabel(d))}</h3>
            <div class="muted small">${d.number ? `+${esc(d.number)}` : 'no phone number visible (LID-only)'}${d.banned ? ' · <span class="pill bad">banned</span>' : ''}${d.noTag ? ' · <span class="pill warn">never tagged</span>' : ''}</div>
          </div>
          <button class="btn tiny" onclick="closeMember()">✕ close</button>
        </div>

        <div class="row gap wrap" style="margin:12px 0">
          <span class="pill">${d.groupCount} group${d.groupCount === 1 ? '' : 's'}</span>
          <span class="pill ${d.adminCount ? 'ok' : ''}">${d.adminCount} admin role${d.adminCount === 1 ? '' : 's'}</span>
          <span class="pill">${d.msgCount} message${d.msgCount === 1 ? '' : 's'}</span>
          <span class="pill">first seen ${esc(fmtWhen(d.firstSeen))}</span>
          <span class="pill">last seen ${esc(fmtWhen(d.lastSeen))}</span>
        </div>

        ${admin.length ? `<h4 style="margin:10px 0 4px">Admin in ${admin.length} group${admin.length === 1 ? '' : 's'}</h4>${admin.map(groupLine).join('')}` : ''}
        <h4 style="margin:12px 0 4px">Member of ${plain.length} other group${plain.length === 1 ? '' : 's'}</h4>
        ${plain.map(groupLine).join('') || '<div class="item-sub muted">none</div>'}

        <h4 style="margin:14px 0 4px">How they joined / left</h4>
        ${timeline}

        <div class="row gap wrap" style="margin-top:14px">
          <button class="btn tiny" onclick="useMemberNumber('${esc(d.number || '')}')">Use this number below ↓</button>
        </div>
      </div>`;
  } catch (err) {
    box.innerHTML = `<div class="verdict bad">${esc(err.message)}</div>`;
  }
};

window.closeMember = () => { $('mr-detail').classList.add('hidden'); $('mr-detail').innerHTML = ''; };
window.useMemberNumber = (n) => {
  if (!n) return toast('This person has no visible phone number — WhatsApp only exposes their internal id.', true);
  $('mx-num').value = n;
  $('mx-num').scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast(`+${n} filled in below`);
};

$('mr-filter')?.addEventListener('input', () => { ROSTER_SHOWN = 100; renderRoster(); });
$('mr-sort')?.addEventListener('change', renderRoster);
$('mr-refresh')?.addEventListener('click', loadMembersRoster);

/* --------------------------- auto-moderation ------------------------ */
/* The fields themselves are filled by fillModeration() and collected by
   collectModeration(), so this card and the Settings tab never disagree. */
$('mod-save')?.addEventListener('click', async () => {
  $('mod-note').textContent = 'saving…';
  try {
    CONFIG = await api('PUT', '/config', { moderation: collectModeration() });
    $('mod-note').innerHTML = '<span style="color:var(--accent)">saved</span>';
    toast('Moderation settings saved');
  } catch (err) { $('mod-note').innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; }
});

/* ================= portal navigation: search, jump-nav, collapse =========
   The index is built from the live DOM rather than a hand-kept list, so it
   can never drift out of sync as cards and settings are added. */

const TAB_LABEL = () => Object.fromEntries(
  [...document.querySelectorAll('.tab')].map((t) => [t.dataset.tab, t.textContent.trim()]));

function buildSearchIndex() {
  const labels = TAB_LABEL();
  const idx = [];

  document.querySelectorAll('.panel').forEach((panel) => {
    const tab = panel.id.replace(/^tab-/, '');
    if (panel.classList.contains('superadmin-only') && panel.classList.contains('hidden')) return;

    panel.querySelectorAll('.card').forEach((card) => {
      const h2 = card.querySelector('h2');
      const section = h2 ? h2.textContent.replace(/\s+/g, ' ').trim() : '';
      if (section) idx.push({ kind: 'section', what: section, tab, tabLabel: labels[tab], card });

      // Sub-headings inside a card.
      card.querySelectorAll('h3').forEach((h3) => {
        const t = h3.textContent.replace(/\s+/g, ' ').trim();
        if (t) idx.push({ kind: 'section', what: t, sub: section, tab, tabLabel: labels[tab], card, el: h3 });
      });

      // Every labelled field becomes searchable.
      card.querySelectorAll('label').forEach((lab) => {
        const field = lab.querySelector('input, select, textarea');
        const text = [...lab.childNodes]
          .filter((n) => n.nodeType === 3 || (n.nodeType === 1 && !['INPUT', 'SELECT', 'TEXTAREA'].includes(n.tagName)))
          .map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
        if (text && text.length < 90) {
          idx.push({ kind: 'setting', what: text, sub: section, tab, tabLabel: labels[tab], card, el: field || lab });
        }
      });

      card.querySelectorAll('button[id]').forEach((b) => {
        const t = b.textContent.replace(/\s+/g, ' ').trim();
        if (t && t.length < 40) idx.push({ kind: 'action', what: t, sub: section, tab, tabLabel: labels[tab], card, el: b });
      });
    });
  });
  return idx;
}

let SEARCH_IDX = [];
let SEARCH_SEL = 0;

function refreshSearchIndex() { SEARCH_IDX = buildSearchIndex(); }

/** Fold punctuation, emoji and case away so "auto moderation" finds "Auto-moderation 🧹". */
function normalizeSearch(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreHit(hay, query) {
  // Normalise both sides here rather than trusting every caller to do it.
  const h = normalizeSearch(hay);
  const q = normalizeSearch(query);
  if (!h || !q) return 0;
  if (h === q) return 100;
  if (h.startsWith(q)) return 80;
  if (h.includes(q)) return 60;
  // all query words present, in any order
  const words = q.split(' ').filter(Boolean);
  if (words.length > 1 && words.every((w) => h.includes(w))) return 40;
  return 0;
}

function runSearch(q) {
  const box = $('gsearch-results');
  q = (q || '').trim().toLowerCase();
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  if (!SEARCH_IDX.length) refreshSearchIndex();

  // Live data: groups and members are searchable too.
  const extra = [];
  const labels = TAB_LABEL();
  for (const g of (GROUPS || [])) {
    const sc = scoreHit(g.subject, q);
    if (sc) extra.push({ kind: 'group', what: g.subject, sub: `${g.size} members`, tab: 'groups', tabLabel: labels.groups, score: sc, jid: g.jid });
  }
  for (const m of (ROSTER || [])) {
    const name = memberLabel(m);
    const sc = Math.max(scoreHit(name, q), (m.number || '').includes(q) ? 70 : 0);
    if (sc) extra.push({ kind: 'member', what: name, sub: `${m.groupCount} groups`, tab: 'members', tabLabel: labels.members, score: sc, mkey: m.key });
  }

  const hits = [
    ...SEARCH_IDX.map((e) => ({ ...e, score: Math.max(scoreHit(e.what, q), e.sub ? scoreHit(e.sub, q) * 0.5 : 0) })),
    ...extra,
  ].filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.what.length - b.what.length)
    .slice(0, 14);

  if (!hits.length) {
    box.innerHTML = '<div class="sr-empty">Nothing matches that.</div>';
    box.classList.remove('hidden');
    return;
  }

  const icon = { section: '▤', setting: '⚙', action: '▸', group: '👥', member: '👤' };
  SEARCH_SEL = 0;
  window._searchHits = hits;
  box.innerHTML = hits.map((h, i) => `
    <div class="sr-item ${i === 0 ? 'sel' : ''}" data-i="${i}">
      <span>${icon[h.kind] || '•'}</span>
      <span class="sr-what">${esc(h.what)}${h.sub ? ` <span class="muted small">— ${esc(h.sub)}</span>` : ''}</span>
      <span class="sr-tab">${esc(h.tabLabel || h.tab)}</span>
    </div>`).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('.sr-item').forEach((el) => {
    el.addEventListener('click', () => gotoHit(hits[+el.dataset.i]));
  });
}

function gotoHit(hit) {
  if (!hit) return;
  $('gsearch-results').classList.add('hidden');
  $('gsearch').value = '';
  goTab(hit.tab);

  setTimeout(() => {
    if (hit.kind === 'group' && hit.jid) { gaOpen(hit.jid, hit.what); return; }
    if (hit.kind === 'member' && hit.mkey) { openMember(hit.mkey); return; }
    const card = hit.card;
    if (card) {
      card.classList.remove('collapsed');
      saveCollapse(card, false);
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
    }
    if (hit.el) {
      hit.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      hit.el.classList.remove('flash-field'); void hit.el.offsetWidth; hit.el.classList.add('flash-field');
      if (typeof hit.el.focus === 'function' && hit.el.tagName !== 'BUTTON') hit.el.focus({ preventScroll: true });
    }
  }, 60);
}

$('gsearch')?.addEventListener('input', (e) => runSearch(e.target.value));
$('gsearch')?.addEventListener('keydown', (e) => {
  const hits = window._searchHits || [];
  const box = $('gsearch-results');
  if (e.key === 'Escape') { box.classList.add('hidden'); e.target.blur(); return; }
  if (!hits.length || box.classList.contains('hidden')) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    SEARCH_SEL = (SEARCH_SEL + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
    box.querySelectorAll('.sr-item').forEach((el, i) => el.classList.toggle('sel', i === SEARCH_SEL));
    box.querySelector('.sr-item.sel')?.scrollIntoView({ block: 'nearest' });
  }
  if (e.key === 'Enter') { e.preventDefault(); gotoHit(hits[SEARCH_SEL]); }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.searchwrap')) $('gsearch-results')?.classList.add('hidden');
});
// "/" focuses search, the way most tools do it.
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (e.key === '/' && !typing) { e.preventDefault(); $('gsearch')?.focus(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('gsearch')?.focus(); }
});

/* ------------------------- collapsible cards ------------------------ */
const COLLAPSE_KEY = 'botpanel.collapsed';
const collapsedSet = () => {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')); } catch { return new Set(); }
};
const cardId = (card) => {
  const panel = card.closest('.panel');
  const h2 = card.querySelector('h2');
  return `${panel ? panel.id : '?'}::${h2 ? h2.textContent.replace(/\s+/g, ' ').trim() : '?'}`;
};
function saveCollapse(card, isCollapsed) {
  const set = collapsedSet();
  const id = cardId(card);
  if (isCollapsed) set.add(id); else set.delete(id);
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
}

function setupCollapsibles() {
  const saved = collapsedSet();
  document.querySelectorAll('.card').forEach((card) => {
    const h2 = card.querySelector('h2');
    if (!h2 || h2.dataset.collapseHooked) return;
    h2.dataset.collapseHooked = '1';
    if (saved.has(cardId(card))) card.classList.add('collapsed');
    h2.addEventListener('click', (e) => {
      if (e.target.closest('a, button, input, select, .card-link')) return;
      card.classList.toggle('collapsed');
      saveCollapse(card, card.classList.contains('collapsed'));
    });
  });
}

/* --------------------------- per-tab jump nav ----------------------- */
function renderJumpNav() {
  const nav = $('jumpnav');
  if (!nav) return;
  const panel = document.querySelector('.panel.active');
  const cards = panel ? [...panel.querySelectorAll('.card')] : [];
  // Only worth showing when there is enough on the page to get lost in.
  if (cards.length < 3) { nav.innerHTML = ''; return; }
  nav.innerHTML = cards.map((c, i) => {
    const h2 = c.querySelector('h2');
    const name = h2 ? h2.textContent.replace(/\s+/g, ' ').trim() : `Section ${i + 1}`;
    return `<button data-i="${i}">${esc(name)}</button>`;
  }).join('') + '<button data-all="1">⇕ expand / collapse all</button>';

  nav.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.all) {
      const anyOpen = cards.some((c) => !c.classList.contains('collapsed'));
      cards.forEach((c) => { c.classList.toggle('collapsed', anyOpen); saveCollapse(c, anyOpen); });
      return;
    }
    const card = cards[+b.dataset.i];
    card.classList.remove('collapsed');
    saveCollapse(card, false);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
  }));
}

function initPortalNav() {
  setupCollapsibles();
  renderJumpNav();
  refreshSearchIndex();
}
$('tabs')?.addEventListener('click', () => setTimeout(() => { renderJumpNav(); setupCollapsibles(); }, 30));
