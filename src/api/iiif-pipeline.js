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
import { setDraft, pickDraftFields, setStashedFilename as setStashedFilenameWiki } from './user-store.js';

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
    issues: [],
    ...thumbColors(filename),
    // mapped prefills (all DRAFT_FIELDS-compatible):
    title: mapped.title,
    descriptions: mapped.descriptions,
    author: mapped.author,
    source: mapped.source,
    license: mapped.license,
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
      onUpdateItem?.(temp.id, { status: 'stash-uploading', progress: 5 });
      const res = await fetch(mapped.iiif.fullResUrl, { signal: controller.signal });
      if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
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
      const result = await uploadFile(file, csrf, {
        onProgress: (p) => onUpdateItem?.(temp.id, { progress: 40 + Math.round(p * 0.6) }),
      });

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
        iiif: mapped.iiif,
        ...(existsOnCommons ? { existsOnCommons, issues: [...(real.issues || []), 'exists-on-commons'] } : {}),
      };
      onReplaceItem?.(temp.id, real);

      // 6) Persist the prefills as a normal draft keyed by sha1 (design
      //    Q11) — the same debounced Metadata.json write path as hand-typed
      //    edits, so the whole batch coalesces into few wiki edits.
      const key = real.sha1 || real.filekey;
      if (key && !DEMO_MODE) setDraft(key, pickDraftFields(temp));

      uploaded += 1;
      const r = { mapped, state: 'ok', item: real, existsOnCommons };
      results.push(r);
      onItemDone?.(r, i);
    } catch (e) {
      controller.abort();
      console.error('IIIF import failed for', mapped.iiif.targetFilename, e);
      const error = e.message || String(e);
      failed += 1;
      onUpdateItem?.(temp.id, { status: 'upload-error', errorMessage: error, progress: 0 });
      const r = { mapped, state: 'error', error };
      results.push(r);
      onItemDone?.(r, i);
      if (abortRef.current) { aborted = true; break; }
    }
  }

  return { uploaded, duplicates, failed, aborted, results };
}
