// Cross-device persistence for the workbench.
//
// Two pages on Commons (both gitignored from the user's view of the wiki by
// being under their own User: subpage tree):
//
//   User:<username>/UploadWorkbench/Preferences.js  — global UI config
//   User:<username>/UploadWorkbench/Metadata.js     — per-file drafts + filename cache
//
// Both files contain a single JSON object as their entire body (the .js
// extension exists so the editmycssjs grant covers writes; MediaWiki doesn't
// execute the page unless the user manually adds it to their common.js).
//
// Reads happen once on bootstrap. Writes are debounced 3s — every keystroke
// in the table doesn't hit the wiki, but a 3-second pause does.
//
// localStorage stays as a fast-path cache (boot time). On first load we
// migrate any local-only filename cache entries into the user-store so they
// roam to the user's other devices.

import { COMMONS_API, DEMO_MODE, attributionSuffix } from '../config.js';
import { fetchWithAuth } from '../utils.js';
import { getAccessToken } from './oauth.js';
import { fetchCSRFToken } from './commons.js';
import {
  getAllStashedFilenames as getLocalFilenames,
  setStashedFilename as setLocalFilename,
} from './local-store.js';

let username = null;

const SAVE_DEBOUNCE_MS = 3000;

const STORES = {
  preferences: {
    title: 'UploadWorkbench/Preferences.json',
    legacyTitle: 'UploadWorkbench/Preferences.js', // migration source — see loadOne
    state: { schemaVersion: 2 }, // requiredFields, columnDefaults, fieldOrder, customProps fill in on load/save
    saveTimer: null,
    saving: false,
    pendingResolve: null,
    lastSavedAt: null,
    lastError: null,
  },
  metadata: {
    title: 'UploadWorkbench/Metadata.json',
    legacyTitle: 'UploadWorkbench/Metadata.js',
    state: {
      schemaVersion: 2,
      filenames: {},
      drafts: {},
      // Soft-delete state. Two lists during the migration window:
      //   hiddenSha1s   — canonical. Sha1 is content-defined and stable
      //                   across stash regeneration / re-upload, so soft-
      //                   deletes by sha1 survive when MediaWiki re-issues
      //                   a filekey for the same bytes.
      //   hiddenFilekeys — legacy. Used as a fallback for items whose sha1
      //                   isn't yet known (info backfill pending) and to
      //                   preserve any pre-migration state. Migrated to
      //                   hiddenSha1s on bootstrap when sha1 becomes known.
      hiddenSha1s: [],
      hiddenFilekeys: [],
      // history: cached published-file metadata (Phase B).
      //   items[] — rich extmetadata for the latest N uploads (default 50).
      //   Older re-uploads are caught by the per-stash findCommonsFileBySha1
      //   effect in app.jsx, not by a persisted index.
      history: { lastSyncedAt: null, items: [] },
      // groups: ordered list of manual photo groupings (T425839 / T425840).
      //   Each group is { id, sha1s[], filekeys[], seq, name?, order? }.
      //   - sha1s/filekeys: membership. Sha1 is preferred (content-
      //     permanent across re-uploads); filekey is the fallback for
      //     in-flight uploads or items whose sha1 isn't known yet.
      //   - seq: monotonically increasing creation-order number — never
      //     changes for a group, even when dragged to reorder. Drives the
      //     default label ("Group 3") so labels stay stable across drags.
      //   - name: optional user-supplied label that overrides the default
      //     "Group {seq}". Absent / empty means "use Group {seq}". When
      //     missing the renderer falls back to a sequential label computed
      //     from the visible groups so the count never leaves gaps when
      //     groups are deleted/reordered.
      //   - order: optional display order list of identifiers (sha1 or
      //     filekey). Used by the visual piling mode and the table view
      //     to render group members in a deterministic, user-controlled
      //     order. Items not yet in `order` fall to the end (forward-
      //     compat with groups created before this field existed).
      //   A photo can appear in at most one group; everything else is
      //   implicitly "Ungrouped". Shared between the table-view groups
      //   feature (T425839) and the visual piling mode (T425840) — both
      //   read/write the same shape.
      groups: [],
    },
    saveTimer: null,
    saving: false,
    pendingResolve: null,
    lastSavedAt: null,
    lastError: null,
  },
};

// --- Observable status (for the topbar indicator) ---
//
// React subscribes via useSyncExternalStore. The snapshot reference is only
// rebuilt inside notify() so identical states return the same object (which
// useSyncExternalStore demands to avoid infinite re-renders).

const listeners = new Set();

function computeStatus() {
  let anyPending = false;
  let anySaving = false;
  let lastError = null;
  let lastSavedAt = null;
  for (const k of Object.keys(STORES)) {
    const s = STORES[k];
    if (s.saveTimer) anyPending = true;
    if (s.saving) anySaving = true;
    if (s.lastError) lastError = s.lastError;
    if (s.lastSavedAt && (!lastSavedAt || s.lastSavedAt > lastSavedAt)) lastSavedAt = s.lastSavedAt;
  }
  let state;
  if (anySaving) state = 'saving';
  else if (anyPending) state = 'pending';
  else if (lastError) state = 'error';
  else state = lastSavedAt ? 'saved' : 'idle';
  return { state, pending: anyPending, saving: anySaving, lastError, lastSavedAt };
}

let snapshot = computeStatus();

function notify() {
  snapshot = computeStatus();
  for (const fn of listeners) fn();
}

export function subscribeStoreStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getStoreStatus() {
  return snapshot;
}

function pageTitle(storeKey, useLegacy = false) {
  const t = useLegacy ? STORES[storeKey].legacyTitle : STORES[storeKey].title;
  return `User:${username}/${t}`;
}

// --- Load ---
//
// Loading is two-step to support the .js -> .json migration:
//   1. Try the .json page first (the new home).
//   2. If missing, try the .js page (the legacy home). If found, parse it,
//      remember to migrate (write to .json + blank .js) at the end of load.
//
// The migration write happens via the normal scheduleSave path so it goes
// through our retry logic and observable status. Blanking the legacy page
// is a separate edit with contentmodel=javascript so MediaWiki accepts a
// comment-only body.

async function fetchPageContent(title) {
  const params = new URLSearchParams({
    action: 'query',
    titles: title,
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
    format: 'json',
    formatversion: '2',
  });
  const data = await fetchWithAuth(`${COMMONS_API}?${params}`, { noCache: true });
  const page = data.query?.pages?.[0];
  if (!page || page.missing) return null;
  return page.revisions?.[0]?.slots?.main?.content || null;
}

async function loadOne(storeKey) {
  if (DEMO_MODE) return;
  const token = await getAccessToken();
  if (!token) return;

  let content = null;
  let migrated = false;

  // Step 1: try the canonical .json page.
  try {
    content = await fetchPageContent(pageTitle(storeKey));
  } catch (e) {
    console.warn(`Load ${storeKey} (.json) failed:`, e.message);
  }

  // Step 2: fall back to the legacy .js page.
  if (content == null) {
    try {
      content = await fetchPageContent(pageTitle(storeKey, true));
      if (content != null) migrated = true; // schedule a write to .json + blank the .js
    } catch (e) {
      console.warn(`Load ${storeKey} (.js legacy) failed:`, e.message);
    }
  }

  if (content == null) return; // both missing — empty state

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    console.warn(`Could not parse ${storeKey} page (${pageTitle(storeKey)}):`, e.message);
    return;
  }
  // One-shot migration: legacy metadata pages may carry a derived sha1Index
  // array (~700 KB for heavy uploaders). Drop it on load and queue a save so
  // the wiki page shrinks on next debounce.
  let needsMigrationSave = false;
  if (storeKey === 'metadata' && parsed.history && Array.isArray(parsed.history.sha1Index)) {
    delete parsed.history.sha1Index;
    needsMigrationSave = true;
  }
  STORES[storeKey].state = { ...STORES[storeKey].state, ...parsed };
  if (needsMigrationSave) scheduleSave('metadata');

  if (migrated) {
    console.info(`Migrating ${storeKey}: .js -> .json`);
    scheduleSave(storeKey); // writes the .json
    blankLegacyPage(storeKey).catch((e) => {
      // Non-fatal — the .json is now authoritative. We just leave the .js page
      // sitting there with stale content if the blank fails.
      console.warn(`Could not blank legacy ${pageTitle(storeKey, true)}:`, e.message);
    });
  }
}

async function blankLegacyPage(storeKey) {
  if (DEMO_MODE || !username) return;
  const token = await getAccessToken();
  if (!token) return;
  const csrf = await fetchCSRFToken();
  if (!csrf) return;

  const newName = STORES[storeKey].title;
  const body =
    `// Migrated to ${newName} on ${new Date().toISOString().slice(0, 10)} — this page is intentionally blank.\n` +
    `// The Upload Workbench now stores its data as proper JSON; see User:${username}/${newName}.\n`;

  const fd = new FormData();
  fd.append('action', 'edit');
  fd.append('title', pageTitle(storeKey, true));
  fd.append('text', body);
  // T425978: every Commons write self-identifies in its edit summary.
  fd.append('summary', `Migrated to ${newName}${attributionSuffix()}`);
  fd.append('token', csrf);
  fd.append('format', 'json');
  fd.append('contentmodel', 'javascript');

  const url = `${COMMONS_API}?crossorigin=`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  const result = await response.json();
  if (result.error) throw new Error(`${result.error.code}: ${result.error.info}`);
}

export async function loadStores(user) {
  username = user;
  if (DEMO_MODE) return { prefs: STORES.preferences.state, metadata: STORES.metadata.state };

  const results = await Promise.allSettled([loadOne('preferences'), loadOne('metadata')]);
  for (const [i, r] of results.entries()) {
    if (r.status === 'rejected') {
      const k = ['preferences', 'metadata'][i];
      console.warn(`Could not load ${k}:`, r.reason?.message || r.reason);
    }
  }

  // Migrate any localStorage-only filename cache into the user-store on
  // first load so the next device sees them too. Existing user-store entries
  // win — local cache is treated as a write-buffer, not authoritative.
  const localFilenames = getLocalFilenames();
  let migrated = 0;
  STORES.metadata.state.filenames = STORES.metadata.state.filenames || {};
  for (const [key, name] of Object.entries(localFilenames)) {
    if (!STORES.metadata.state.filenames[key]) {
      STORES.metadata.state.filenames[key] = name;
      migrated++;
    }
  }
  if (migrated > 0) scheduleSave('metadata');

  return { prefs: STORES.preferences.state, metadata: STORES.metadata.state };
}

// --- Save (debounced) ---

function scheduleSave(storeKey) {
  if (DEMO_MODE || !username) return;
  clearTimeout(STORES[storeKey].saveTimer);
  STORES[storeKey].saveTimer = setTimeout(() => saveOne(storeKey), SAVE_DEBOUNCE_MS);
  notify();
}

async function saveOne(storeKey) {
  const s = STORES[storeKey];
  if (DEMO_MODE || !username) return;

  // The timer fired (or flushAll cleared it). Either way, the pending state
  // is no longer "queued for later" — it's "executing now" or already cleared.
  s.saveTimer = null;

  // Avoid concurrent writes to the same page (one in-flight at a time).
  if (s.saving) {
    s.pendingResolve = true; // mark that another save is needed when current finishes
    return;
  }
  s.saving = true;
  notify();

  try {
    const token = await getAccessToken();
    if (!token) throw new Error('Not authenticated');
    const csrf = await fetchCSRFToken();
    if (!csrf) throw new Error('Could not get CSRF token');

    const fd = new FormData();
    fd.append('action', 'edit');
    fd.append('title', pageTitle(storeKey));
    fd.append('text', JSON.stringify(s.state, null, 2));
    // T425978: every Commons write self-identifies in its edit summary.
    fd.append('summary', `Update ${storeKey}${attributionSuffix()}`);
    fd.append('token', csrf);
    fd.append('format', 'json');
    fd.append('contentmodel', 'json'); // .json title implies it, but be explicit

    const url = `${COMMONS_API}?crossorigin=`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    const result = await response.json();
    if (result.error) {
      throw new Error(`${result.error.code}: ${result.error.info}`);
    }
    s.lastError = null;
    s.lastSavedAt = Date.now();
  } catch (e) {
    s.lastError = e.message || String(e);
    console.warn(`Save ${storeKey} failed:`, s.lastError);
  } finally {
    s.saving = false;
    if (s.pendingResolve) {
      s.pendingResolve = false;
      scheduleSave(storeKey); // a write came in mid-save; flush again soon
    } else {
      notify();
    }
  }
}

export async function flushAll() {
  for (const k of Object.keys(STORES)) {
    if (STORES[k].saveTimer) {
      clearTimeout(STORES[k].saveTimer);
      STORES[k].saveTimer = null;
      await saveOne(k);
    }
  }
}

// --- Filenames ---

export function getStashedFilename(filekey) {
  if (!filekey) return null;
  return STORES.metadata.state.filenames?.[filekey] || null;
}

export function setStashedFilename(filekey, filename) {
  if (!filekey || !filename) return;
  STORES.metadata.state.filenames = STORES.metadata.state.filenames || {};
  if (STORES.metadata.state.filenames[filekey] === filename) return;
  STORES.metadata.state.filenames[filekey] = filename;
  setLocalFilename(filekey, filename); // also write-through localStorage so a refresh before the wiki save still sees it
  scheduleSave('metadata');
}

// --- Drafts ---
// Editable fields the user has filled in for a stash file. Keyed by sha1
// when available (stable across re-uploads of identical bytes), otherwise
// by filekey.

export function draftKey(item) {
  return item?.sha1 || item?.filekey || item?.id || null;
}

const DRAFT_FIELDS = [
  'title',
  // `description` is the legacy single-string caption (English by
  // convention); `descriptions` is the per-language map that backs the
  // multi-language Caption columns (T426422). Both persist so older
  // drafts (pre-T426422) round-trip cleanly while new edits via
  // setCaptionValue keep both fields in sync.
  'description',
  'descriptions',
  'license',
  'author',
  'source',
  'categories',
  'depicts',
  'dateTaken',
  'cameraLocation',
  'objectLocation',
  'locationOfCreation',
  // T426421: user-typed values for custom columns (both wikitext-template
  // and Wikidata-property kinds). The map is keyed by pid → string. Lives
  // here so values survive a reload like every other editable cell.
  'customProps',
  // IIIF import (OI-12/OI-03): the manifest's public thumbnail URL for this
  // page. Stash thumb URLs need session auth an <img> can't send, so this
  // is the only preview that renders for stash rows; one short URL per
  // draft, gone when the draft is cleaned up after publish.
  'iiifThumbUrl',
];

export function pickDraftFields(item) {
  const out = {};
  for (const k of DRAFT_FIELDS) {
    if (item[k] !== undefined) out[k] = item[k];
  }
  return out;
}

export function getDraft(key) {
  if (!key) return null;
  return STORES.metadata.state.drafts?.[key] || null;
}

export function setDraft(key, partial) {
  if (!key || !partial) return;
  STORES.metadata.state.drafts = STORES.metadata.state.drafts || {};
  const prev = STORES.metadata.state.drafts[key] || {};
  // Skip the write if nothing actually changed (avoids spurious wiki edits
  // when a user just clicks-without-changing).
  const next = { ...prev, ...partial };
  let changed = false;
  for (const k of Object.keys(partial)) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(partial[k])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  next._updated = new Date().toISOString();
  STORES.metadata.state.drafts[key] = next;
  scheduleSave('metadata');
}

export function deleteDraft(key) {
  if (!key) return;
  if (STORES.metadata.state.drafts?.[key]) {
    delete STORES.metadata.state.drafts[key];
    scheduleSave('metadata');
  }
}

// Move a draft from one key to another. Used when a placeholder upload row
// finalizes and gets a real sha1/filekey: any edits the user made on the
// transient `pending-…` row need to follow the row to its permanent key so
// they survive a reload. Per the codebase rule (and CLAUDE.md), the canonical
// key is sha1 — fall back to filekey only when sha1 isn't yet known.
//
// If the destination already has a draft (rare — e.g. user dropped an
// identical file in a prior session), the source's fields win for any keys
// they define; other destination fields are preserved. No-op if there's no
// source draft to move.
export function rekeyDraft(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const drafts = STORES.metadata.state.drafts;
  if (!drafts) return;
  const src = drafts[fromKey];
  if (!src) return;
  const dst = drafts[toKey] || {};
  const merged = { ...dst, ...src };
  merged._updated = new Date().toISOString();
  drafts[toKey] = merged;
  delete drafts[fromKey];
  scheduleSave('metadata');
}

// Apply drafts onto an array of items. Draft fields override item fields
// (the user's saved edits trump whatever the API returned).
export function mergeDraftsOntoItems(items) {
  const drafts = STORES.metadata.state.drafts || {};
  return items.map((item) => {
    const key = draftKey(item);
    if (!key) return item;
    const d = drafts[key];
    if (!d) return item;
    const overlay = { ...d };
    delete overlay._updated;
    return { ...item, ...overlay };
  });
}

// --- Hidden state ("soft delete") ---
//
// Files the user has dismissed from the workbench view. The Commons stash
// has no per-file delete API; hidden files stay in the real stash until
// they auto-expire (~48h). This list rides on the same Metadata.json page
// so it roams across devices.
//
// State is keyed by sha1 (content hash). Sha1 is content-defined, so a
// re-upload of the same bytes — or a stash entry whose filekey MediaWiki
// has re-issued — stays soft-deleted across reloads. hiddenFilekeys is a
// legacy fallback used only while a row's sha1 is not yet known.
//
// Pruning: hiddenSha1s is intentionally NOT pruned on bootstrap. Soft-
// delete is content-permanent — a re-upload of the same bytes inherits
// the deletion. hiddenFilekeys IS pruned (entries gone from the current
// stash get dropped), since it's transitional anyway.

export function getHiddenSha1s() {
  return new Set(STORES.metadata.state.hiddenSha1s || []);
}

export function getHiddenFilekeys() {
  return new Set(STORES.metadata.state.hiddenFilekeys || []);
}

export function hideSha1(sha1) {
  if (!sha1) return;
  STORES.metadata.state.hiddenSha1s = STORES.metadata.state.hiddenSha1s || [];
  if (STORES.metadata.state.hiddenSha1s.includes(sha1)) return;
  STORES.metadata.state.hiddenSha1s.push(sha1);
  scheduleSave('metadata');
}

export function hideSha1s(sha1s) {
  if (!sha1s?.length) return;
  STORES.metadata.state.hiddenSha1s = STORES.metadata.state.hiddenSha1s || [];
  let added = 0;
  for (const s of sha1s) {
    if (s && !STORES.metadata.state.hiddenSha1s.includes(s)) {
      STORES.metadata.state.hiddenSha1s.push(s);
      added++;
    }
  }
  if (added > 0) scheduleSave('metadata');
}

export function unhideSha1(sha1) {
  if (!sha1) return;
  const arr = STORES.metadata.state.hiddenSha1s;
  if (!arr?.length) return;
  const before = arr.length;
  STORES.metadata.state.hiddenSha1s = arr.filter((s) => s !== sha1);
  if (STORES.metadata.state.hiddenSha1s.length !== before) scheduleSave('metadata');
}

export function unhideAllSha1s() {
  const sha1Empty = !STORES.metadata.state.hiddenSha1s?.length;
  const filekeyEmpty = !STORES.metadata.state.hiddenFilekeys?.length;
  if (sha1Empty && filekeyEmpty) return;
  STORES.metadata.state.hiddenSha1s = [];
  STORES.metadata.state.hiddenFilekeys = [];
  scheduleSave('metadata');
}

// Legacy filekey-based functions. Kept for fallback when an item's sha1
// isn't yet known (info backfill pending). New code paths should prefer
// hideSha1 / unhideSha1; these only stay around so we can hide rows that
// don't have a sha1 yet without losing the user's intent.

export function hideFilekey(filekey) {
  if (!filekey) return;
  STORES.metadata.state.hiddenFilekeys = STORES.metadata.state.hiddenFilekeys || [];
  if (STORES.metadata.state.hiddenFilekeys.includes(filekey)) return;
  STORES.metadata.state.hiddenFilekeys.push(filekey);
  scheduleSave('metadata');
}

export function hideFilekeys(filekeys) {
  if (!filekeys?.length) return;
  STORES.metadata.state.hiddenFilekeys = STORES.metadata.state.hiddenFilekeys || [];
  let added = 0;
  for (const k of filekeys) {
    if (k && !STORES.metadata.state.hiddenFilekeys.includes(k)) {
      STORES.metadata.state.hiddenFilekeys.push(k);
      added++;
    }
  }
  if (added > 0) scheduleSave('metadata');
}

export function unhideFilekey(filekey) {
  if (!filekey) return;
  const arr = STORES.metadata.state.hiddenFilekeys;
  if (!arr?.length) return;
  const before = arr.length;
  STORES.metadata.state.hiddenFilekeys = arr.filter((k) => k !== filekey);
  if (STORES.metadata.state.hiddenFilekeys.length !== before) scheduleSave('metadata');
}

// Drop legacy hidden filekey entries that are no longer in the current
// stash. hiddenSha1s is NOT pruned — sha1 hides are content-permanent.
export function pruneHiddenFilekeys(currentFilekeys) {
  const arr = STORES.metadata.state.hiddenFilekeys;
  if (!arr?.length) return;
  const live = new Set(currentFilekeys || []);
  const next = arr.filter((k) => live.has(k));
  if (next.length !== arr.length) {
    STORES.metadata.state.hiddenFilekeys = next;
    scheduleSave('metadata');
  }
}

// Migrate legacy hiddenFilekeys → hiddenSha1s where sha1 is now known.
// Called once per bootstrap, after the stash fetch has completed and the
// caller can build a {filekey -> sha1} map for current rows. Migrated
// filekeys are removed from hiddenFilekeys; un-migratable entries (no
// sha1 known) are left alone for the next bootstrap.
//
// Returns the number of entries migrated, for logging.
export function migrateLegacyHiddenFilekeys(stashFilekeyToSha1) {
  const arr = STORES.metadata.state.hiddenFilekeys;
  if (!arr?.length || !stashFilekeyToSha1) return 0;
  const sha1Set = new Set(STORES.metadata.state.hiddenSha1s || []);
  const remaining = [];
  let migrated = 0;
  for (const filekey of arr) {
    const sha1 = stashFilekeyToSha1.get(filekey);
    if (sha1) {
      if (!sha1Set.has(sha1)) {
        sha1Set.add(sha1);
        migrated++;
      }
    } else {
      remaining.push(filekey);
    }
  }
  if (migrated > 0 || remaining.length !== arr.length) {
    STORES.metadata.state.hiddenSha1s = [...sha1Set];
    STORES.metadata.state.hiddenFilekeys = remaining;
    scheduleSave('metadata');
  }
  return migrated;
}

// --- Cached published-history (Phase B) ---
//
// Lives under metadata.history = { lastSyncedAt, items }. The cache is
// authoritative for first paint; a background refresh updates it when the
// last sync is older than the threshold (Bootstrap decides when).

const HISTORY_AUTO_REFRESH_DAYS = 7;
// Bumped whenever the shape of cached history items changes in a way that
// requires a fresh fetch (not just a render-time sanitization). When a stored
// blob's schemaVersion is older than this constant, shouldAutoRefreshHistory()
// returns true regardless of lastSyncedAt — the stale cache won't make the
// user wait a week to see the new fields.
//   v0/undefined → pre-T425885 (depicts always empty due to claims/statements
//                  shape bug; no SDC caption; no P170/P275/P1259/P9149 reads).
//   v1           → T425885 follow-up: SDC keys, captions, qid label resolution.
const HISTORY_SCHEMA_VERSION = 1;

export function getCachedHistory() {
  const h = STORES.metadata.state.history || {};
  const rawItems = Array.isArray(h.items) ? h.items : [];
  // T425885: pre-fix cached items may contain `description: "[object Object]"`
  // (multilingual extmetadata leaked through). Sanitize on read so the table
  // shows "—" instead until the next background refresh repopulates the cache
  // with the real text. We don't write back here — the in-memory normalization
  // is enough; a fresh fetch heals the wiki page on its own schedule.
  const items = rawItems.map((it) =>
    it && typeof it === 'object' && it.description === '[object Object]'
      ? { ...it, description: '' }
      : it
  );
  return {
    items,
    lastSyncedAt: h.lastSyncedAt || null,
  };
}

export function setCachedHistory(items, lastSyncedAt = new Date().toISOString()) {
  STORES.metadata.state.history = {
    lastSyncedAt,
    schemaVersion: HISTORY_SCHEMA_VERSION,
    items: Array.isArray(items) ? items : [],
  };
  scheduleSave('metadata');
}

// Patch a single cached item (used by per-row Refresh).
export function updateCachedHistoryItem(updated) {
  const h = STORES.metadata.state.history || { items: [] };
  const items = Array.isArray(h.items) ? h.items : [];
  const idx = items.findIndex((i) => i.filename === updated.filename);
  if (idx >= 0) items[idx] = updated;
  else items.unshift(updated);
  STORES.metadata.state.history = {
    lastSyncedAt: h.lastSyncedAt || null, // a single-row refresh shouldn't reset the global timestamp
    schemaVersion: h.schemaVersion || HISTORY_SCHEMA_VERSION,
    items,
  };
  scheduleSave('metadata');
}

export function shouldAutoRefreshHistory() {
  const h = STORES.metadata.state.history || {};
  if (!h.lastSyncedAt) return true; // never synced
  // Stale schema → force a refresh so the user sees the new fields without
  // waiting up to HISTORY_AUTO_REFRESH_DAYS for the time-based path.
  if ((h.schemaVersion || 0) < HISTORY_SCHEMA_VERSION) return true;
  const ageMs = Date.now() - new Date(h.lastSyncedAt).getTime();
  return ageMs > HISTORY_AUTO_REFRESH_DAYS * 24 * 60 * 60 * 1000;
}

// Map<sha1, filename> for synchronous duplicate labelling on stash rows.
// Built from the rich items window only (latest N uploads). Re-uploads of
// files older than that window aren't in this map; the per-stash
// findCommonsFileBySha1 effect in app.jsx covers them with a ~1s async
// lookup against allimages.
export function getPublishedSha1Map() {
  const h = STORES.metadata.state.history || {};
  const map = new Map();
  for (const item of h.items || []) {
    if (item.sha1) map.set(item.sha1, item.filename);
  }
  return map;
}

// --- Manual photo groups (T425839 / T425840) ---
//
// Users can manually group rows together for batch editing. Groups are
// ordered (drag-reorderable) and individually labellable; a photo lives in
// at most one group; everything else is implicit "Ungrouped". Each group
// entry is:
//   { id: 'g_xxxxx', sha1s: [...], filekeys: [...], seq: <int>,
//     name?: <str>, order?: ['<sha1-or-filekey>', ...] }
// - sha1s/filekeys: membership. Sha1 is the canonical key (content-
//   permanent across re-uploads); filekey is the fallback for items
//   whose sha1 isn't yet known. A row matches a group if EITHER its
//   sha1 is in sha1s OR its filekey is in filekeys.
// - seq: stable creation-order number. The default label is
//   `Group {seq}` and never shifts when the user drags groups around.
// - name: optional. When present and non-empty, overrides the default
//   `Group {seq}` label. When missing/empty, callers render the
//   default sequential label.
// - order: optional. Display-order list of identifiers (sha1 or
//   filekey). Items not present fall to the end. Used by the visual
//   piling mode and the table view so the user's manual reordering
//   round-trips across both surfaces.
//
// Mirrored API across T425839 (table view) and T425840 (visual piling
// mode) so both features speak to the same persisted list.

export function getGroups() {
  const raw = Array.isArray(STORES.metadata.state.groups) ? STORES.metadata.state.groups : [];
  // One-shot back-fill: legacy groups created before the seq/name fields
  // existed. We assign sequential seqs based on their array position so
  // existing labels read as Group 1, Group 2, ... at first paint.
  let needBackfill = false;
  for (const g of raw) {
    if (typeof g.seq !== 'number') { needBackfill = true; break; }
  }
  if (!needBackfill) return raw;
  let nextSeq = 1;
  for (const g of raw) if (typeof g.seq === 'number') nextSeq = Math.max(nextSeq, g.seq + 1);
  return raw.map((g) => (typeof g.seq === 'number' ? g : { ...g, seq: nextSeq++ }));
}

export function setGroups(groups) {
  const next = Array.isArray(groups) ? groups : [];
  if (JSON.stringify(STORES.metadata.state.groups) === JSON.stringify(next)) return;
  STORES.metadata.state.groups = next;
  scheduleSave('metadata');
}

// --- Preferences ---

export function getPref(key) {
  return STORES.preferences.state[key];
}

export function setPref(key, value) {
  if (key === 'schemaVersion') return; // immutable
  if (JSON.stringify(STORES.preferences.state[key]) === JSON.stringify(value)) return;
  STORES.preferences.state[key] = value;
  scheduleSave('preferences');
}

export function getAllPrefs() {
  return STORES.preferences.state;
}
