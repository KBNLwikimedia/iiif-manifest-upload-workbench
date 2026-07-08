// Window-wide drag-drop + file picker.
//
// Listens on `window` so files dropped anywhere on the app land in the stash.
// Mounts a hidden <input type="file" multiple> that the topbar Upload button
// triggers via the `uw:open-picker` custom event (loose coupling — no ref
// threading needed).
//
// On drop / select, ALL files immediately appear in the stash as placeholder
// rows (one render pass) — `status="stash-selected"` for files queued, then
// `status="stash-uploading"` once the serial uploader reaches each one. The
// XHR upload progress drives a per-card progress bar; on completion, the
// optimistic placeholder is replaced with the fully-normalized stash item
// while preserving any user-edited fields (title/description/categories/…)
// the user typed during the upload (T425873).
//
// The serial loop stays — Commons rate-limits parallel uploads and stash
// thumbnails generated server-side benefit from one-at-a-time. Only the
// rendering of "queued" placeholders is moved upfront.

import React from 'react';
import { fetchCSRFToken, fetchStashFileInfo, findCommonsFileBySha1 } from '../api/commons.js';
import { uploadFile, sanitizeFilename } from '../api/upload.js';
import { normalizeStashItem, thumbColors } from '../api/normalize.js';
import { setStashedFilename } from '../api/user-store.js';

const Icon = window.Icon;

// Build a placeholder row for a freshly-dropped file. Pre-fills what's known
// without any network or file read: filename, byte size, mime type. EXIF and
// dimensions are filled in once the upload finishes (server-side stashinfo).
//
// We deliberately don't run a client-side EXIF parse here — the server already
// extracts EXIF from the stashed file, and dragging in a 100MB JPEG should
// stay cheap on the main thread. (See T425873 — "locally-readable EXIF if
// cheap" — we're treating "cheap" as "no extra dependency".)
function placeholderItem(file) {
  const filename = sanitizeFilename(file.name);
  const colors = thumbColors(filename);
  return {
    id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    status: 'stash-selected',
    filename,
    // Pre-fill so the row isn't blank in the brief window between optimistic
    // insertion and the post-upload normalize. Mirrors normalizeStashItem.
    title: filename ? filename.replace(/\.[^.]+$/, '') : '',
    bytes: file.size,
    mime: file.type || 'application/octet-stream',
    width: 0,
    height: 0,
    progress: 0,
    uploadedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    author: '',
    license: '',
    categories: [],
    depicts: [],
    issues: [],
    ...colors,
  };
}

// Race the API call against an 8s timeout so a slow Commons doesn't keep
// the duplicate banner pending forever.
async function lookupExistingOnCommons(sha1) {
  if (!sha1) return null;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 8000));
  try {
    return await Promise.race([findCommonsFileBySha1(sha1), timeout]);
  } catch (e) {
    console.warn('Commons duplicate check failed:', e);
    return null;
  }
}

export function DropZone({ onAddItems, onUpdateItem, onReplaceItem, onManifestFile }) {
  const inputRef = React.useRef();
  const [overlay, setOverlay] = React.useState(false);
  const dragDepthRef = React.useRef(0); // counter so nested children don't toggle off

  // Drop / pick handler. The whole batch is rendered as placeholder rows in
  // a single setState pass before any network call, so the table reflects the
  // user's intent within the same frame. The serial uploader then walks the
  // batch one file at a time (Commons rate-limits parallel uploads, and stash
  // thumbnails generated server-side benefit from one-at-a-time).
  const enqueue = React.useCallback(async (files) => {
    // 0) Route dropped IIIF manifest JSON files to the import wizard instead
    //    of stashing them as media. The wizard validates that they are
    //    genuine Presentation 3.0 manifests (and reports if not). A .json
    //    almost never belongs in the media stash, so pulling it out here is
    //    safe; any additional JSONs beyond the first are ignored (one
    //    manifest per wizard run).
    if (onManifestFile) {
      const manifests = files.filter((f) => /\.json$/i.test(f.name) || f.type === 'application/json');
      if (manifests.length) {
        onManifestFile(manifests[0]);
        files = files.filter((f) => !manifests.includes(f));
        if (!files.length) return;
      }
    }

    // 1) Build placeholder rows for every dropped file and prepend them all
    //    in one shot. This is the "10 rows appear immediately" guarantee from
    //    T425873 — no awaiting the CSRF round-trip first.
    const placeholders = files.map(placeholderItem);
    onAddItems(placeholders);

    // 2) Fetch CSRF. If that fails, the whole batch can't proceed: mark every
    //    placeholder as upload-error so the user sees the failure on each row
    //    rather than just one synthetic one.
    let csrf;
    try {
      csrf = await fetchCSRFToken();
    } catch (e) {
      console.error('Failed to fetch CSRF token:', e);
      const message = e.message || 'Could not get CSRF token';
      for (const p of placeholders) {
        onUpdateItem(p.id, { status: 'upload-error', errorMessage: message, progress: 0 });
      }
      return;
    }

    // 3) Walk the batch serially. Each placeholder is already in state — the
    //    only thing the loop adds is the per-row progress + final replace.
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const temp = placeholders[i];

      // Flip status from "selected" (queued) to "uploading" the moment its
      // turn comes. Other rows in the batch keep their queued look until we
      // get to them, which gives the user honest feedback about the queue.
      onUpdateItem(temp.id, { status: 'stash-uploading', progress: 0 });

      try {
        const result = await uploadFile(file, csrf, {
          onProgress: (p) => onUpdateItem(temp.id, { progress: p }),
        });

        // Persist the original filename — the stash list API doesn't return it,
        // so without this we'd see the random filekey on next page load.
        setStashedFilename(result.filekey, result.filename);

        // Fetch full info so EXIF, sha1, real thumb URL, dimensions land in the item.
        let real;
        try {
          const info = await fetchStashFileInfo(result.filekey);
          real = normalizeStashItem(
            { filekey: result.filekey, filename: result.filename, size: file.size },
            info,
          );
        } catch {
          // If the follow-up info fetch fails, keep the placeholder data + filekey.
          real = {
            ...temp,
            id: result.filekey,
            filekey: result.filekey,
            filename: result.filename,
            status: 'stash',
            progress: 100,
          };
        }
        // Replace the placeholder with the real item. App-level handler is
        // responsible for merging any user edits made on the placeholder
        // (title/description/categories/…) onto `real` and re-keying the
        // saved draft from the placeholder id to the new sha1 (T425873).
        onReplaceItem(temp.id, real);

        // Fire-and-forget: ask Commons whether this exact SHA-1 already exists
        // on the project (uploaded by anyone). Result lands as a banner / chip
        // via existsOnCommons; silent on failure.
        if (real.sha1) {
          lookupExistingOnCommons(real.sha1).then((hit) => {
            if (!hit) return;
            onUpdateItem(real.id, {
              existsOnCommons: hit,
              issues: [...(real.issues || []), 'exists-on-commons'],
            });
          });
        }
      } catch (e) {
        console.error('Upload failed for', file.name, e);
        onUpdateItem(temp.id, { status: 'upload-error', errorMessage: e.message, progress: 0 });
      }
    }
  }, [onAddItems, onUpdateItem, onReplaceItem, onManifestFile]);

  React.useEffect(() => {
    const isFiles = (e) => e.dataTransfer?.types?.includes?.('Files');

    const onDragEnter = (e) => {
      if (!isFiles(e)) return;
      dragDepthRef.current += 1;
      setOverlay(true);
    };
    const onDragOver = (e) => {
      // Required: without preventDefault on dragover, drop never fires.
      if (isFiles(e)) e.preventDefault();
    };
    const onDragLeave = (e) => {
      if (!isFiles(e)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setOverlay(false);
    };
    const onDrop = (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setOverlay(false);
      const files = [...e.dataTransfer.files];
      if (files.length) enqueue(files);
    };
    const onPickerEvent = () => inputRef.current?.click();
    const onWindowBlur = () => {
      dragDepthRef.current = 0;
      setOverlay(false);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('uw:open-picker', onPickerEvent);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('uw:open-picker', onPickerEvent);
    };
  }, [enqueue]);

  const onInputChange = (e) => {
    const files = [...e.target.files];
    if (files.length) enqueue(files);
    e.target.value = ''; // reset so re-selecting the same file works
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={onInputChange}
        style={{ display: 'none' }}
        aria-hidden="true"
      />
      {overlay && (
        <div className="dropzone-overlay" role="status" aria-live="polite">
          <div className="dropzone-overlay__panel">
            <div className="dropzone-overlay__icon"><Icon name="upload" size={48} /></div>
            <h2 className="dropzone-overlay__title">Drop to upload</h2>
            <p className="dropzone-overlay__hint">Images land in your stash; a IIIF manifest <code>.json</code> opens the import wizard.</p>
          </div>
        </div>
      )}
    </>
  );
}

// Helper for the topbar Upload button.
export function openFilePicker() {
  document.dispatchEvent(new CustomEvent('uw:open-picker'));
}
