// IIIF import pipeline (design Phase 4): for each selected canvas —
//
//   download full-res JPEG → SHA-1 (WebCrypto) → Commons dup-check →
//   stash upload → normalize → prefilled draft persisted by sha1.
//
// Strictly sequential (Commons rate-limits parallel uploads; dlc.services /
// iiif.bibliotheken.nl is shared infrastructure — API-politeness rule), with
// abort honored between steps. Blobs are not retained after the upload of
// each item, so a 500-canvas run doesn't accumulate memory (OI at design
// Q14: memory hygiene is a hard requirement).
//
// The pipeline reuses the same app callbacks as the drag-drop uploader
// (dropzone.jsx): placeholders appear in the table immediately, progress
// updates flow per row, and the placeholder is replaced by the normalized
// stash item when its upload lands. Duplicates already on Commons are
// stashed anyway and flagged via the existing `exists-on-commons` issue
// (design Q10 — the user decides per file).

import { DEMO_MODE } from '../config.js';
import { fetchCSRFToken, fetchStashFileInfo, findCommonsFileBySha1 } from './commons.js';
import { uploadFile } from './upload.js';
import { normalizeStashItem, thumbColors } from './normalize.js';
import { setStashedFilename } from './local-store.js';
import { setDraft, setSharedDraft, pickDraftFields, setStashedFilename as setStashedFilenameWiki, suspendSaves, resumeSaves, flushAll } from './user-store.js';
import { withRetry, apiError } from './retry.js';

// OI-26: abort the whole batch after this many back-to-back item failures —
// a run that's failing every item (dead network, content blocker, expired
// session) shouldn't keep downloading each 12–20 MB JPEG only to fail its
// upload for the rest of a 500-page manifest.
const MAX_CONSECUTIVE_FAILURES = 5;

// OI-25: how often to flush accumulated drafts to Metadata.json mid-import.
// A single end-of-run write would mean a crash loses every draft; flushing
// every N items bounds that loss while still turning a 500-page import from
// ~500 wiki edits into ~500/N. The stashed images survive on Commons for 48 h
// regardless, and re-import is idempotent by sha1, so N is a comfort dial.
const SAVE_CHECKPOINT = 25;

async function sha1Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-1', arrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Placeholder row for a mapped canvas — mirrors dropzone's placeholderItem
// but carries the mapped prefills and the public IIIF thumbnail, so the row
// renders a real preview immediately (and keeps it after upload — stash
// thumb URLs need auth an <img> can't send, see open-issues OI-12).
function placeholderFromMapped(mapped) {
  const filename = mapped.iiif.targetFilename;
  return {
    id: `iiif-pending-${mapped.iiif.canvasIndex}-${Math.random().toString(36).slice(2, 7)}`,
    status: 'stash-selected',
    filename,
    bytes: 0,
    mime: 'image/jpeg',
    width: mapped.iiif.expectedWidth || 0,
    height: mapped.iiif.expectedHeight || 0,
    progress: 0,
    uploadedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    thumburl: mapped.iiif.thumbUrl || null,
    // Persisted via the draft (DRAFT_FIELDS) so the preview survives reloads
    // — the stash's own thumb URLs are auth-blocked for <img> tags (OI-12).
    iiifThumbUrl: mapped.iiif.thumbUrl || null,
    // Category to create at publish time (Q8) — never created at import.
    iiifPendingCategory: mapped.iiifPendingCategory || null,
    issues: [],
    ...thumbColors(filename),
    // mapped prefills (all DRAFT_FIELDS-compatible):
    title: mapped.title,
    descriptions: mapped.descriptions,
    author: mapped.author,
    source: mapped.source,
    license: mapped.license,
    institution: mapped.institution || null,
    categories: mapped.categories,
    depicts: mapped.depicts,
    // session-only extras for Phase 5 (SDC/template wiring):
    iiif: mapped.iiif,
  };
}

// runIiifImport(mappedItems, { onAddItems, onUpdateItem, onReplaceItem,
//   onItemDone, abortRef }) → summary { uploaded, duplicates, failed,
//   aborted, results: [{ mapped, state, item?, error?, existsOnCommons? }] }
//
// `abortRef` is a { current: boolean } — set true to stop after the item
// currently in flight (mid-download aborts immediately via AbortController).
export async function runIiifImport(mappedItems, {
  onAddItems,
  onUpdateItem,
  onReplaceItem,
  onItemDone,
  abortRef = { current: false },
} = {}) {
  const placeholders = mappedItems.map(placeholderFromMapped);
  onAddItems?.(placeholders);

  // OI-38: manuscript-level fields (author, source, license, categories, …)
  // are identical on every canvas — persist them ONCE as a shared record
  // instead of duplicating ~1 KB into all 500 drafts. Computed dynamically
  // (any field whose value matches across the whole batch), so future field
  // additions dedupe automatically. setDraft() strips fields that repeat the
  // shared record, so the per-canvas call below can stay dumb. The record is
  // written lazily with the first successful item — a fully failed import
  // leaves nothing behind.
  let sharedKey = null;
  let sharedFields = null;
  if (!DEMO_MODE && placeholders.length > 1) {
    const perItem = placeholders.map((p) => pickDraftFields(p));
    const candidate = {};
    for (const k of Object.keys(perItem[0])) {
      const v = JSON.stringify(perItem[0][k]);
      if (perItem.every((df) => JSON.stringify(df[k]) === v)) candidate[k] = perItem[0][k];
    }
    if (Object.keys(candidate).length > 0) {
      sharedFields = candidate;
      sharedKey = `iiif:${mappedItems[0].iiif.manifestUrl || mappedItems[0].iiif.targetFilename}`;
    }
  }
  let sharedWritten = false;

  // CSRF once for the whole batch (uploadFile ignores it in DEMO_MODE).
  let csrf = 'demo';
  if (!DEMO_MODE) {
    try {
      csrf = await fetchCSRFToken();
    } catch (e) {
      const message = e.message || 'Could not get CSRF token';
      for (const p of placeholders) {
        onUpdateItem?.(p.id, { status: 'upload-error', errorMessage: message, progress: 0 });
      }
      return { uploaded: 0, duplicates: 0, failed: mappedItems.length, aborted: false, results: mappedItems.map((mapped) => ({ mapped, state: 'error', error: message })) };
    }
  }

  const results = [];
  let uploaded = 0;
  let duplicates = 0;
  let failed = 0;
  let aborted = false;
  let consecutiveFailures = 0; // OI-26

  // OI-26: mark the not-yet-started rows when the batch aborts early, so they
  // don't sit on a stale "stash-selected" spinner. sha1 dedupe makes a re-run
  // skip whatever already reached the stash.
  const markRemaining = (fromIdx, message) => {
    for (let j = fromIdx; j < placeholders.length; j++) {
      onUpdateItem?.(placeholders[j].id, { status: 'upload-error', errorMessage: message, progress: 0 });
    }
  };

  // OI-25: suspend the user-store's debounced saves for the whole batch so the
  // per-canvas setDraft() writes coalesce (one edit per SAVE_CHECKPOINT items)
  // instead of firing the 3 s debounce in the gap between every canvas — which
  // turned a 500-page import into ~500 Metadata.json edits. resumeSaves() in
  // the finally does the final write and un-suspends, even on an early exit.
  if (!DEMO_MODE) suspendSaves();
  try {
  for (let i = 0; i < mappedItems.length; i++) {
    if (abortRef.current) {
      aborted = true;
      // Remaining placeholders stay as 'stash-selected' rows the user can
      // simply select-and-hide, or re-run the import (idempotent via sha1).
      for (let j = i; j < placeholders.length; j++) {
        onUpdateItem?.(placeholders[j].id, { status: 'upload-error', errorMessage: 'Import cancelled', progress: 0 });
      }
      break;
    }

    const mapped = mappedItems[i];
    const temp = placeholders[i];
    const controller = new AbortController();

    try {
      // 1) Download the full-res rendition (CORS is open on the KB hosts).
      //    OI-26: retry transient network/5xx failures with backoff — a blip
      //    at item 300/500 shouldn't drop the page (and the rest of the run).
      onUpdateItem?.(temp.id, { status: 'stash-uploading', progress: 5 });
      const buf = await withRetry(async () => {
        let res;
        try {
          res = await fetch(mapped.iiif.fullResUrl, { signal: controller.signal });
        } catch (e) {
          if (e.name === 'AbortError') throw e; // user cancel — don't retry
          throw apiError(`Image download failed: ${e.message}`, { isNetwork: true });
        }
        if (!res.ok) throw apiError(`Image download failed: HTTP ${res.status}`, { code: 'http', status: res.status });
        return res.arrayBuffer();
      }, {
        onRetry: (err, n, ms) => onUpdateItem?.(temp.id, { errorMessage: `Download retry ${n}/3 in ${Math.round(ms / 1000)}s — ${err.message}` }),
      });
      if (abortRef.current) throw new Error('Import cancelled');
      onUpdateItem?.(temp.id, { progress: 30, bytes: buf.byteLength });

      // 2) SHA-1 in the browser (~16 ms for 20 MB — verified spike 0.4).
      const sha1 = await sha1Hex(buf);

      // 3) Duplicate check. Q10: stash anyway, flag, let the user decide.
      let existsOnCommons = null;
      try {
        existsOnCommons = await findCommonsFileBySha1(sha1);
      } catch { /* dup-check is best-effort; silence matches dropzone */ }
      if (existsOnCommons) duplicates += 1;
      onUpdateItem?.(temp.id, { progress: 40 });

      // 4) Stash upload (single POST — files are 6–21 MB, well under the
      //    ~100 MB action=upload ceiling).
      const file = new File([buf], mapped.iiif.targetFilename, { type: 'image/jpeg' });
      // OI-26: retry transient upload failures (ratelimited/maxlag/5xx/network)
      // with backoff, and refresh the CSRF token once on `badtoken` (it rotates
      // over a multi-hour batch). Auth failures rethrow to abort the batch.
      const result = await withRetry(
        () => uploadFile(file, csrf, {
          onProgress: (p) => onUpdateItem?.(temp.id, { progress: 40 + Math.round(p * 0.6) }),
        }),
        {
          onBadToken: async () => { csrf = await fetchCSRFToken(); },
          onRetry: (err, n, ms) => onUpdateItem?.(temp.id, { errorMessage: `Upload retry ${n}/3 in ${Math.round(ms / 1000)}s — ${err.message}` }),
        },
      );

      // Persist the target filename in both caches (the stash list API
      // doesn't return original names) — same pair the dropzone writes.
      setStashedFilename(result.filekey, result.filename);
      setStashedFilenameWiki(result.filekey, result.filename);

      // 5) Normalize with full stash info; fall back to placeholder data.
      let real;
      try {
        const info = await fetchStashFileInfo(result.filekey);
        real = normalizeStashItem(
          { filekey: result.filekey, filename: result.filename, size: buf.byteLength },
          info,
        );
      } catch {
        real = { ...temp, id: result.filekey, filekey: result.filekey, filename: result.filename, status: 'stash', progress: 100, sha1 };
      }
      // Keep the public IIIF thumbnail: the stash thumb URL from the API
      // requires session auth a plain <img> can't send (OI-12), while the
      // IIIF thumb shows the same bytes and always renders.
      real = {
        ...real,
        sha1: real.sha1 || sha1,
        thumburl: mapped.iiif.thumbUrl || real.thumburl,
        iiifThumbUrl: mapped.iiif.thumbUrl || null,
        iiifPendingCategory: mapped.iiifPendingCategory || null,
        institution: mapped.institution || null,
        iiif: mapped.iiif,
        ...(existsOnCommons ? { existsOnCommons, issues: [...(real.issues || []), 'exists-on-commons'] } : {}),
      };
      onReplaceItem?.(temp.id, real);

      // 6) Persist the prefills as a normal draft keyed by sha1 (design
      //    Q11) — the same debounced Metadata.json write path as hand-typed
      //    edits, so the whole batch coalesces into few wiki edits. With a
      //    shared record (OI-38) the draft stores only per-canvas deltas
      //    (title, caption, thumb URL) — setDraft strips the rest.
      const key = real.sha1 || real.filekey;
      if (key && !DEMO_MODE) {
        if (sharedKey && !sharedWritten) {
          setSharedDraft(sharedKey, sharedFields);
          sharedWritten = true;
        }
        setDraft(key, sharedKey
          ? { ...pickDraftFields(temp), _shared: sharedKey }
          : pickDraftFields(temp));
      }

      uploaded += 1;
      consecutiveFailures = 0; // OI-26: a success breaks a failure streak
      const r = { mapped, state: 'ok', item: real, existsOnCommons };
      results.push(r);
      onItemDone?.(r, i);
    } catch (e) {
      controller.abort();
      console.error('IIIF import failed for', mapped.iiif.targetFilename, e);

      // OI-26: an auth failure (expired session / owner token) hits every
      // remaining item identically — abort the whole batch with one clear
      // message instead of hundreds of identical failures. A re-run after
      // re-login skips whatever already reached the stash (sha1 dedupe).
      if (e.kind === 'auth') {
        const msg = 'Session expired — log in and re-run. Pages already stashed are kept.';
        onUpdateItem?.(temp.id, { status: 'upload-error', errorMessage: msg, progress: 0 });
        results.push({ mapped, state: 'error', error: msg });
        failed += 1;
        onItemDone?.({ mapped, state: 'error', error: msg }, i);
        markRemaining(i + 1, msg);
        aborted = true;
        break;
      }

      const error = e.message || String(e);
      failed += 1;
      consecutiveFailures += 1;
      onUpdateItem?.(temp.id, { status: 'upload-error', errorMessage: error, progress: 0 });
      const r = { mapped, state: 'error', error };
      results.push(r);
      onItemDone?.(r, i);
      if (abortRef.current) { aborted = true; break; }
      // OI-26: give up on a run that's failing everything (dead network,
      // content blocker, quota) rather than grind through all 500 pages.
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const msg = `Import stopped after ${MAX_CONSECUTIVE_FAILURES} failures in a row — check your connection / browser extensions and re-run (stashed pages are kept).`;
        markRemaining(i + 1, msg);
        aborted = true;
        break;
      }
    }

    // OI-25 checkpoint: persist the drafts accumulated so far in one wiki edit
    // every SAVE_CHECKPOINT items, so a mid-import crash loses at most that
    // many (best-effort — the finally's resumeSaves retries whatever remains).
    if (!DEMO_MODE && (i + 1) % SAVE_CHECKPOINT === 0) {
      try { await flushAll(); } catch { /* keep importing; final flush retries */ }
    }
  }
  } finally {
    if (!DEMO_MODE) await resumeSaves();
  }

  return { uploaded, duplicates, failed, aborted, results };
}
