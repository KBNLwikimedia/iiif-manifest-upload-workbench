// Cross-device persistence for the workbench.
//
// Two pages on Commons under the user's own User: subpage tree:
//
//   User:<username>/IIIFManifestUploadWorkbench/Preferences.json — global UI config
//   User:<username>/IIIFManifestUploadWorkbench/Metadata.json    — per-file drafts + filename cache
//
// Data auto-migrates from the fork's previous folder (User:<username>/
// UploadWorkbench/*.json) on first load — see loadOne + legacyTitle.
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

// OI-38: MediaWiki rejects page content over $wgMaxArticleSize (2 MiB =
// 2,097,152 bytes on Wikimedia wikis) with `contenttoobig`. Fail fast just
// under it with an actionable message instead of letting the API error be
// logged-and-swallowed — otherwise draft saves fail silently forever once
// the store is full. Margin below the hard cap is deliberate headroom.
const MAX_STORE_BYTES = 2_000_000;

const STORES = {
  preferences: {
    title: 'IIIFManifestUploadWorkbench/Preferences.json',
    legacyTitle: 'UploadWorkbench/Preferences.json', // migration source (old folder) — see loadOne
    state: { schemaVersion: 2 }, // requiredFields, columnDefaults, fieldOrder, customProps fill in on load/save
    saveTimer: null,
    saving: false,
    pendingResolve: null,
    lastSavedAt: null,
    lastError: null,
    dirty: false, // has unsaved state (OI-25: set even while saves are suspended)
  },
  metadata: {
    title: 'IIIFManifestUploadWorkbench/Metadata.json',
    legacyTitle: 'UploadWorkbench/Metadata.json',
    state: {
      schemaVersion: 2,
      filenames: {},
      drafts: {},
      // sharedDrafts (OI-38): batch-shared draft fields stored ONCE per
      // import (keyed by manifest, e.g. "iiif:<manifestUrl>") instead of
      // duplicated into every canvas's draft. A draft opts in by carrying
      // `_shared: <key>`; reads overlay the draft's own fields on top of
      // the shared record (the draft wins), and setDraft strips any written
      // field that merely equals the shared value. Keeps a 500-canvas
      // import's Metadata.json footprint ~3-4x smaller — headroom under
      // MediaWiki's 2 MB page cap ($wgMaxArticleSize). Orphaned records
      // (no draft references them anymore) are pruned on deleteDraft/load.
      sharedDrafts: {},
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
    dirty: false, // has unsaved state (OI-25: set even while saves are suspended)
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
    if (s.saveTimer || s.dirty) anyPending = true;
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
    console.info(`Migrating ${storeKey}: ${pageTitle(storeKey, true)} -> ${pageTitle(storeKey)}`);
    scheduleSave(storeKey); // writes the new page
    blankLegacyPage(storeKey).catch((e) => {
      // Non-fatal — the new page is now authoritative. We just leave the old
      // page sitting there with stale content if the blank fails.
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
  const legacy = STORES[storeKey].legacyTitle;
  // The legacy page's content model depends on its extension: a `.json`
  // page (old-folder migration) must be blanked with valid JSON, while a
  // `.js` page (the original ancient migration) takes a JS comment.
  const isJsonLegacy = /\.json$/i.test(legacy);
  const body = isJsonLegacy
    ? '{}'
    : `// Migrated to ${newName} on ${new Date().toISOString().slice(0, 10)} — this page is intentionally blank.\n` +
      `// The data now lives as proper JSON; see User:${username}/${newName}.\n`;

  const fd = new FormData();
  fd.append('action', 'edit');
  fd.append('title', pageTitle(storeKey, true));
  fd.append('text', body);
  // T425978: every Commons write self-identifies in its edit summary.
  fd.append('summary', `Migrated to ${newName}${attributionSuffix()}`);
  fd.append('token', csrf);
  fd.append('format', 'json');
  fd.append('contentmodel', isJsonLegacy ? 'json' : 'javascript');

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

  // OI-38 hygiene: drop shared draft records nothing references anymore
  // (left behind by e.g. an import that failed before persisting any draft).
  if (pruneSharedDrafts()) scheduleSave('metadata');

  return { prefs: STORES.preferences.state, metadata: STORES.metadata.state };
}

// --- Save (debounced) ---

// OI-25: while a bulk IIIF import runs, saves are suspended so the per-canvas
// setDraft() writes coalesce into a handful of wiki edits instead of ~500.
// suspendSaves() bumps this counter (ref-counted for safety); scheduleSave
// then only marks the store dirty, and resumeSaves()/flushAll() does the
// actual write. Everything is single-threaded (the pipeline awaits each
// step), so no locking beyond saveOne's own in-flight guard is needed.
let savesSuspended = 0;

export function suspendSaves() {
  savesSuspended += 1;
}

export async function resumeSaves() {
  if (savesSuspended > 0) savesSuspended -= 1;
  if (savesSuspended === 0) await flushAll();
}

function scheduleSave(storeKey) {
  if (DEMO_MODE || !username) return;
  STORES[storeKey].dirty = true;
  // OI-25: don't arm the 3 s debounce while suspended — it would fire in the
  // gap between every imported canvas. The store is marked dirty; the batch's
  // resumeSaves() (and periodic flushAll checkpoints) writes it in one edit.
  if (savesSuspended > 0) { notify(); return; }
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

    // OI-38 size guard: refuse to send a page the wiki would reject anyway.
    // The error lands in lastError → the topbar SaveStatus chip, so the user
    // learns *why* saves stopped and what to do about it.
    const text = JSON.stringify(s.state, null, 2);
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > MAX_STORE_BYTES) {
      throw new Error(
        `${pageTitle(storeKey)} is ${(bytes / 1024 / 1024).toFixed(2)} MB — over the 2 MB wiki page limit. ` +
        'Publish or discard some imported drafts to shrink it; edits keep working locally but cannot be saved until then.',
      );
    }

    const fd = new FormData();
    fd.append('action', 'edit');
    fd.append('title', pageTitle(storeKey));
    fd.append('text', text);
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
    // OI-25: cleared only on a confirmed write. A mutation arriving during the
    // fetch above re-sets dirty via scheduleSave (and pendingResolve below), so
    // it isn't lost; a failed write leaves dirty=true so a later flush retries.
    s.dirty = false;
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
    }
    // OI-25: save whenever the store has unsaved state — covers both a
    // pending debounce (timer just cleared) and a suspended batch that
    // marked the store dirty without ever arming a timer.
    if (STORES[k].dirty) await saveOne(k);
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
  'institution',
  // OI-02 (Phase 5.2): {{Artwork}} params wired from the IIIF mapper. Batch-
  // identical values are deduped into the sharedDrafts record (OI-38), so
  // 500 canvases store these once, not 500×.
  'medium',
  'dimensions',
  'accessionNumber',
  'department',
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
  // IIIF import (Q8): the per-manuscript category this row expects. The
  // category page is created at PUBLISH time (never at import time) by
  // publishOne; until then the categories-not-on-commons blocker treats
  // this one name as will-be-created instead of blocking.
  'iiifPendingCategory',
  // The umbrella category the pending category is filed under when created
  // (user-editable in the wizard; defaults to KB_PARENT_CATEGORY).
  'iiifPendingParentCategory',
];

export function pickDraftFields(item) {
  const out = {};
  for (const k of DRAFT_FIELDS) {
    if (item[k] !== undefined) out[k] = item[k];
  }
  return out;
}

// --- Shared draft records (OI-38) ---
// A bulk import persists the manuscript-level fields (author, source,
// license, categories, …) once under sharedDrafts[<key>]; each canvas draft
// stores only what differs plus `_shared: <key>`. Reads overlay draft fields
// on top of the shared record (draft wins); setDraft strips redundant
// writes, so app.jsx's full-row writeback on user edits keeps producing
// deltas without knowing about any of this.

export function setSharedDraft(sharedKey, fields) {
  if (!sharedKey || !fields) return;
  const state = STORES.metadata.state;
  state.sharedDrafts = state.sharedDrafts || {};
  if (JSON.stringify(state.sharedDrafts[sharedKey]) === JSON.stringify(fields)) return;
  state.sharedDrafts[sharedKey] = fields;
  scheduleSave('metadata');
}

// Overlay a draft's own fields onto its shared record (if any). Returns the
// draft itself when it has no shared pointer, so non-import drafts are
// untouched. Meta keys (_shared, _updated) stay on the result; strip where
// they'd leak onto items (mergeDraftsOntoItems).
function expandDraft(d) {
  if (!d || !d._shared) return d;
  const shared = STORES.metadata.state.sharedDrafts?.[d._shared];
  if (!shared) return d;
  return { ...shared, ...d };
}

// Drop shared records no draft references anymore (e.g. after publish
// deletes the batch's drafts one by one). Returns true if anything got
// pruned so callers can schedule a save.
function pruneSharedDrafts() {
  const state = STORES.metadata.state;
  if (!state.sharedDrafts) return false;
  const referenced = new Set(
    Object.values(state.drafts || {}).map((d) => d?._shared).filter(Boolean),
  );
  let pruned = false;
  for (const k of Object.keys(state.sharedDrafts)) {
    if (!referenced.has(k)) {
      delete state.sharedDrafts[k];
      pruned = true;
    }
  }
  return pruned;
}

export function getDraft(key) {
  if (!key) return null;
  const d = STORES.metadata.state.drafts?.[key];
  return d ? expandDraft(d) : null;
}

export function setDraft(key, partial) {
  if (!key || !partial) return;
  STORES.metadata.state.drafts = STORES.metadata.state.drafts || {};
  const prev = STORES.metadata.state.drafts[key] || {};
  // OI-38: fields that merely repeat the shared record are not stored — and
  // an existing delta whose value returns to the shared one is removed (so
  // the expansion doesn't shadow the shared value with a stale delta).
  const sharedKey = partial._shared || prev._shared;
  const shared = (sharedKey && STORES.metadata.state.sharedDrafts?.[sharedKey]) || null;
  // Skip the write if nothing actually changed (avoids spurious wiki edits
  // when a user just clicks-without-changing).
  const next = { ...prev };
  let changed = false;
  for (const k of Object.keys(partial)) {
    const redundant = shared && k in shared
      && JSON.stringify(shared[k]) === JSON.stringify(partial[k]);
    if (redundant) {
      if (k in next) {
        delete next[k];
        changed = true;
      }
    } else if (JSON.stringify(next[k]) !== JSON.stringify(partial[k])) {
      next[k] = partial[k];
      changed = true;
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
    pruneSharedDrafts(); // OI-38: drop the batch record with its last draft
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
  pruneSharedDrafts(); // OI-38: dst's _shared may have been overwritten by src's
  scheduleSave('metadata');
}

// Apply drafts onto an array of items. Draft fields override item fields
// (the user's saved edits trump whatever the API returned). Drafts with a
// `_shared` pointer are expanded from their batch record first (OI-38).
export function mergeDraftsOntoItems(items) {
  const drafts = STORES.metadata.state.drafts || {};
  return items.map((item) => {
    const key = draftKey(item);
    if (!key) return item;
    const d = drafts[key];
    if (!d) return item;
    const overlay = { ...expandDraft(d) };
    delete overlay._updated;
    delete overlay._shared;
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

// --- Recent manifests ---
// A small user-activity list (the last N manifest URLs the user loaded)
// persisted in Preferences.json so it follows them across devices — same
// debounced write path as any other pref. Newest first, deduped by URL,
// capped. Only reloadable (URL-loaded) manifests belong here; a dropped
// file has no reusable URL. This is user-authored activity, not derived
// data — safe to persist (unlike manifest JSON, which we recompute).
// The recent-manifest list has no *visible* limit (the old 10-entry cap was
// lifted 2026-07-12) — users keep their full import history. A soft cap of 200
// keeps the Preferences.json write bounded (each entry is small: url +
// signature + title + thumb) so a heavy user can't balloon the user-store page.
const RECENT_MANIFESTS_SOFT_CAP = 200;

export function getRecentManifests() {
  const arr = STORES.preferences.state.recentManifests;
  return Array.isArray(arr) ? arr.filter((r) => r && r.url) : [];
}

export function addRecentManifest({ url, signature, title, thumb, dupNames, dupImages } = {}) {
  const u = String(url || '').trim();
  if (!u) return;
  const all = getRecentManifests();
  // Carry forward any GitHub issues already recorded against this manifest —
  // re-loading a manifest must not wipe its "reported" links (OI-85 needs-work).
  const existing = all.find((r) => r.url === u);
  const prev = all.filter((r) => r.url !== u);
  const entry = {
    url: u,
    signature: String(signature || '').trim() || null,
    title: String(title || '').trim() || null,
    // First-canvas thumbnail URL (purpose-built /full/400,/ size) for the list.
    thumb: String(thumb || '').trim() || null,
    // OI-85 "needs work" flag: affected-image counts for the two within-manifest
    // collision classes (0/absent = clean). Persisted so the recent list can
    // flag erroneous manifests without re-parsing.
    dupNames: Number(dupNames) || 0,
    dupImages: Number(dupImages) || 0,
    // Recorded GitHub issues reporting this manifest's problems: [{number,url}].
    issues: Array.isArray(existing?.issues) ? existing.issues : [],
  };
  const next = [entry, ...prev].slice(0, RECENT_MANIFESTS_SOFT_CAP);
  setPref('recentManifests', next);
}

// Record a GitHub issue (that reports this manifest's duplicates) against the
// recent-manifest entry, so its number shows in the "Needs work" tab. Deduped
// by issue number. Returns the updated issues array (or [] if url unknown).
export function recordManifestIssue(url, { number, url: issueUrl } = {}) {
  const u = String(url || '').trim();
  const num = Number(number) || null;
  if (!u || !num) return [];
  const all = getRecentManifests();
  const idx = all.findIndex((r) => r.url === u);
  if (idx < 0) return [];
  const entry = all[idx];
  const issues = Array.isArray(entry.issues) ? entry.issues.slice() : [];
  if (!issues.some((i) => i.number === num)) {
    issues.push({ number: num, url: String(issueUrl || '').trim() || `https://github.com/KBNLwikimedia/iiif-manifest-upload-workbench/issues/${num}` });
  }
  const next = all.slice();
  next[idx] = { ...entry, issues };
  setPref('recentManifests', next);
  return issues;
}

export function removeRecentManifest(url) {
  const u = String(url || '').trim();
  if (!u) return;
  setPref('recentManifests', getRecentManifests().filter((r) => r.url !== u));
}

export function clearRecentManifests() {
  setPref('recentManifests', []);
}
