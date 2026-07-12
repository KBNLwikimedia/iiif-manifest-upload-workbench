// "Import IIIF manifest" wizard (design Phase 2).
//
// Five steps, one modal:
//   1 input    — paste a manifest URL or drop/pick a manifest .json (Q1)
//   2 review   — validation report + manuscript "passport" + editable
//                mapping settings (title, category + create-toggle,
//                Wikidata Q-id with auto-lookup candidates)
//   3 select   — canvas gallery (IIIF thumbnails, lazy), checkboxes,
//                select all / none / range, downscale badges
//   4 confirm  — target-filename preview, license/author/caption recap,
//                48h-expiry + bandwidth heads-up, Start import
//   5 running  — sequential pipeline with per-canvas progress, abort,
//                final report (uploaded / duplicates / failed)
//
// The pipeline (api/iiif-pipeline.js) reuses the app's dropzone callbacks,
// so imported pages appear as ordinary stash rows behind the modal while
// the import runs; closing after completion drops the user into the normal
// table with everything prefilled.

import React from 'react';
import { fetchManifest, parseManifestFile, findManifestDuplicates } from '../api/iiif.js';
import { mapManifest } from '../api/iiif-map.js';
import { findManuscriptItems, resolveQid } from '../api/wikidata.js';
import { runIiifImport } from '../api/iiif-pipeline.js';
import { categoryExists, searchCategories, findManuscriptCategoryVariants, checkFilenamesExist } from '../api/commons.js';
import { KB_PARENT_CATEGORY, KB_LICENSE_WIKITEXT } from '../api/iiif-map.js';
import { DEMO_MODE } from '../config.js';
import { getRecentManifests, addRecentManifest, removeRecentManifest, clearRecentManifests, recordManifestIssue, removeManifestIssue, recentKey } from '../api/user-store.js';
import { PROVIDERS, DEFAULT_PROVIDER_ID, providerForUrl } from '../providers.js';
import ReportManifestModal from './report-manifest-modal.jsx';

const Icon = window.Icon;

// Render URLs inside manifest metadata values (Beeldlicentie, Datalicentie,
// BNM/DBNL links, …) as clickable links opening in a new tab.
function linkifyValue(text) {
  return String(text).split(/(https?:\/\/[^\s<>"']+)/g).map((part, i) => (
    /^https?:\/\//.test(part)
      ? <a key={i} href={part} target="_blank" rel="noopener noreferrer">{part}</a>
      : part
  ));
}

// Commons-style category suggestions: prefix-search the current name, and
// when the full proposal has no matches, progressively trim trailing words
// and retry — so a proposed "Handboek voor een biechtvader - KW 70 H 19"
// still surfaces the existing "Handboek voor een biechtvader…" categories.
// Bounded at 8 shrink steps; opensearch results come from the apiCache.
async function suggestCategories(name) {
  let q = String(name || '').replace(/^\s*Category\s*:\s*/i, '').trim();
  // Cap the progressive-trim search at 4 steps (OI-51): a match almost
  // always appears in the first few trims, and each step is a network call.
  for (let i = 0; i < 4 && q.length >= 2; i++) {
    const hits = await searchCategories(q);
    if (hits.length) return hits;
    const shorter = q.replace(/[\s\-–—]*\S+$/, '').trim();
    if (shorter === q) break;
    q = shorter;
  }
  return [];
}

// Persisted default parent category ("Set as default" writes it; used to
// prefill the parent field on every manifest). localStorage fast-path — a
// single user preference, not worth a wiki round-trip.
const PARENT_CAT_KEY = 'uwb.iiif.defaultParentCat';
function loadDefaultParent() {
  try { return (localStorage.getItem(PARENT_CAT_KEY) || '').trim() || KB_PARENT_CATEGORY; }
  catch { return KB_PARENT_CATEGORY; }
}
function saveDefaultParent(name) {
  try { localStorage.setItem(PARENT_CAT_KEY, name); } catch { /* private mode etc. */ }
}

// Recent manifests are persisted in Preferences.json (cross-device) via the
// user-store — see getRecentManifests / addRecentManifest / clearRecentManifests.

// A larger IIIF rendition for the lightbox (1200 px wide — well under the
// 25 MP cap), falling back to the tile thumb / full-res URL.
const largeRendition = (c) => (c?.serviceId ? `${c.serviceId}/full/1200,/0/default.jpg` : (c?.thumbUrl || c?.fullResUrl || ''));

const stripCatPrefix = (s) => String(s || '').replace(/^\s*Category\s*:\s*/i, '').trim();
const commonsCatUrl = (name) =>
  `https://commons.wikimedia.org/wiki/Category:${encodeURIComponent(stripCatPrefix(name).replace(/ /g, '_'))}`;

// Characters Commons forbids in a page title — also the wiki-structural set
// that enables template/link injection ([ ] { } |). Same list the mapper's
// sanitizer uses (src/api/iiif-map.js). Used to validate the free-text
// title/category inputs so a bad value can't reach a filename or category.
const FORBIDDEN_TITLE_CHARS_RE = /[#<>[\]|{}/\\:]/g;
function forbiddenCharsIn(s) {
  const str = String(s || '');
  const hits = str.match(FORBIDDEN_TITLE_CHARS_RE) || [];
  // Also flag ASCII control chars (never legitimate in a title).
  // eslint-disable-next-line no-control-regex
  const ctrl = [...str].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ? ['(control character)'] : [];
  return [...new Set([...hits, ...ctrl])];
}
// Strip every Commons-forbidden character out of a typed value, returning the
// cleaned string and the distinct characters that were removed (so the field
// can reject them on the fly and tell the user which ones).
function stripForbidden(raw) {
  const s = String(raw);
  const removed = [...new Set(s.match(FORBIDDEN_TITLE_CHARS_RE) || [])];
  return { clean: s.replace(FORBIDDEN_TITLE_CHARS_RE, ''), removed };
}

// Q-id must be a capital Q followed by digits only (empty = "no item", valid).
function qidFormatError(s) {
  const v = String(s || '').trim();
  if (!v) return null;
  return /^Q\d+$/.test(v) ? null : 'Enter a Q-id like “Q42” — a capital Q followed by digits only, no other characters.';
}

// Commons-category input with typeahead suggestions, shared by the
// per-manuscript category and the parent category so both behave identically.
// Owns its dropdown state + debounced suggestion fetch; the caller owns the
// value and any existence check. ↑/↓ move, Enter picks, Esc closes.
function CategoryCombobox({ id, value, onChange, inputClassName }) {
  const [open, setOpen] = React.useState(false);
  const [idx, setIdx] = React.useState(-1);
  const [suggestions, setSuggestions] = React.useState(null);

  React.useEffect(() => {
    const q = stripCatPrefix(value);
    if (!q) { setSuggestions(null); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      suggestCategories(q)
        .then((hits) => { if (alive) setSuggestions(hits.filter((h) => h !== q).slice(0, 10)); })
        .catch(() => { if (alive) setSuggestions([]); });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
  }, [value]);

  const list = suggestions || [];
  return (
    <div className="iiif-combobox">
      <input
        id={id}
        type="text"
        value={value}
        className={inputClassName}
        role="combobox"
        aria-expanded={open && !!list.length}
        aria-autocomplete="list"
        autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setOpen(true); setIdx(-1); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!list.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setIdx((i) => (i + 1) % list.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => (i <= 0 ? list.length - 1 : i - 1)); }
          else if (e.key === 'Enter' && open && idx >= 0 && idx < list.length) { e.preventDefault(); onChange(list[idx]); setOpen(false); setIdx(-1); }
          else if (e.key === 'Escape') { setOpen(false); setIdx(-1); }
        }}
      />
      {open && list.length > 0 && (
        <ul className="iiif-combobox__list" role="listbox">
          {list.map((s, i) => (
            <li
              key={s}
              role="option"
              aria-selected={i === idx}
              className={`iiif-combobox__item${i === idx ? ' iiif-combobox__item--active' : ''}`}
              // mousedown, not click: fires before the input's blur closes it.
              onMouseDown={(e) => { e.preventDefault(); onChange(s); setOpen(false); setIdx(-1); }}
              onMouseEnter={() => setIdx(i)}
            >
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const STEP_TITLES = {
  input: 'Import IIIF manifest',
  review: 'Step 1/3 - Check the manifest',
  select: 'Step 2/3 - Select images for importing into Wikimedia Commons',
  confirm: 'Step 3/3 - Ready to import',
  running: 'Importing…',
  done: 'Import finished',
};

export function IiifImportModal({ onClose, onAddItems, onUpdateItem, onReplaceItem, onEnsureArtworkTemplate, initialFile }) {
  const [step, setStep] = React.useState('input');
  const [url, setUrl] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  // True while a file is dragged over the input step (drop-to-import).
  const [dragOver, setDragOver] = React.useState(false);
  // OI-85: the "Report duplicates" modal (select step) is open.
  const [showReport, setShowReport] = React.useState(false);
  // Recently loaded manifest URLs (persisted in Preferences.json), for
  // one-click reloading.
  const [recent, setRecent] = React.useState(getRecentManifests);
  // Which provider tab of the recent list is active. Default to the tab of
  // the most recently loaded manifest (the list is newest-first), so the
  // modal reopens where the user last worked; fall back to KB.
  const [recentTab, setRecentTab] = React.useState(() => {
    const last = getRecentManifests()[0];
    return last ? (providerForUrl(last.url) || 'other') : 'kb';
  });
  // Provider profile (OI-78 scaffolding). Only KB is selectable for now; the
  // eCodices card is shown disabled. Doesn't gate loading yet.
  const [providerId, setProviderId] = React.useState(DEFAULT_PROVIDER_ID);
  // Canonical identity (recentKey) of the CURRENTLY-LOADED manifest — set by
  // recordRecent on successful parse, null when the manifest isn't recordable
  // (dropped file with no http id). The report flow keys issue records on this
  // (OI-88), never on the live `url` input (which the user can retype without
  // loading) nor a raw reload URL (which differs by load route).
  const [loadedRecentKey, setLoadedRecentKey] = React.useState(null);

  // Characters just rejected (stripped) from a review-step text field, so the
  // red note can name them. Cleared on the next keystroke that adds none.
  const [titleRejected, setTitleRejected] = React.useState(null);
  const [catRejected, setCatRejected] = React.useState(null);
  const [parentRejected, setParentRejected] = React.useState(null);

  // parse result
  const [parsed, setParsed] = React.useState(null); // { ok, report, manifest }

  // Metadata fields the user has excluded from processing (keyed by label).
  // Placeholder-looking fields ("Lorem ipsum", "Onbekend", "-", …) are still
  // imported by default but flagged in the passport; this lets the user drop
  // the junk ones so they don't reach the mapped wikitext/SDC.
  const [excludedFields, setExcludedFields] = React.useState(() => new Set());
  const toggleExcludedField = (label) =>
    setExcludedFields((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });

  // mapping settings (step 2, editable)
  const [title, setTitle] = React.useState('');
  const [category, setCategory] = React.useState('');
  // The umbrella category a newly-created per-manuscript category is filed
  // under. Editable (with autosuggest); defaults to the persisted default,
  // which the user can change via "Set as default" / "Reset to default".
  const [defaultParent, setDefaultParent] = React.useState(loadDefaultParent);
  const [parentCategory, setParentCategory] = React.useState(loadDefaultParent);
  // Explicit opt-in (default OFF): the user must approve category creation
  // via the checkbox in the confirm step before the tool may create it.
  const [createCat, setCreateCat] = React.useState(false);
  const [catExists, setCatExists] = React.useState(null); // null = checking/unknown

  // The first check after a manifest is parsed runs immediately (no debounce
  // — the category was set programmatically, not typed); later user edits
  // debounce. Reset to immediate in acceptParse.
  const catImmediateRef = React.useRef(true);

  // Live category existence check (typeahead suggestions live in
  // <CategoryCombobox>, which the per-manuscript + parent fields both use).
  React.useEffect(() => {
    const cat = stripCatPrefix(category);
    if (!cat) { setCatExists(null); return undefined; }
    let alive = true;
    setCatExists(null);
    const delay = catImmediateRef.current ? 0 : 300;
    catImmediateRef.current = false;
    const t = setTimeout(() => {
      // Race the existence check against an 8 s timeout so the "Checking
      // Commons…" state can never hang (OI-40); on error/timeout resolve to
      // a definite 'unknown' rather than swallowing and staying null.
      Promise.race([
        categoryExists(cat),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
      ])
        .then((v) => { if (alive) setCatExists(v); })
        .catch(() => { if (alive) setCatExists('unknown'); });
    }, delay);
    return () => { alive = false; clearTimeout(t); };
  }, [category]);
  const [qid, setQid] = React.useState('');
  // null = loading, 'error' = lookup failed (retry-able), [] = genuine no-hit.
  const [qidCandidates, setQidCandidates] = React.useState(null);
  // Merged-item note: { qid, text } shown while `qid` still equals its target.
  const [qidNote, setQidNote] = React.useState(null);
  // OI-68 B/C: existing category variants discovered on Commons (naming + fuzzy
  // search, verified under the KB parent). null = not searched, 'searching', or
  // [{name, source}]. Runs once per parse, only when the suggestion is missing.
  const [variantCats, setVariantCats] = React.useState(null);
  const variantSearchRef = React.useRef(0);

  // Normalize a manually-entered Q-id that points at a merged/redirected item
  // to its canonical target (Q114990994 → Q16641064): SDC statements must
  // never target a redirect. Debounced; a null resolve (invalid / missing /
  // network) keeps the typed value untouched — we only act on a positive
  // redirect answer.
  React.useEffect(() => {
    const q = qid.trim().toUpperCase();
    setQidNote((n) => (n && n.qid === q ? n : null));
    if (!/^Q\d+$/.test(q)) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      resolveQid(q).then((r) => {
        if (!alive || !r?.redirectedFrom) return;
        setQid(r.qid);
        setQidNote({ qid: r.qid, text: `${r.redirectedFrom} was merged into ${r.qid} — using the canonical item.` });
      });
    }, 500);
    return () => { alive = false; clearTimeout(t); };
  }, [qid]);

  // selection (step 3)
  const [selected, setSelected] = React.useState(() => new Set());
  // OI-85 stage 2/3: per-canvas filename overrides typed on the confirm step
  // ({ canvasIndex: newBaseName }), and the Commons availability results
  // (Map: filename → { exists, url?, invalid? } from checkFilenamesExist).
  const [renames, setRenames] = React.useState({});
  const [commonsTaken, setCommonsTaken] = React.useState(() => new Map());
  const [checkingNames, setCheckingNames] = React.useState(false);
  // Names already sent to checkFilenamesExist — guards the availability
  // effect against refetch loops (a failed batch stays un-marked, so a
  // step re-entry retries it).
  const checkedNamesRef = React.useRef(new Set());
  // hover zoom in the gallery: { canvas, left, top } or null. The preview
  // requests a larger IIIF rendition (700px) than the 400px tile thumbs.
  const [hoverPreview, setHoverPreview] = React.useState(null);
  // OI-47: the 700px request only fires after a ~250ms intent delay, so
  // sweeping the mouse across a 484-tile grid doesn't burst hundreds of
  // rendition requests at the IIIF server. The timer is cleared on
  // mouseleave, on scroll (the fixed panel would go stale), and on step
  // change.
  const hoverTimerRef = React.useRef(null);
  const clearHoverPreview = React.useCallback(() => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    setHoverPreview(null);
  }, []);
  React.useEffect(() => {
    clearHoverPreview();
    return () => { if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current); };
  }, [step, clearHoverPreview]);
  // The >25 MP note on the select step and the validation report on the
  // review step can be clicked away; a small "There are warnings…" line
  // remains to bring them back, and a newly loaded manifest resets both.
  const [downscaleNoteHidden, setDownscaleNoteHidden] = React.useState(false);
  // Select-step collision warning boxes (OI-85), dismissible like the 25 MP
  // note; each leaves a one-line restore link while hidden.
  const [dupNameNoteHidden, setDupNameNoteHidden] = React.useState(false);
  const [dupImageNoteHidden, setDupImageNoteHidden] = React.useState(false);
  // Select-step gallery filter: null | 'dup-name' | 'dup-image' — narrows the
  // grid to just the colliding thumbnails (selection state is untouched).
  const [galleryFilter, setGalleryFilter] = React.useState(null);
  const [reportHidden, setReportHidden] = React.useState(false);
  // Lightbox: the canvas shown enlarged (or null). Click a carousel thumb.
  const [lightbox, setLightbox] = React.useState(null);
  // Raw-manifest JSON inspector overlay.
  const [showJson, setShowJson] = React.useState(false);
  // Whether the current lightbox image has finished loading (drives the
  // spinner). Reset on every page change; the spinner itself is CSS-delayed
  // so cached/instant loads don't flash it.
  const [lightboxLoaded, setLightboxLoaded] = React.useState(false);
  // Fall back to the (already-cached) thumb if the 1200px rendition fails —
  // state-driven, not an imperative src swap, so onLoad's re-render can't
  // reset it into an error loop.
  const [lightboxUseThumb, setLightboxUseThumb] = React.useState(false);

  // pipeline (step 5)
  const abortRef = React.useRef({ current: false });
  // OI-30: token the async Q-id lookup so a slow lookup for an earlier
  // manifest can't stamp its result onto a later one (load A, Back, load B →
  // A resolves last). Bumped on each parse and invalidated on unmount.
  const qidLookupRef = React.useRef(0);
  const [progress, setProgress] = React.useState({ done: 0, total: 0 });
  const [summary, setSummary] = React.useState(null);

  // When opened via a dropped .json manifest, parse it immediately so the
  // user lands on the validation/review step. Runs once on mount.
  React.useEffect(() => {
    if (initialFile) loadFile(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc closes only on the done step (nothing left to lose). Everywhere
  // else — even step 1, where a typed URL is at stake — dismissal is the
  // × button only (OI-31/OI-70, same policy as the lightbox). Also lock
  // body scroll while open.
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && step === 'done') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, step]);

  // Lightbox keys, in the capture phase so Esc closes the lightbox (and
  // stops the wizard's Esc from firing); ← / → step between pages.
  React.useEffect(() => {
    if (!lightbox) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); setLightbox(null); }
      else if (e.key === 'ArrowRight') { e.stopPropagation(); stepLightbox(1); }
      else if (e.key === 'ArrowLeft') { e.stopPropagation(); stepLightbox(-1); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox]);

  // Esc closes the JSON inspector (capture phase, so it doesn't reach the
  // wizard's Esc and close the whole import).
  React.useEffect(() => {
    if (!showJson) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setShowJson(false); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [showJson]);

  // Preload the lightbox's neighbours (±2) so ‹ / › feels instant — the
  // browser caches the 1200 px renditions, so navigating hits cache instead
  // of a fresh IIIF fetch. Only fires while the lightbox is open (user
  // gesture), so it doesn't add background traffic to normal browsing.
  React.useEffect(() => {
    if (!lightbox) return;
    setLightboxLoaded(false); // new page → show spinner until its img loads
    setLightboxUseThumb(false);
    const list = parsed?.manifest?.canvases || [];
    const pos = list.findIndex((c) => c.index === lightbox.index);
    [pos - 1, pos + 1, pos - 2, pos + 2].forEach((p) => {
      const c = list[p];
      if (!c) return;
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.src = largeRendition(c);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox]);

  // OI-30: invalidate any in-flight Q-id lookup when the wizard unmounts.
  React.useEffect(() => () => { qidLookupRef.current = -1; }, []);

  // --- step 1 → 2: parse ---------------------------------------------------

  const acceptParse = (result) => {
    setParsed(result);
    if (!result.manifest) { setError(null); setStep('review'); return; }
    const { manuscript } = mapManifest(result.manifest);
    setTitle(manuscript.title);
    catImmediateRef.current = true; // check the derived category without debounce
    setCategory(manuscript.categoryName);
    setSelected(new Set(result.manifest.canvases.map((c) => c.index)));
    setRenames({});
    setCommonsTaken(new Map());
    checkedNamesRef.current = new Set();
    setExcludedFields(new Set());
    setDownscaleNoteHidden(false);
    setDupNameNoteHidden(false);
    setDupImageNoteHidden(false);
    setGalleryFilter(null);
    setTitleRejected(null);
    setCatRejected(null);
    setParentRejected(null);
    setReportHidden(false);
    setLightbox(null);
    setShowJson(false);
    setVariantCats(null);
    { const dp = loadDefaultParent(); setDefaultParent(dp); setParentCategory(dp); }
    setQid('');
    setQidCandidates(null);
    setCatExists(null);
    setError(null);
    setStep('review');
    // Fire the Q-id auto-lookup (+ the category check runs in its effect).
    runQidLookup(manuscript.signature);
  };

  // Wikidata signature lookup, retry-able. OI-30: guarded with a per-parse
  // token so a superseded lookup (user loaded another manifest meanwhile)
  // can't overwrite the current candidates/Q-id, and auto-fill never clobbers
  // a value the user typed while the lookup was in flight. A failed request
  // sets the distinct 'error' state (NOT the empty no-hit list) so the UI can
  // say "couldn't reach Wikidata — Retry" instead of a false "no item found"
  // (a transient SPARQL hiccup used to read as a definitive miss).
  const runQidLookup = (signature) => {
    const myLookup = ++qidLookupRef.current;
    setQidCandidates(null);
    findManuscriptItems(signature)
      .then((hits) => {
        if (qidLookupRef.current !== myLookup) return;
        setQidCandidates(hits);
        if (hits.length === 1) setQid((q) => q || hits[0].qid);
      })
      .catch(() => { if (qidLookupRef.current === myLookup) setQidCandidates('error'); });
  };

  // Record a successfully-parsed manifest in the recent list when it has a
  // REUSABLE url: the URL the user typed (URL route), or — for a dropped/
  // chosen file — the manifest's own `id` when that is an http(s) URL
  // (route C). KB manifests always carry a live `id`; a file whose id is not
  // a fetchable URL simply isn't recorded (there'd be nothing to reload).
  // Stores the derived signature + title; persisted to Preferences.json.
  const recordRecent = (result, urlOverride) => {
    if (!result?.manifest) return;
    const rawId = String(result.manifest.id || '').trim();
    const idUrl = /^https?:\/\//i.test(rawId) ? rawId : '';
    const u = String(urlOverride || '').trim() || idUrl;
    // Capture the canonical identity (OI-88: manifest id when http, else the
    // reload url) so the report flow keys issues on the manifest that's open,
    // regardless of how it was loaded. Null → not recordable (dropped file
    // with no reusable URL); the report modal disables "Save issue #".
    setLoadedRecentKey(recentKey({ id: idUrl, url: u }) || null);
    if (!u) return;
    const { manuscript } = mapManifest(result.manifest);
    const thumb = result.manifest.canvases?.[0]?.thumbUrl || null;
    // OI-85: persist the duplicate-collision counts so the recent list can flag
    // this manifest as "needs work" without re-parsing it.
    const dup = findManifestDuplicates(result.manifest.canvases || []);
    addRecentManifest({ url: u, id: result.manifest.id, signature: manuscript.signature, title: manuscript.title, thumb, dupNames: dup.dupNames, dupImages: dup.dupImages });
    setRecent(getRecentManifests());
    // Keep the active tab on the collection just loaded, so going Back (and
    // the next modal open) shows the list the user is actually working from.
    setRecentTab(providerForUrl(u) || 'other');
  };

  const loadUrl = async (overrideUrl) => {
    // Only treat a STRING arg as an override — passing loadUrl straight to
    // onClick would otherwise hand us the click event (→ "[object Object]").
    const hasOverride = typeof overrideUrl === 'string';
    const u = String(hasOverride ? overrideUrl : url).trim();
    if (!u) return;
    if (hasOverride) setUrl(u);
    setBusy(true); setError(null);
    try {
      const result = await fetchManifest(u);
      recordRecent(result, u);
      acceptParse(result);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const loadFile = async (file) => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const result = await parseManifestFile(file);
      // Route C: a dropped file has no typed URL, but KB manifests self-
      // identify with a fetchable `id` — record that so the drop is reloadable.
      recordRecent(result);
      acceptParse(result);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  // Drag-and-drop a manifest .json onto the input step. stopPropagation keeps
  // the drop from bubbling to the app-level image dropzone behind the modal;
  // a successful parse advances straight to the review step (via loadFile →
  // acceptParse), so the drop opens the "next" modal just like the picker.
  const onDropFile = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (busy) return;
    const file = e.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  };
  const onDragOverFile = (e) => {
    // Must preventDefault on dragover for the drop event to fire at all.
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    if (!busy && !dragOver) setDragOver(true);
  };
  const onDragLeaveFile = (e) => {
    // Ignore dragleave fired when moving between child elements — only clear
    // when the pointer actually leaves the drop container.
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDragOver(false);
  };

  // --- derived mapping (re-runs when the user edits title/category/qid) ----

  const mapping = React.useMemo(() => {
    if (!parsed?.manifest) return null;
    const m = parsed.manifest;
    // Placeholder-flagged fields are excluded from the parser's `fields` map;
    // re-include them here (they're imported by default, shown with ⚠️) unless
    // the user deselected them via the ✕. Non-placeholder values keep priority.
    const fields = { ...m.fields };
    for (const md of m.metadata) {
      if (md.placeholder && md.key && md.value && !excludedFields.has(md.label) && !(md.key in fields)) {
        fields[md.key] = md.value;
      }
    }
    return mapManifest({ ...m, fields }, { wikidataQid: qid.trim() || null });
  }, [parsed, qid, excludedFields]); // user-edited title/category are applied in effectiveItems below

  // OI-68 B/C: when the suggested category turns out NOT to exist, search
  // Commons for the manuscript's existing category under another name (once
  // per parse — keyed on the stable manuscript identity, not the editable
  // field). Reset to null in acceptParse so each manifest re-searches.
  React.useEffect(() => {
    if (catExists !== false || !mapping || variantCats !== null) return;
    const token = ++variantSearchRef.current;
    setVariantCats('searching');
    findManuscriptCategoryVariants({ title: mapping.manuscript.title, signature: mapping.manuscript.signature })
      .then((cats) => { if (variantSearchRef.current === token) setVariantCats(cats); })
      .catch(() => { if (variantSearchRef.current === token) setVariantCats([]); });
  }, [catExists, mapping, variantCats]);

  // Review-step carousel: a horizontally-scrollable strip of every canvas
  // thumbnail so the user can eyeball the whole manuscript. Thumbs are
  // lazy-loaded (same as the select-step gallery) so a 500-page manifest
  // doesn't fetch every thumb up front; the nav buttons scroll the strip.
  const carouselRef = React.useRef(null);
  const scrollCarousel = (dir) => {
    const el = carouselRef.current;
    if (el) el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.8, 200), behavior: 'smooth' });
  };
  // Move the lightbox to the previous/next canvas (by array position).
  const stepLightbox = (dir) => setLightbox((cur) => {
    const list = parsed?.manifest?.canvases || [];
    if (!cur || !list.length) return cur;
    const pos = list.findIndex((c) => c.index === cur.index);
    return list[pos + dir] || cur;
  });
  // Keep the review carousel in sync with the lightbox: whenever the lightbox
  // moves (open or arrow-navigated), centre the matching thumb in the strip so
  // that when the lightbox closes, the carousel is parked on that image.
  // Instant (not smooth) because the strip is hidden behind the lightbox while
  // navigating — no point animating scrolls the user can't see.
  React.useEffect(() => {
    if (!lightbox) return;
    const strip = carouselRef.current;
    if (!strip) return;
    const item = strip.querySelector(`[data-cindex="${lightbox.index}"]`);
    if (!item) return;
    const stripRect = strip.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const delta = (itemRect.left - stripRect.left) - (strip.clientWidth - item.clientWidth) / 2;
    // The strip's CSS `scroll-behavior: smooth` animates *every* scroll — even
    // a scrollLeft assignment — so rapid arrow-navigation would queue a pile of
    // interrupting animations that never reach the target. Force an instant
    // jump for the sync (the strip is hidden behind the lightbox anyway), then
    // restore the smooth default for the user's own nav-button scrolls.
    const prevBehavior = strip.style.scrollBehavior;
    strip.style.scrollBehavior = 'auto';
    strip.scrollLeft = Math.max(0, strip.scrollLeft + delta);
    strip.style.scrollBehavior = prevBehavior;
  }, [lightbox]);

  // Apply user-edited title/category on top of the mapped items without
  // re-deriving everything: filenames and captions substitute the derived
  // title; the category array is replaced wholesale.
  const effectiveItems = React.useMemo(() => {
    if (!mapping) return [];
    const t = title.trim();
    const cat = category.replace(/^\s*Category\s*:\s*/i, '').trim();
    return mapping.items.map((it) => {
      let base = it.title;
      if (t && t !== mapping.manuscript.title) {
        base = it.title.replace(mapping.manuscript.title, t);
      }
      // OI-85 stage 2: a filename typed on the confirm step overrides the
      // derived name (verbatim — the user is deliberately fixing a collision).
      const rn = renames[it.iiif.canvasIndex];
      if (typeof rn === 'string' && rn.trim()) base = rn.trim();
      return {
        ...it,
        title: base,
        categories: cat ? [cat] : it.categories,
        descriptions: { ...it.descriptions, nl: it.descriptions.nl.replace(mapping.manuscript.title, t || mapping.manuscript.title) },
        iiif: { ...it.iiif, targetFilename: `${base}.jpg` },
      };
    });
  }, [mapping, title, category, renames]);

  const chosen = effectiveItems.filter((it) => selected.has(it.iiif.canvasIndex));
  const totalMB = chosen.length * 12; // rough average from the sample corpus

  // OI-85 stage 2: batch-uniqueness of the FINAL names (after renames). The
  // mapper's auto-suffix guarantees the defaults are unique, so only a user
  // edit can create an in-batch collision — that's a hard error (two files
  // can't publish under one name), and it blocks Start import below.
  // Commons compares titles case-insensitively on the first letter and
  // treats _ as space; lowercase-whole-name is a safe over-approximation.
  const batchDupIdx = React.useMemo(() => {
    const byName = new Map();
    for (const it of chosen) {
      const k = it.iiif.targetFilename.toLowerCase().replace(/_/g, ' ');
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(it.iiif.canvasIndex);
    }
    const dup = new Set();
    for (const idxs of byName.values()) {
      if (idxs.length > 1) idxs.forEach((i) => dup.add(i));
    }
    return dup;
  }, [chosen]);

  // OI-85 stage 3: proactive Commons availability check for ALL candidate
  // filenames, on the confirm step. Debounced (renames retype the name on
  // every keystroke); only names not yet checked are fetched (batched ≤50 in
  // checkFilenamesExist). `chosen` is a fresh array every render, so the
  // effect keys on the joined name list instead.
  const chosenNamesKey = React.useMemo(
    () => chosen.map((it) => it.iiif.targetFilename).join('\n'),
    [effectiveItems, selected],
  );
  React.useEffect(() => {
    if (step !== 'confirm') return undefined;
    const names = chosenNamesKey ? chosenNamesKey.split('\n').filter(Boolean) : [];
    const unknown = names.filter((n) => !checkedNamesRef.current.has(n));
    if (!unknown.length) return undefined;
    let cancelled = false;
    const t = setTimeout(async () => {
      setCheckingNames(true);
      try {
        const res = await checkFilenamesExist(unknown);
        if (cancelled) return;
        unknown.forEach((n) => { if (res.has(n)) checkedNamesRef.current.add(n); });
        if (res.size) {
          setCommonsTaken((prev) => {
            const next = new Map(prev);
            for (const [k, v] of res) next.set(k, v);
            return next;
          });
        }
      } finally {
        if (!cancelled) setCheckingNames(false);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [step, chosenNamesKey]);

  // Confirm-step row flags derived from the three sources: label-duplicates
  // from the manifest (renameable), user-made batch collisions (hard error),
  // and Commons-taken / invalid names (stage 3).
  const nameIssueCounts = React.useMemo(() => {
    let taken = 0;
    let invalid = 0;
    for (const it of chosen) {
      const hit = commonsTaken.get(it.iiif.targetFilename);
      if (hit?.exists) taken += 1;
      else if (hit?.invalid) invalid += 1;
    }
    return { taken, invalid, batchDups: batchDupIdx.size };
  }, [chosen, commonsTaken, batchDupIdx]);

  // OI-85: detect two kinds of collision straight from the parsed manifest —
  // no downloads needed:
  //   - duplicate canvas LABELS → they derive the same Commons filename
  //     (forbidden). The mapper silently auto-suffixes " (2)"; we surface it.
  //   - duplicate IMAGES within the manifest → two canvases point at the exact
  //     same image URL, so their bytes (and SHA-1) are identical. URL-equality
  //     is a zero-cost proxy for the SHA-1 the pipeline computes at download.
  // Positions shown to the user are 1-based image numbers (canvas index + 1).
  const collisions = React.useMemo(() => {
    // NB: `const manifest = parsed?.manifest` is declared further down — using
    // it here would throw a TDZ ReferenceError during render (the exact bug
    // class CLAUDE.md's mount-test lesson exists for). Read from `parsed`.
    // Grouping is shared with the persisted flag + report body via
    // findManifestDuplicates; here we add the flat index sets + per-canvas
    // "partners" (1-based numbers of the OTHER images in the same group) that
    // the tile badges need.
    const { labelGroups, imageGroups } = findManifestDuplicates(parsed?.manifest?.canvases || []);
    const dupLabelIdx = new Set();
    const labelPartners = new Map();
    for (const g of labelGroups) {
      g.indices.forEach((i) => {
        dupLabelIdx.add(i);
        labelPartners.set(i, g.indices.filter((j) => j !== i).map((j) => j + 1));
      });
    }
    const dupImageIdx = new Set();
    const imagePartners = new Map();
    for (const g of imageGroups) {
      g.indices.forEach((i) => {
        dupImageIdx.add(i);
        imagePartners.set(i, g.indices.filter((j) => j !== i).map((j) => j + 1));
      });
    }
    return { dupLabelIdx, labelGroups, labelPartners, dupImageIdx, imageGroups, imagePartners };
  }, [parsed]);

  // --- step 4 → 5: run ------------------------------------------------------

  const start = async () => {
    // Design Q3: manuscript pages publish with {{Artwork}}. The wikitext
    // template is an app-global setting; switch it to Artwork now so the
    // imported rows (and their wikitext preview) use it.
    onEnsureArtworkTemplate?.();
    setStep('running');
    setSummary(null);
    abortRef.current = { current: false };
    setProgress({ done: 0, total: chosen.length });

    // Q8 revised: the category page is NOT created here. Import only tags
    // each row with the pending category; publishOne creates the page right
    // before the first file that uses it actually goes to Commons. Aborting
    // or discarding an import therefore never leaves an empty category
    // behind on Commons.
    const cat = category.replace(/^\s*Category\s*:\s*/i, '').trim();
    const pendingCategory = cat && createCat && catExists !== true ? cat : null;
    // The (possibly user-edited) parent the new category is filed under; falls
    // back to the current default if the field was cleared.
    const parentCat = stripCatPrefix(parentCategory) || defaultParent;
    const toImport = pendingCategory
      ? chosen.map((it) => ({ ...it, iiifPendingCategory: pendingCategory, iiifPendingParentCategory: parentCat }))
      : chosen;

    // OI-77: the pipeline hardens its own body, but a throw from the callback
    // surface (onAddItems/onUpdateItem → app state) or any future regression
    // would reject here — and the `running` step disables every dismissal
    // path (× hidden, Esc/backdrop inert), wedging the modal permanently.
    // Always land on `done` so "Go to the table" stays reachable.
    let result;
    try {
      result = await runIiifImport(toImport, {
        onAddItems,
        onUpdateItem,
        onReplaceItem,
        onItemDone: (_r, _i) => setProgress((p) => ({ ...p, done: p.done + 1 })),
        abortRef: abortRef.current,
      });
    } catch (e) {
      console.error('IIIF import crashed:', e);
      result = {
        uploaded: 0,
        duplicates: 0,
        failed: chosen.length,
        aborted: true,
        results: [],
        error: e?.message || String(e),
      };
    }
    setSummary({
      ...result,
      catNote: pendingCategory
        ? `Category “${pendingCategory}” will be created when you publish the first image.`
        : null,
    });
    setStep('done');
  };

  // --- render helpers -------------------------------------------------------

  const report = parsed?.report || [];
  // Entries actually shown in the review report. The `downscaled-canvases`
  // info is deliberately excluded here — the select step carries it (with the
  // counts) next to the ">25 MP" badges, so it isn't stated twice.
  const reportErrors = report.filter((e) => e.level === 'error');
  const reportWarnings = report.filter((e) => e.level === 'warning');
  const reportInfos = report.filter((e) => e.level === 'info' && e.code !== 'downscaled-canvases');
  const hasReport = reportErrors.length + reportWarnings.length + reportInfos.length > 0;
  const manifest = parsed?.manifest;

  // OI-85/OI-88 report flow: issue records key on the loaded manifest's
  // canonical identity (captured by recordRecent), so they land on the right
  // recent-list entry regardless of load route. Null identity → not recordable.
  const activeManifestKey = loadedRecentKey;
  const activeRecentEntry = activeManifestKey
    ? (recent.find((r) => recentKey(r) === activeManifestKey) || null)
    : null;
  const hasDuplicates = collisions.dupLabelIdx.size > 0 || collisions.dupImageIdx.size > 0;
  const handleRecordIssue = (number, issueUrl) => {
    if (!activeManifestKey) return;
    recordManifestIssue(activeManifestKey, { number, url: issueUrl });
    setRecent(getRecentManifests());
  };
  const handleRemoveIssue = (number) => {
    if (!activeManifestKey) return;
    removeManifestIssue(activeManifestKey, number);
    setRecent(getRecentManifests());
  };

  // Input validation for the review-step free-text fields (OI-85 hardening):
  // block Commons-forbidden / injection characters in the title + categories,
  // and enforce the Q-id shape. These gate the "Next" button below.
  const titleForbidden = forbiddenCharsIn(title);
  const categoryForbidden = forbiddenCharsIn(category);
  const parentForbidden = forbiddenCharsIn(parentCategory);
  const qidErr = qidFormatError(qid);
  const reviewInputsInvalid =
    titleForbidden.length > 0 || categoryForbidden.length > 0 || parentForbidden.length > 0 || !!qidErr;

  // Text-field onChange that strips Commons-forbidden characters as they're
  // typed and records which ones were rejected (so the field can never hold an
  // illegal char, and the note can name it).
  const onGuardedText = (setValue, setRejected) => (raw) => {
    const { clean, removed } = stripForbidden(raw);
    setValue(clean);
    setRejected(removed.length ? removed : null);
  };

  const toggleAll = (on) => {
    if (!manifest) return;
    setSelected(on ? new Set(manifest.canvases.map((c) => c.index)) : new Set());
  };
  const toggleOne = (index) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  };
  const invertSelection = () => {
    if (!manifest) return;
    setSelected((prev) => {
      const next = new Set();
      for (const c of manifest.canvases) if (!prev.has(c.index)) next.add(c.index);
      return next;
    });
  };

  // Index → parsed canvas, so the clustered (filtered) view can look up a
  // group's members by their canvas index (skipped canvases leave gaps, so a
  // positional lookup would be wrong).
  const canvasByIndex = React.useMemo(
    () => new Map((manifest?.canvases || []).map((c) => [c.index, c])),
    [manifest],
  );

  // One select-step thumbnail tile. Extracted so both the flat grid and the
  // clustered (filtered) view render identical tiles.
  const renderCanvasTile = (c) => {
    if (!c) return null;
    const target = effectiveItems.find((it) => it.iiif.canvasIndex === c.index);
    const labelPartners = collisions.labelPartners.get(c.index);
    const imagePartners = collisions.imagePartners.get(c.index);
    const tooltip = [
      c.label || `canvas ${c.index + 1}`,
      target ? `→ File:${target.iiif.targetFilename}` : null,
      labelPartners ? `⚠ Same label as image${labelPartners.length === 1 ? '' : 's'} ${labelPartners.join(', ')} (filename collision)` : null,
      imagePartners ? `⚠ Identical picture to image${imagePartners.length === 1 ? '' : 's'} ${imagePartners.join(', ')} (same SHA-1)` : null,
      c.downscaled ? `Delivered downscaled to ~${target?.iiif.expectedWidth || c.expectedWidth}×${target?.iiif.expectedHeight || c.expectedHeight}px (25 MP cap)` : null,
    ].filter(Boolean).join('\n');
    return (
      <label
        key={c.index}
        className={`iiif-canvas${selected.has(c.index) ? ' iiif-canvas--on' : ''}${collisions.dupLabelIdx.has(c.index) ? ' iiif-canvas--dup-name' : ''}${collisions.dupImageIdx.has(c.index) ? ' iiif-canvas--dup-image' : ''}`}
        title={tooltip}
        onMouseEnter={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const panelW = 440;
          const left = r.right + panelW + 20 < window.innerWidth ? r.right + 12 : Math.max(8, r.left - panelW - 12);
          const top = Math.max(8, Math.min(r.top, window.innerHeight - Math.min(window.innerHeight * 0.7, 640) - 8));
          if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = setTimeout(() => {
            hoverTimerRef.current = null;
            setHoverPreview({ canvas: c, left, top });
          }, 250);
        }}
        onMouseLeave={clearHoverPreview}
      >
        <span className="iiif-canvas__num" aria-hidden="true">{c.index + 1}</span>
        <input
          type="checkbox"
          className="iiif-canvas__check"
          checked={selected.has(c.index)}
          onChange={() => toggleOne(c.index)}
        />
        <img src={c.thumbUrl} alt={c.label || `canvas ${c.index + 1}`} loading="lazy" />
        <span className="iiif-canvas__badges">
          {c.downscaled && (
            <em className="iiif-canvas__badge" title="This image is larger than 25 megapixels, so it arrives slightly smaller (still high-res).">&gt;25 MP</em>
          )}
          {collisions.dupLabelIdx.has(c.index) && (
            <em
              className="iiif-canvas__badge iiif-canvas__badge--dup-name"
              title={`Same label as image${(collisions.labelPartners.get(c.index) || []).length === 1 ? '' : 's'} ${(collisions.labelPartners.get(c.index) || []).join(', ')} — they would collide into one Commons filename. Rename in the next step.`}
            >dup. name = {(collisions.labelPartners.get(c.index) || []).join(', ')}</em>
          )}
          {collisions.dupImageIdx.has(c.index) && (
            <em
              className="iiif-canvas__badge iiif-canvas__badge--dup-image"
              title={`The exact same picture as image${(collisions.imagePartners.get(c.index) || []).length === 1 ? '' : 's'} ${(collisions.imagePartners.get(c.index) || []).join(', ')} (identical SHA-1).`}
            >dup. image = {(collisions.imagePartners.get(c.index) || []).join(', ')}</em>
          )}
        </span>
        <span className="iiif-canvas__label">
          {c.label || `#${c.index + 1}`}
        </span>
        <span className="iiif-canvas__meta">
          {c.width > 0 && c.height > 0 && (
            <span className="iiif-canvas__dims" title="Native resolution of the source image on the IIIF server">
              {c.width} × {c.height} px
            </span>
          )}
          {c.fullResUrl && (
            <a
              className="iiif-canvas__fullres"
              href={c.fullResUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="Open the full-resolution image on the IIIF server (new tab)"
            >full-res ↗</a>
          )}
        </span>
      </label>
    );
  };

  return (
    // Backdrop follows the same dismissal policy as Esc (OI-70): a stray
    // click must not destroy a loaded wizard — or a typed URL.
    <div className="modal-backdrop" onClick={step === 'done' ? onClose : undefined}>
      <div
        className="modal iiif-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="iiif-modal-title"
      >
        <header className="modal__head">
          <div>
            <h2 className="modal__title" id="iiif-modal-title">{STEP_TITLES[step]}</h2>
            {/* The manuscript identity line stays put on every step past
                input, so the header reads consistently through the wizard;
                step-specific info goes on a second line. */}
            {step === 'input' && (
              <p className="modal__sub">Paste a IIIF Presentation 3.0 manifest URL, or pick — or drag-and-drop — a downloaded manifest .json file. Only Presentation 3.0 is supported for now — 2.x support will be added in the future.</p>
            )}
            {/* Steps past input show the manuscript identity prominently:
                the first-image thumbnail in front of the Short title +
                signature (bigger/darker than the old grey sub-line), with the
                image count demoted to a muted suffix (maintainer request
                2026-07-12). The app icon stays put at the top-left of the head. */}
            {step !== 'input' && (manifest ? (() => {
              const short = (title || mapping?.manuscript?.title || '').trim();
              const sig = (mapping?.manuscript?.signature || '').trim();
              const parts = [short, sig].filter(Boolean);
              const identity = parts.length ? parts.join(' — ') : (manifest.label || 'Untitled manifest');
              const thumbUrl = manifest.canvases?.[0]?.thumbUrl;
              return (
                <div className="iiif-modal__idrow">
                  {thumbUrl && (
                    <img className="iiif-modal__thumb" src={thumbUrl} alt="" aria-hidden="true" />
                  )}
                  <p className="iiif-modal__identity" title={identity}>
                    {identity}
                    <span className="iiif-modal__idcount"> · {manifest.canvasCount} images in this manifest</span>
                  </p>
                  {/* Flag a manifest known to need work (duplicate filenames /
                      images) right in the header, on every step past input. */}
                  {hasDuplicates && (
                    <span
                      className="iiif-modal__needswork"
                      title={`This manifest needs checking — ${[collisions.dupLabelIdx.size ? `${collisions.dupLabelIdx.size} duplicate filenames` : '', collisions.dupImageIdx.size ? `${collisions.dupImageIdx.size} duplicate images` : ''].filter(Boolean).join(', ')}. See the Select step warnings.`}
                    >⚠ needs work</span>
                  )}
                </div>
              );
            })() : (
              <p className="modal__sub">The manifest could not be used.</p>
            ))}
            {/* The selection count lives in the select-step toolbar (next to
                Select all/none), not here — the header stays identity-only. */}
            {step !== 'input' && step !== 'review' && step !== 'select' && manifest && (
              <p className={`modal__sub iiif-modal__substep${step === 'confirm' ? ' iiif-modal__substep--confirm' : ''}`}>
                {step === 'confirm' && (
                  <>
                    <strong>{chosen.length} images</strong> will be downloaded from the IIIF server and stashed on Wikimedia Commons.
                    <br />
                    An <strong>estimate of ~{totalMB} MB</strong> will be transferred.
                  </>
                )}
                {step === 'running' && `${progress.done} / ${progress.total} images processed — keep this tab open.`}
                {step === 'done' && 'The imported images are now rows in your stash — review and publish from the table.'}
              </p>
            )}
          </div>
          {step !== 'running' && (
            <button className="btn btn--quiet btn--icon-only" onClick={onClose} aria-label="Close">
              {Icon ? <Icon name="close" size={16} /> : '×'}
            </button>
          )}
        </header>

        {/* onScroll: the hover-zoom panel is fixed-positioned, so any scroll
            would leave it floating over the wrong tile (OI-47). On the select
            step the body is pinned (only the thumbnail grid scrolls). */}
        <div
          className={`modal__body iiif-modal__body${step === 'select' ? ' iiif-modal__body--select' : ''}`}
          onScroll={clearHoverPreview}
        >

          {step === 'input' && (
            <div
              className={`iiif-step-input${dragOver ? ' iiif-step-input--drag' : ''}`}
              onDragOver={onDragOverFile}
              onDragEnter={onDragOverFile}
              onDragLeave={onDragLeaveFile}
              onDrop={onDropFile}
            >
              {dragOver && (
                <div className="iiif-dropoverlay" aria-hidden="true">
                  <div className="iiif-dropoverlay__inner">
                    <span className="iiif-dropoverlay__icon">⬇</span>
                    Drop the manifest .json to import
                  </div>
                </div>
              )}
              {/* Provider profile (OI-78). KB is the only supported collection
                  for now; eCodices is shown disabled ("coming soon"). */}
              <div className="iiif-providers">
                <div className="iiif-providers__label">Collection</div>
                <div className="iiif-providers__grid">
                  {PROVIDERS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`iiif-provider${providerId === p.id ? ' iiif-provider--on' : ''}${p.available ? '' : ' iiif-provider--soon'}`}
                      onClick={() => p.available && setProviderId(p.id)}
                      disabled={!p.available}
                      aria-pressed={providerId === p.id}
                      title={p.available ? p.blurb : `${p.name} — support coming soon (see issue #78)`}
                    >
                      <img className="iiif-provider__logo" src={p.logo} alt={p.name} />
                      <span className="iiif-provider__name">{p.name}</span>
                      {!p.available && <span className="iiif-provider__badge">Coming soon</span>}
                    </button>
                  ))}
                </div>
                <p className="iiif-hint iiif-providers__hint">
                  Only <strong>KB manifests</strong> are supported right now — eCodices NL support
                  is coming as soon as possible.
                </p>
              </div>

              <label className="iiif-label" htmlFor="iiif-url">Manifest URL <span className="iiif-label__note">(KB compliant)</span></label>
              <div className="iiif-url-row">
                <input
                  id="iiif-url"
                  type="url"
                  placeholder="https://iiif.bibliotheken.nl/kw-129-a-24"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') loadUrl(); }}
                  disabled={busy}
                  autoFocus
                />
                <button className="btn btn--progressive" onClick={() => loadUrl()} disabled={busy || !url.trim()}>
                  {busy ? 'Loading…' : 'Load'}
                </button>
              </div>
              <p className="iiif-or">— or —</p>
              <label className="btn btn--progressive iiif-file-btn">
                Choose a manifest .json file — or drop one anywhere here
                <input
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={(e) => loadFile(e.target.files?.[0])}
                  disabled={busy}
                />
              </label>
              {error && <p className="iiif-error" role="alert">{error}</p>}

              {recent.length > 0 && (() => {
                // Group the recent list by provider (KB / eCodices NL / Other)
                // so each collection gets its own tab.
                const isFlagged = (r) => (r.dupNames || 0) > 0 || (r.dupImages || 0) > 0;
                const groups = { kb: [], ecodices: [], other: [], needswork: [] };
                for (const r of recent) {
                  groups[providerForUrl(r.url) || 'other'].push(r);
                  // OI-85: the "Needs work" tab collects flagged manifests across
                  // every provider, so erroneous ones are findable in one place.
                  if (isFlagged(r)) groups.needswork.push(r);
                }
                const TABS = [
                  { id: 'kb', label: 'KB' },
                  { id: 'ecodices', label: 'eCodices NL' },
                  { id: 'other', label: 'Other' },
                  { id: 'needswork', label: '⚠ Needs work' },
                ];
                const activeTab = (groups[recentTab] && (recentTab !== 'needswork' || groups.needswork.length > 0)) ? recentTab : 'kb';
                const shown = groups[activeTab] || [];
                const dupSummaryText = (r) => {
                  const parts = [];
                  if (r.dupNames > 0) parts.push(`${r.dupNames} duplicate filename${r.dupNames === 1 ? '' : 's'}`);
                  if (r.dupImages > 0) parts.push(`${r.dupImages} duplicate image${r.dupImages === 1 ? '' : 's'}`);
                  return parts.join(' · ');
                };
                return (
                <div className="iiif-recent">
                  <div className="iiif-recent__head">
                    <span>Recent manifests <span className="iiif-recent__count">({recent.length})</span></span>
                    <button
                      type="button"
                      className="iiif-linkbtn iiif-recent__clear"
                      onClick={() => { clearRecentManifests(); setRecent([]); }}
                      title="Remove every manifest from this list"
                    >Clear all</button>
                  </div>
                  <div className="iiif-recent__tabs" role="tablist">
                    {TABS.filter((t) => t.id !== 'needswork' || groups.needswork.length > 0).map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === t.id}
                        className={'iiif-recent__tab'
                          + (activeTab === t.id ? ' iiif-recent__tab--active' : '')
                          + (t.id === 'needswork' ? ' iiif-recent__tab--warn' : '')}
                        onClick={() => setRecentTab(t.id)}
                      >
                        {t.label} <span className="iiif-recent__tabcount">({groups[t.id].length})</span>
                      </button>
                    ))}
                  </div>
                  {shown.length === 0 ? (
                    <p className="iiif-recent__empty">No recent manifests from this collection.</p>
                  ) : (
                  <ul className="iiif-recent__list">
                    {shown.map((r) => (
                      <li key={r.url} className="iiif-recent__row">
                        <button
                          type="button"
                          className="iiif-recent__item"
                          onClick={() => loadUrl(r.url)}
                          disabled={busy}
                          title={r.url}
                        >
                          {r.thumb && (
                            <img
                              className="iiif-recent__thumb"
                              src={r.thumb}
                              alt=""
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              onError={(e) => { e.currentTarget.style.display = 'none'; }}
                            />
                          )}
                          <span className="iiif-recent__text">
                            <span className="iiif-recent__title">
                              {r.signature && <span className="iiif-recent__sig">{r.signature}</span>}
                              {r.signature && r.title && ' — '}
                              {r.title}
                              {!r.signature && !r.title && r.url}
                              {/* OI-85: red ⚠ behind the name flags an erroneous
                                  manifest in every tab. */}
                              {isFlagged(r) && (
                                <span
                                  className="iiif-recent__warn"
                                  title={`Needs checking — ${dupSummaryText(r)}. See the “⚠ Needs work” tab.`}
                                >⚠</span>
                              )}
                            </span>
                            {activeTab === 'needswork' && isFlagged(r)
                              ? <span className="iiif-recent__flags">{dupSummaryText(r)}</span>
                              : (r.signature || r.title) && <span className="iiif-recent__url">{r.url}</span>}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="iiif-recent__remove"
                          onClick={() => { removeRecentManifest(r.url); setRecent(getRecentManifests()); }}
                          aria-label={`Remove ${r.signature || r.title || r.url} from recent manifests`}
                          title="Remove from this list"
                        >×</button>
                        {/* Recorded GitHub issues (only in the Needs-work tab) —
                            outside the load button so the links are clickable;
                            wraps to its own line via flex-basis:100%. */}
                        {activeTab === 'needswork' && r.issues?.length > 0 && (
                          <span className="iiif-recent__issues">
                            Reported: {r.issues.map((iss, i) => (
                              <React.Fragment key={iss.number}>
                                {i > 0 && ', '}
                                <a href={iss.url} target="_blank" rel="noopener noreferrer">#{iss.number}</a>
                              </React.Fragment>
                            ))}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  )}
                </div>
                );
              })()}
            </div>
          )}

          {step === 'review' && (
            <div className="iiif-step-review">
              {/* validation report — only rendered when there's something to
                  show, so a manifest with no (visible) issues doesn't leave an
                  empty box at the top. */}
              {hasReport && !reportHidden && (
                <div className="iiif-report">
                  {/* Dismissible only when a manifest actually loaded — on a
                      failed parse the report IS the content. */}
                  {manifest && (
                    <button
                      type="button"
                      className="iiif-downscale-note__close"
                      onClick={() => setReportHidden(true)}
                      aria-label="Dismiss these warnings"
                      title="Dismiss these warnings"
                    >×</button>
                  )}
                  {reportErrors.map((e, i) => (
                    <p key={`e${i}`} className="iiif-report__line iiif-report__line--error">⛔ {e.message}</p>
                  ))}
                  {reportWarnings.map((e, i) => (
                    <p key={`w${i}`} className="iiif-report__line iiif-report__line--warning">⚠️ {e.message}</p>
                  ))}
                  {reportInfos.map((e, i) => (
                    <p key={`i${i}`} className="iiif-report__line">ℹ️ {e.message}</p>
                  ))}
                </div>
              )}
              {hasReport && reportHidden && (
                <p className="iiif-warnings-restore">
                  <button type="button" className="iiif-linkbtn" onClick={() => setReportHidden(false)}>
                    ⚠️ There are warnings for this manifest — show them
                  </button>
                </p>
              )}

              {manifest && mapping && (
                <>
                  {/* Carousel: every canvas thumbnail (public IIIF thumbs),
                      lazy-loaded, scroll through the whole manuscript. */}
                  {manifest.canvases.length > 0 && (
                    <div className="iiif-carousel">
                      <button
                        type="button"
                        className="iiif-carousel__nav"
                        onClick={() => scrollCarousel(-1)}
                        aria-label="Scroll thumbnails left"
                      >‹</button>
                      <div className="iiif-carousel__strip" ref={carouselRef}>
                        {manifest.canvases.map((c, i) => (
                          <figure key={c.index} className="iiif-carousel__item" data-cindex={c.index} title={c.label || `image ${i + 1}`}>
                            <button
                              type="button"
                              className="iiif-carousel__thumb"
                              onClick={() => setLightbox(c)}
                              aria-label={`Enlarge image ${i + 1}${c.label ? ` (${c.label})` : ''}`}
                            >
                              <span className="iiif-carousel__num">{i + 1}</span>
                              {c.thumbUrl
                                ? (
                                  <img
                                    src={c.thumbUrl}
                                    alt={c.label || `canvas ${c.index + 1}`}
                                    loading="lazy"
                                    referrerPolicy="no-referrer"
                                  />
                                )
                                : <span className="iiif-carousel__ph">#{c.index + 1}</span>}
                            </button>
                          </figure>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="iiif-carousel__nav"
                        onClick={() => scrollCarousel(1)}
                        aria-label="Scroll thumbnails right"
                      >›</button>
                    </div>
                  )}

                  {/* manuscript passport */}
                  <table className="iiif-passport">
                    <tbody>
                      {/* The manifest's own label (title) and summary are the
                          richest description the KB ships — show them in full,
                          above the metadata pairs (neither is part of
                          metadata[]). */}
                      {manifest.label && (
                        <tr>
                          <th>Title</th>
                          <td>{manifest.label}</td>
                        </tr>
                      )}
                      {manifest.summary && (
                        <tr>
                          <th>Summary</th>
                          <td>{linkifyValue(manifest.summary)}</td>
                        </tr>
                      )}
                      {/* All fields with a value are shown. Placeholder-looking
                          ones ("Lorem ipsum", "Onbekend", "-", …) get a ⚠️ and a
                          ✕ to drop them from the import (OI: don't silently
                          ignore — flag + let the user decide). */}
                      {manifest.metadata.filter((m) => m.value).map((m, i) => {
                        const excluded = excludedFields.has(m.label);
                        return (
                          <tr key={i} className={excluded ? 'iiif-passport__row--excluded' : ''}>
                            <th>{m.label}</th>
                            <td>
                              <span className="iiif-passport__value">
                                {linkifyValue(m.value.length > 220 ? `${m.value.slice(0, 220)}…` : m.value)}
                              </span>
                              {/* Folia ≠ images: a manuscript's leaf count and the
                                  manifest's canvas count routinely differ — explain
                                  on hover (maintainer request 2026-07-10). */}
                              {/aantal folia/i.test(m.label) && (
                                <span
                                  className="iiif-passport__info"
                                  title={`A folium is one physical leaf of the manuscript (parchment or paper); its front (recto) and back (verso) are two written pages. That count differs from the number of images in this manifest (${manifest.canvasCount}): binding, covers and flyleaves are photographed too, and some manuscripts are digitized as two-page spreads — one image showing two folia sides.`}
                                  aria-label="What is a folium, and why does this number differ from the image count?"
                                >ⓘ</span>
                              )}
                              {m.placeholder && (
                                <span className="iiif-field-flag">
                                  <span
                                    className="iiif-field-flag__warn"
                                    title="This looks like a placeholder or 'unknown' value — review it before publishing."
                                    aria-label="Possible placeholder value"
                                  >⚠️</span>
                                  <button
                                    type="button"
                                    className="iiif-field-flag__toggle"
                                    onClick={() => toggleExcludedField(m.label)}
                                    title={excluded
                                      ? 'Include this field in the import again'
                                      : 'Drop this field from the import (e.g. a "Lorem ipsum" placeholder)'}
                                    aria-pressed={excluded}
                                  >{excluded ? '↺' : '✕'}</button>
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  {parsed?.raw && (
                    <p className="iiif-viewjson">
                      <button type="button" className="iiif-linkbtn" onClick={() => setShowJson(true)}>
                        View manifest (JSON)
                      </button>
                    </p>
                  )}

                  {/* editable mapping settings */}
                  <div className="iiif-settings">
                    <label className="iiif-label" htmlFor="iiif-title">
                      Short title <span className="iiif-label__note">— used in filenames and the category (type to change it)</span>
                    </label>
                    <input
                      id="iiif-title"
                      type="text"
                      value={title}
                      onChange={(e) => onGuardedText(setTitle, setTitleRejected)(e.target.value)}
                      className={titleForbidden.length ? 'iiif-input--invalid' : undefined}
                      aria-invalid={titleForbidden.length > 0}
                    />
                    {(titleRejected || titleForbidden.length > 0) && (
                      <p className="iiif-input-error" role="alert">⚠️ {(titleRejected || titleForbidden).map((c) => `“${c}”`).join(', ')} {(titleRejected || titleForbidden).length === 1 ? 'is' : 'are'} not allowed on Wikimedia Commons — removed it from the short title.</p>
                    )}

                    <fieldset className="iiif-fieldset">
                      <legend>Categories</legend>

                      <label className="iiif-label" htmlFor="iiif-cat">
                        Suggested category for this manuscript <span className="iiif-label__note">(type to change it)</span>
                      </label>
                      <CategoryCombobox
                        id="iiif-cat"
                        value={category}
                        onChange={onGuardedText(setCategory, setCatRejected)}
                        inputClassName={categoryForbidden.length ? 'iiif-input--invalid' : (catExists === null && category.trim() ? 'iiif-input--checking' : '')}
                      />
                      {(catRejected || categoryForbidden.length > 0) && (
                        <p className="iiif-input-error" role="alert">⚠️ {(catRejected || categoryForbidden).map((c) => `“${c}”`).join(', ')} {(catRejected || categoryForbidden).length === 1 ? 'is' : 'are'} not allowed on Wikimedia Commons — removed from the category name.</p>
                      )}
                      <p className="iiif-hint">
                        {catExists === null && category.trim() && 'Checking Commons…'}
                        {catExists === true && (
                          <span className="iiif-cat-exists">
                            ✔ This category{' '}
                            <a
                              href={`https://commons.wikimedia.org/wiki/Category:${encodeURIComponent(category.replace(/^\s*Category\s*:\s*/i, '').trim().replace(/ /g, '_'))}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Open the category on Commons (new tab)"
                            >already exists on Commons ↗</a>
                            {' '}— files will be added to it.
                          </span>
                        )}
                        {catExists === 'unknown' && (
                          <span>⚠️ Couldn't check Commons just now (network) — it'll be treated as not yet existing.</span>
                        )}
                      </p>

                      {/* OI-68: when the suggestion doesn't exist, offer the
                          manuscript's existing category(-ies) found under other
                          names — Wikidata P373 (★, authoritative) + generated
                          naming variants + fuzzy search verified under the KB
                          parent. Adopting one REPLACES the suggestion (single
                          category per manuscript, decided 2026-07-09). */}
                      {catExists === false && (() => {
                        const cand = (Array.isArray(qidCandidates) ? qidCandidates : []).find((c) => c.qid === qid.trim());
                        const wdCat = cand?.commonsCategory || null;
                        const cur = stripCatPrefix(category);
                        const existing = [];
                        if (wdCat && wdCat !== cur) existing.push({ name: wdCat, source: 'wikidata' });
                        for (const v of (Array.isArray(variantCats) ? variantCats : [])) {
                          if (v.name !== cur && !existing.some((e) => e.name === v.name)) existing.push(v);
                        }
                        const searching = variantCats === 'searching';
                        // Source badge: where each suggestion came from, with a
                        // plain-language explanation in the tooltip.
                        const SRC = {
                          wikidata: { label: 'via Wikidata', tip: "The manuscript's Wikidata item declares this as its Commons category (property P373) — the most authoritative source." },
                          naming: { label: 'via name match', tip: 'An existing Commons category whose name follows a known KB naming convention for this signature (e.g. "Den Haag KB 76 E 5") — found by checking those name patterns.' },
                          search: { label: 'via search', tip: 'Found by a full-text search of Commons category names (using the title and signature), then verified to be filed under the KB manuscripts parent category — so it is not a random name look-alike.' },
                        };

                        // Case 1 — existing categories found under another name:
                        // lead with adopting one; the suggested name is the
                        // fallback (so it doesn't read as "must be created").
                        if (existing.length > 0) {
                          const single = existing.length === 1;
                          return (
                            <div className="iiif-existing-cats">
                              <p className="iiif-existing-cats__head">
                                <strong>This manuscript seems to already have a{single ? '' : ' category on Commons'}</strong>
                                {single && (
                                  <>
                                    {' '}
                                    <a href={commonsCatUrl(existing[0].name)} target="_blank" rel="noopener noreferrer">
                                      <strong>Category:{existing[0].name}</strong>
                                    </a>{' '}
                                    <strong>on Commons</strong>
                                  </>
                                )}
                                {' '}— use {single ? 'it' : 'one'} instead of creating a new category “{cur}”:
                              </p>
                              {existing.map((e) => (
                                <div key={e.name} className="iiif-existing-cats__item">
                                  <button
                                    type="button"
                                    className="btn btn--progressive iiif-existing-cats__use"
                                    onClick={() => setCategory(e.name)}
                                  >Use this category</button>
                                  {/* With one variant the head already names+links it —
                                      repeating the name here read as clutter. */}
                                  {!single && (
                                    <a href={commonsCatUrl(e.name)} target="_blank" rel="noopener noreferrer">{e.name} ↗</a>
                                  )}
                                  <span className="iiif-existing-cats__src" title={SRC[e.source]?.tip}>{SRC[e.source]?.label} ⓘ</span>
                                </div>
                              ))}
                              <p className="iiif-existing-cats__foot">…or keep “{cur}” — it'll be created for you when you publish the first image.</p>
                            </div>
                          );
                        }

                        // Case 2 — still checking for an existing category.
                        if (searching) {
                          return <p className="iiif-hint iiif-existing-cats__searching">Checking Commons for an existing category under another name…</p>;
                        }

                        // Case 3 — genuinely new: the category will be created.
                        return (
                          <p className="iiif-hint">
                            <span className="iiif-cat-missing">✚ New category — “{cur}” isn't on Commons yet; you'll approve creating it in the final step.</span>
                          </p>
                        );
                      })()}

                      <label className="iiif-label" htmlFor="iiif-parent-cat">
                        Parent category <span className="iiif-label__note">— the umbrella the manuscript's category is filed under (type to change it)</span>
                      </label>
                      <CategoryCombobox
                        id="iiif-parent-cat"
                        value={parentCategory}
                        onChange={onGuardedText(setParentCategory, setParentRejected)}
                        inputClassName={parentForbidden.length ? 'iiif-input--invalid' : ''}
                      />
                      {(parentRejected || parentForbidden.length > 0) && (
                        <p className="iiif-input-error" role="alert">⚠️ {(parentRejected || parentForbidden).map((c) => `“${c}”`).join(', ')} {(parentRejected || parentForbidden).length === 1 ? 'is' : 'are'} not allowed on Wikimedia Commons — removed from the category name.</p>
                      )}
                      <p className="iiif-hint">
                        {stripCatPrefix(parentCategory) && (
                          <a
                            href={commonsCatUrl(parentCategory)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open the parent category on Commons (new tab)"
                          >View on Commons ↗</a>
                        )}
                        {stripCatPrefix(parentCategory) && stripCatPrefix(parentCategory) !== defaultParent && (
                          <>
                            {' · '}
                            <button
                              type="button"
                              className="iiif-linkbtn"
                              onClick={() => { const v = stripCatPrefix(parentCategory); saveDefaultParent(v); setDefaultParent(v); }}
                              title="Remember this as the default parent category for future imports"
                            >Set as default</button>
                          </>
                        )}
                        {stripCatPrefix(parentCategory) !== defaultParent && (
                          <>
                            {' · '}
                            <button
                              type="button"
                              className="iiif-linkbtn"
                              onClick={() => setParentCategory(defaultParent)}
                              title={`Reset to “${defaultParent}”`}
                            >Reset to default</button>
                          </>
                        )}
                      </p>
                      <p className="iiif-hint iiif-parent-default">
                        Default:{' '}
                        <a href={commonsCatUrl(defaultParent)} target="_blank" rel="noopener noreferrer">{defaultParent} ↗</a>
                      </p>
                    </fieldset>

                    <fieldset className="iiif-fieldset">
                      <legend>Wikidata</legend>

                      <label className="iiif-label" htmlFor="iiif-qid">
                        Item of the manuscript <span className="iiif-label__note">— its Q-id on Wikidata (type to change it)</span>
                      </label>
                      <input
                        id="iiif-qid"
                        type="text"
                        placeholder="Q…"
                        value={qid}
                        onChange={(e) => setQid(e.target.value.replace(/^\s+|\s+$/g, ''))}
                        className={qidErr ? 'iiif-input--invalid' : undefined}
                        aria-invalid={!!qidErr}
                      />
                      {qidErr && <p className="iiif-input-error" role="alert">⚠️ {qidErr}</p>}
                      {qidNote && qidNote.qid === qid.trim().toUpperCase() && (
                        <p className="iiif-hint">ℹ️ {qidNote.text}</p>
                      )}
                      {qidCandidates === null && (
                        <p className="iiif-hint">Searching Wikidata for this manuscript by its signature…</p>
                      )}
                      {qidCandidates === 'error' && (
                        <p className="iiif-hint">
                          ⚠️ Couldn't reach Wikidata just now —{' '}
                          <button
                            type="button"
                            className="iiif-linkbtn"
                            onClick={() => mapping && runQidLookup(mapping.manuscript.signature)}
                          >retry the lookup</button>
                          {' '}or enter a Q-id manually.
                        </p>
                      )}
                      {Array.isArray(qidCandidates) && qidCandidates.length === 0 && (
                        <p className="iiif-hint">
                          No Wikidata item found for signature “{mapping?.manuscript?.signature || '…'}” — leave empty or enter a Q-id manually.
                        </p>
                      )}
                      {Array.isArray(qidCandidates) && qidCandidates.length > 0 && (
                        <div className="iiif-wd-found">
                          <p className="iiif-wd-found__head">
                            <strong>Found on Wikidata</strong>{' '}
                            <span
                              className="iiif-wd-found__how"
                              title={`Wikidata items whose “inventory number” statement (P217) matches this manuscript's signature “${mapping?.manuscript?.signature || ''}”.`}
                            >by signature ⓘ</span>:
                          </p>
                          {qidCandidates.map((c) => {
                            const inUse = qid.trim().toUpperCase() === c.qid;
                            const gallery = c.commonsGallery || c.commonsPage;
                            return (
                              <div key={c.qid} className="iiif-wd-item">
                                <div className="iiif-wd-item__main">
                                  {inUse ? (
                                    <span className="iiif-wd-item__inuse" title="This is the Q-id filled in above.">✓ in use</span>
                                  ) : (
                                    <button
                                      type="button"
                                      className="btn btn--progressive iiif-wd-item__use"
                                      onClick={() => setQid(c.qid)}
                                    >Use this item</button>
                                  )}
                                  <a
                                    href={`https://www.wikidata.org/wiki/${c.qid}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title="Open this item on Wikidata (new tab)"
                                  >
                                    <strong>{c.qid}</strong> — {c.label} ↗
                                  </a>
                                </div>
                                {(gallery || c.commonsCategory) && (
                                  <p className="iiif-wd-item__links">
                                    This Wikidata item also links to:{' '}
                                    {gallery && (
                                      <a
                                        href={`https://commons.wikimedia.org/wiki/${encodeURIComponent(gallery.replace(/ /g, '_'))}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title={c.commonsGallery
                                          ? 'Stated on the Wikidata item as its “Commons gallery” (P935) — opens the gallery page on Commons (new tab).'
                                          : "The Wikidata item's Wikimedia Commons sitelink — opens the gallery page on Commons (new tab)."}
                                      >its gallery on Commons ↗</a>
                                    )}
                                    {gallery && c.commonsCategory && ' · '}
                                    {c.commonsCategory && (
                                      <a
                                        href={commonsCatUrl(c.commonsCategory)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title="Stated on the Wikidata item as its “Commons category” (P373) — opens the category on Commons (new tab)."
                                      >its category on Commons ↗</a>
                                    )}
                                  </p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </fieldset>
                  </div>
                </>
              )}
            </div>
          )}

          {step === 'select' && manifest && (
            <div className="iiif-step-select">
              {manifest.downscaledCount > 0 && !downscaleNoteHidden && (
                <div className="iiif-hint iiif-note iiif-downscale-note">
                  <div className="iiif-note__main">
                    <strong>⚠️ Images larger than 25 megapixels — {manifest.downscaledCount} / {manifest.canvasCount} images</strong>
                    <div className="iiif-note__body">
                      They carry a “&gt;25 MP” tag below. The KB's IIIF image server caps what it delivers at 25 MP, so those images arrive slightly smaller than the original (but still high-res) — e.g. an 8040 × 6030 image (48 MP) downloads at ~25 MP. This is a limit of the IIIF server — not of Wikimedia Commons, which accepts much larger files.
                    </div>
                  </div>
                  <div className="iiif-note__actions">
                    <button
                      type="button"
                      className={'btn btn--quiet iiif-note__filter' + (galleryFilter === 'downscale' ? ' is-active' : '')}
                      aria-pressed={galleryFilter === 'downscale'}
                      onClick={() => setGalleryFilter((f) => (f === 'downscale' ? null : 'downscale'))}
                    >
                      {galleryFilter === 'downscale' ? '↩ Show all images' : `Show only these ${manifest.downscaledCount} images`}
                    </button>
                    <button
                      type="button"
                      className="iiif-note__close"
                      onClick={() => { setDownscaleNoteHidden(true); if (galleryFilter === 'downscale') setGalleryFilter(null); }}
                      aria-label="Dismiss this note"
                      title="Dismiss this note"
                    >×</button>
                  </div>
                </div>
              )}
              {manifest.downscaledCount > 0 && downscaleNoteHidden && (
                <p className="iiif-warnings-restore">
                  <button type="button" className="iiif-linkbtn" onClick={() => setDownscaleNoteHidden(false)}>
                    ⚠️ This manifest has images &gt; 25 megapixels — show the note
                  </button>
                </p>
              )}
              {/* OI-85: one warning box per collision type, styled to match the
                  border that marks the affected thumbnails (solid red = same
                  filename, dashed orange = same picture). Both dismissible with
                  a restore line, like the 25 MP note. */}
              {collisions.labelGroups.length > 0 && !dupNameNoteHidden && (
                <div className="iiif-hint iiif-note iiif-collision-note iiif-collision-note--name" role="alert">
                  <div className="iiif-note__main">
                    <strong>⚠️ Duplicate filenames — {collisions.dupLabelIdx.size} images.</strong>
                    <div className="iiif-note__body">
                      These canvases share a label, so they would derive the <em>same</em> Commons filename, which is not allowed. They are marked with a <span className="iiif-collision-swatch iiif-collision-swatch--name" />&nbsp;red border below; you'll be able to rename them in the next step.
                      <ul className="iiif-collision-note__list">
                        {collisions.labelGroups.map((g) => (
                          <li key={g.label}><code>{g.label}</code> — images {g.positions.join(', ')}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  <div className="iiif-note__actions">
                    <button
                      type="button"
                      className={'btn btn--quiet iiif-note__filter' + (galleryFilter === 'dup-name' ? ' is-active' : '')}
                      aria-pressed={galleryFilter === 'dup-name'}
                      onClick={() => setGalleryFilter((f) => (f === 'dup-name' ? null : 'dup-name'))}
                    >
                      {galleryFilter === 'dup-name' ? '↩ Show all images' : `Show only these ${collisions.dupLabelIdx.size} images`}
                    </button>
                    <button
                      type="button"
                      className="iiif-note__close"
                      onClick={() => { setDupNameNoteHidden(true); if (galleryFilter === 'dup-name') setGalleryFilter(null); }}
                      aria-label="Dismiss this warning"
                      title="Dismiss this warning"
                    >×</button>
                  </div>
                </div>
              )}
              {collisions.labelGroups.length > 0 && dupNameNoteHidden && (
                <p className="iiif-warnings-restore">
                  <button type="button" className="iiif-linkbtn" onClick={() => setDupNameNoteHidden(false)}>
                    ⚠️ This manifest has duplicate filenames — show the warning
                  </button>
                </p>
              )}
              {collisions.imageGroups.length > 0 && !dupImageNoteHidden && (
                <div className="iiif-hint iiif-note iiif-collision-note iiif-collision-note--image" role="alert">
                  <div className="iiif-note__main">
                    <strong>⚠️ Duplicate images — {collisions.dupImageIdx.size} images.</strong>
                    <div className="iiif-note__body">
                      The exact same picture appears more than once in this manifest (identical image URL → identical SHA-1). They are marked with a <span className="iiif-collision-swatch iiif-collision-swatch--image" />&nbsp;orange dashed border. Uploading the same image twice is usually a manifest defect — consider deselecting the duplicates.
                      <ul className="iiif-collision-note__list">
                        {collisions.imageGroups.map((g, i) => (
                          <li key={i}>images {g.positions.join(' = ')} are identical</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  <div className="iiif-note__actions">
                    <button
                      type="button"
                      className={'btn btn--quiet iiif-note__filter' + (galleryFilter === 'dup-image' ? ' is-active' : '')}
                      aria-pressed={galleryFilter === 'dup-image'}
                      onClick={() => setGalleryFilter((f) => (f === 'dup-image' ? null : 'dup-image'))}
                    >
                      {galleryFilter === 'dup-image' ? '↩ Show all images' : `Show only these ${collisions.dupImageIdx.size} images`}
                    </button>
                    <button
                      type="button"
                      className="iiif-note__close"
                      onClick={() => { setDupImageNoteHidden(true); if (galleryFilter === 'dup-image') setGalleryFilter(null); }}
                      aria-label="Dismiss this warning"
                      title="Dismiss this warning"
                    >×</button>
                  </div>
                </div>
              )}
              {collisions.imageGroups.length > 0 && dupImageNoteHidden && (
                <p className="iiif-warnings-restore">
                  <button type="button" className="iiif-linkbtn" onClick={() => setDupImageNoteHidden(false)}>
                    ⚠️ This manifest has duplicate images — show the warning
                  </button>
                </p>
              )}
              {/* OI-85: report the duplicates to the manifest maintainers as a
                  GitHub issue (labelled manifest-needs-checking). Shown only
                  when this manifest actually has collisions. */}
              {hasDuplicates && (
                <div className="iiif-report-bar">
                  <span className="iiif-report-bar__text">
                    These duplicates are a defect in the source manifest. You can report them to the maintainers so they can fix the manifest.
                    {activeRecentEntry?.issues?.length > 0 && (
                      <span className="iiif-report-bar__done">
                        {' '}Reported as {activeRecentEntry.issues.map((iss, i) => (
                          <React.Fragment key={iss.number}>
                            {i > 0 && ', '}
                            <a href={iss.url} target="_blank" rel="noopener noreferrer">#{iss.number}</a>
                          </React.Fragment>
                        ))}.
                      </span>
                    )}
                  </span>
                  <button type="button" className="btn iiif-report-bar__btn" onClick={() => setShowReport(true)}>
                    ⚠️ Report duplicates on GitHub
                  </button>
                </div>
              )}
              <div className="iiif-select-bar">
                <button className="btn btn--quiet" onClick={() => toggleAll(true)}>Select all</button>
                <button className="btn btn--quiet" onClick={() => toggleAll(false)}>Select none</button>
                <button className="btn btn--quiet" onClick={invertSelection}>Invert selection</button>
                {galleryFilter && (
                  <button className="btn btn--quiet iiif-select-bar__showall" onClick={() => setGalleryFilter(null)} title="Clear the filter — show all images">
                    ↩ Show all images
                  </button>
                )}
                <span className="iiif-select-bar__count">
                  {galleryFilter && <span className="iiif-select-bar__filtered">filtered · </span>}
                  <strong>{selected.size}</strong> of {manifest.canvasCount} images selected
                </span>
              </div>
              <div
                className={'iiif-gallery' + (galleryFilter === 'dup-name' || galleryFilter === 'dup-image' ? ' iiif-gallery--clustered' : '')}
                onScroll={clearHoverPreview}
              >
                {galleryFilter === 'downscale'
                  ? manifest.canvases.filter((c) => c.downscaled).map((c) => renderCanvasTile(c))
                  : galleryFilter === 'dup-name' || galleryFilter === 'dup-image'
                  ? (galleryFilter === 'dup-name' ? collisions.labelGroups : collisions.imageGroups).map((g, gi) => {
                      // Frame each group to exactly its tiles: N columns of
                      // 112px (capped at 6, wraps beyond), + gaps + padding.
                      const cols = Math.min(g.indices.length, 6);
                      const width = cols * 112 + (cols - 1) * 8 + 24;
                      return (
                        <div
                          className={'iiif-cluster iiif-cluster--' + (galleryFilter === 'dup-name' ? 'name' : 'image')}
                          key={gi}
                          style={{ width }}
                        >
                          <div className="iiif-cluster__head">
                            {galleryFilter === 'dup-name'
                              ? <>
                                  <span className="iiif-cluster__label">Same filename</span>
                                  <code className="iiif-cluster__code">{g.label}</code>
                                </>
                              : <span className="iiif-cluster__label">Identical image</span>}
                            <span className="iiif-cluster__imgs">images {g.positions.join(galleryFilter === 'dup-image' ? ' = ' : ', ')}</span>
                          </div>
                          <div className="iiif-cluster__grid" style={{ gridTemplateColumns: `repeat(${cols}, 112px)` }}>
                            {g.indices.map((idx) => renderCanvasTile(canvasByIndex.get(idx))).filter(Boolean)}
                          </div>
                        </div>
                      );
                    })
                  : manifest.canvases.map((c) => renderCanvasTile(c))}
              </div>
              {hoverPreview && (
                <div className="iiif-hover-preview" style={{ left: hoverPreview.left, top: hoverPreview.top }} aria-hidden="true">
                  {/* Caption above the image (maintainer request 2026-07-12):
                      filename first, then the manuscript identity as
                      "Short title — signature" (matches the wizard header). */}
                  <div className="iiif-hover-preview__cap">
                    <span className="iiif-hover-preview__label">{hoverPreview.canvas.label || `#${hoverPreview.canvas.index + 1}`}</span>
                    {(() => {
                      const st = (title || mapping?.manuscript?.title || '').trim();
                      const sig = (mapping?.manuscript?.signature || '').trim();
                      const idline = st && sig ? `${st} — ${sig}` : (st || sig);
                      return idline ? <span className="iiif-hover-preview__title">{idline}</span> : null;
                    })()}
                  </div>
                  <img
                    src={hoverPreview.canvas.serviceId
                      ? `${hoverPreview.canvas.serviceId}/full/700,/0/default.jpg`
                      : hoverPreview.canvas.thumbUrl}
                    alt=""
                    onError={(e) => { if (e.target.src !== hoverPreview.canvas.thumbUrl) e.target.src = hoverPreview.canvas.thumbUrl; }}
                  />
                </div>
              )}
            </div>
          )}

          {step === 'confirm' && (
            <div className="iiif-step-confirm">
              <p><strong>{chosen.length}</strong> images → your upload stash, then review &amp; publish from the table as usual.</p>
              <div className="iiif-recap-files">
                <strong>Target filenames ({chosen.length}):</strong>
                {/* OI-85 stage 2+3 status line: batch collisions are a hard
                    error (blocks Start import); Commons-taken names a strong
                    warning (they'd bounce at publish as fileexists). */}
                {checkingNames && (
                  <span className="iiif-namecheck iiif-namecheck--busy">Checking name availability on Commons…</span>
                )}
                {nameIssueCounts.batchDups > 0 && (
                  <span className="iiif-namecheck iiif-namecheck--error">
                    ⛔ {nameIssueCounts.batchDups} images share the same filename — every name must be unique before the import can start.
                  </span>
                )}
                {nameIssueCounts.taken > 0 && (
                  <span className="iiif-namecheck iiif-namecheck--warn">
                    ⚠️ {nameIssueCounts.taken} filename{nameIssueCounts.taken === 1 ? ' is' : 's are'} already used by an existing file on Commons — rename below, or publishing will refuse them.
                  </span>
                )}
                {nameIssueCounts.invalid > 0 && (
                  <span className="iiif-namecheck iiif-namecheck--warn">
                    ⚠️ {nameIssueCounts.invalid} filename{nameIssueCounts.invalid === 1 ? ' is' : 's are'} not a valid Commons title.
                  </span>
                )}
                <div className="iiif-filelist" role="list">
                  {chosen.map((it) => {
                    const idx = it.iiif.canvasIndex;
                    const name = it.iiif.targetFilename;
                    const hit = commonsTaken.get(name);
                    const isBatchDup = batchDupIdx.has(idx);
                    const isTaken = !!hit?.exists;
                    const isInvalid = !!hit?.invalid;
                    const fromDupLabel = collisions.dupLabelIdx.has(idx);
                    const editable = fromDupLabel || isBatchDup || isTaken || isInvalid || renames[idx] !== undefined;
                    if (!editable) {
                      return <div key={idx} role="listitem">File:{name}</div>;
                    }
                    return (
                      <div
                        key={idx}
                        role="listitem"
                        className={
                          'iiif-filelist__row--edit' +
                          (isBatchDup ? ' iiif-filelist__row--dup' : '') +
                          ((isTaken || isInvalid) ? ' iiif-filelist__row--taken' : '')
                        }
                      >
                        <span className="iiif-filelist__prefix">File:</span>
                        <input
                          type="text"
                          className="iiif-filelist__input"
                          value={renames[idx] !== undefined ? renames[idx] : it.title}
                          onChange={(e) => setRenames((prev) => ({ ...prev, [idx]: e.target.value }))}
                          spellCheck={false}
                          aria-label={`Filename for image ${idx + 1}`}
                        />
                        <span className="iiif-filelist__ext">.jpg</span>
                        {isBatchDup && <span className="iiif-filelist__flag iiif-filelist__flag--dup" title="Another image in this batch has this exact filename.">duplicate in batch</span>}
                        {isTaken && (
                          <a
                            className="iiif-filelist__flag iiif-filelist__flag--taken"
                            href={hit.url || `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(name)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="A different file already uses this name on Commons — open it in a new tab. Rename to avoid a publish conflict."
                          >already on Commons ↗</a>
                        )}
                        {isInvalid && <span className="iiif-filelist__flag iiif-filelist__flag--dup" title={hit.reason || 'Not a valid Commons title.'}>invalid title</span>}
                        {!isBatchDup && !isTaken && !isInvalid && fromDupLabel && (
                          <span className="iiif-filelist__flag iiif-filelist__flag--info" title="This image's canvas label was not unique in the manifest; the tool auto-suffixed the name. Edit it to something meaningful if you like.">auto-renamed</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              <ul className="iiif-recap">
                <li>
                  <strong>Category:</strong>{' '}
                  <a
                    href={`https://commons.wikimedia.org/wiki/Category:${encodeURIComponent(category.replace(/^\s*Category\s*:\s*/i, '').trim().replace(/ /g, '_'))}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >{category}</a>
                  {catExists === true && <span className="iiif-cat-exists"> (exists — files will be added to it)</span>}
                  {catExists !== true && (
                    <span className="iiif-cat-approve">
                      {' — does not exist yet:'}
                      <label className="iiif-check">
                        <input type="checkbox" checked={createCat} onChange={(e) => setCreateCat(e.target.checked)} />
                        {' '}<strong>I approve creating this category</strong> (under{' '}
                        <a
                          href={commonsCatUrl(stripCatPrefix(parentCategory) || defaultParent)}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          title="Open the parent category on Commons (new tab)"
                        >{stripCatPrefix(parentCategory) || defaultParent} ↗</a>) when the first image is published
                      </label>
                      {!createCat && (
                        <em className="iiif-cat-approve__warn">Without approval, publishing stays blocked until the category exists on Commons.</em>
                      )}
                    </span>
                  )}
                </li>
                <li><strong>License:</strong> <code>{KB_LICENSE_WIKITEXT}</code></li>
                <li><strong>Template:</strong> <a href="https://commons.wikimedia.org/wiki/Template:Artwork" target="_blank" rel="noopener noreferrer"><code>{'{{Artwork}}'}</code></a></li>
                <li><strong>Author:</strong> <code>{mapping?.manuscript.author}</code></li>
                <li>
                  <strong>Wikidata:</strong>{' '}
                  {qid.trim()
                    ? <a href={`https://www.wikidata.org/wiki/${qid.trim()}`} target="_blank" rel="noopener noreferrer">{qid.trim()} ↗</a>
                    : '— none —'}
                </li>
                <li><strong>Date:</strong> <code>{mapping?.manuscript.dateWikitext || '—'}</code></li>
              </ul>
              <p className="iiif-hint">
                ⏳ Stash files expire after <strong>48 hours</strong> — plan to publish this batch before then.
                Downloads and uploads run one at a time; a large batch takes a while ({DEMO_MODE ? 'demo mode: uploads are simulated' : `~${totalMB} MB down + up`}).
              </p>
            </div>
          )}

          {(step === 'running' || step === 'done') && (
            <div className="iiif-step-running">
              <div className="iiif-progressbar" role="progressbar" aria-valuenow={progress.done} aria-valuemax={progress.total}>
                <div className="iiif-progressbar__fill" style={{ width: progress.total ? `${(progress.done / progress.total) * 100}%` : '0%' }} />
              </div>
              <p className="iiif-hint">{progress.done} / {progress.total} images</p>
              {summary && (
                <div className="iiif-summary">
                  <p>✅ Uploaded to stash: <strong>{summary.uploaded}</strong></p>
                  {summary.duplicates > 0 && <p>♻️ Already on Commons (stashed &amp; flagged): <strong>{summary.duplicates}</strong></p>}
                  {summary.failed > 0 && <p>⚠️ Failed: <strong>{summary.failed}</strong></p>}
                  {/* Distinct error messages with counts — the failed rows are
                      session-only, so this report is the user's (and the
                      maintainer's) primary diagnostic. */}
                  {summary.failed > 0 && (
                    <ul className="iiif-summary__errors">
                      {Object.entries(summary.results.filter((r) => r.state === 'error').reduce((acc, r) => {
                        acc[r.error] = (acc[r.error] || 0) + 1;
                        return acc;
                      }, {})).map(([msg, count]) => (
                        <li key={msg}><code>{msg}</code>{count > 1 ? ` — ${count}×` : ''}</li>
                      ))}
                    </ul>
                  )}
                  {summary.error
                    ? <p>❌ The import stopped unexpectedly: {summary.error}. Anything already stashed is kept; re-run to continue.</p>
                    : summary.aborted && <p>⏹️ Import was cancelled before finishing.</p>}
                  {summary.catNote && <p>🗂️ {summary.catNote}</p>}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Nav (Back / Next) sits bottom-left; a blue Close anchors bottom-right
            on every step-by-step screen, matching the other modals. During the
            import run and on the done screen the footer keeps its own single
            action (Cancel / Go to the table) — no second Close there. */}
        <footer className="modal__foot iiif-modal__foot">
          <div className="iiif-modal__nav">
            {step === 'review' && (
              <>
                <button className="btn" onClick={() => setStep('input')}>Back</button>
                <button
                  className="btn btn--progressive"
                  disabled={!parsed?.ok || reviewInputsInvalid}
                  title={reviewInputsInvalid ? 'Fix the highlighted fields first (forbidden characters / invalid Q-id).' : undefined}
                  onClick={() => setStep('select')}
                >
                  Next: select images
                </button>
              </>
            )}
            {step === 'select' && (
              <>
                <button className="btn" onClick={() => setStep('review')}>Back</button>
                <button className="btn btn--progressive" disabled={selected.size === 0} onClick={() => setStep('confirm')}>
                  Next: review import
                </button>
              </>
            )}
            {step === 'confirm' && (
              <>
                <button className="btn" onClick={() => setStep('select')}>Back</button>
                <button
                  className="btn btn--progressive"
                  onClick={start}
                  disabled={batchDupIdx.size > 0}
                  title={batchDupIdx.size > 0 ? 'Two or more images share the same filename — make them unique first.' : undefined}
                >
                  Start import ({chosen.length} images)
                </button>
              </>
            )}
            {step === 'running' && (
              <button className="btn" onClick={() => { abortRef.current.current = true; }}>
                Cancel after current image
              </button>
            )}
          </div>
          {step === 'done'
            ? <button className="btn btn--progressive" onClick={onClose}>Go to the table</button>
            : step !== 'running' && <button className="btn iiif-modal__close-btn" onClick={onClose}>Cancel</button>}
        </footer>

        {lightbox && (() => {
          const canv = parsed?.manifest?.canvases || [];
          const pos = canv.findIndex((c) => c.index === lightbox.index);
          return (
            <div
              className="iiif-lightbox"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label={`Image ${pos + 1}`}
            >
              <button type="button" className="iiif-lightbox__close" onClick={(e) => { e.stopPropagation(); setLightbox(null); }} aria-label="Close">×</button>
              <button
                type="button"
                className="iiif-lightbox__nav iiif-lightbox__nav--prev"
                onClick={(e) => { e.stopPropagation(); stepLightbox(-1); }}
                disabled={pos <= 0}
                aria-label="Previous image"
              >‹</button>
              <figure className="iiif-lightbox__fig" onClick={(e) => e.stopPropagation()}>
                <div className="iiif-lightbox__imgbox">
                  {!lightboxLoaded && <span className="iiif-lightbox__spinner" role="status" aria-label="Loading image…" />}
                  {/* Position badge (top-left), same black/white style as the
                      carousel thumbs — "5/31" = 5th of 31 images. */}
                  <span className="iiif-lightbox__num" aria-hidden="true">{pos + 1}/{canv.length}</span>
                  <img
                    key={lightbox.index}
                    src={lightboxUseThumb && lightbox.thumbUrl ? lightbox.thumbUrl : largeRendition(lightbox)}
                    alt={lightbox.label || `image ${pos + 1}`}
                    referrerPolicy="no-referrer"
                    style={{ opacity: lightboxLoaded ? 1 : 0 }}
                    onLoad={() => setLightboxLoaded(true)}
                    onError={() => {
                      if (!lightboxUseThumb && lightbox.thumbUrl) setLightboxUseThumb(true);
                      else setLightboxLoaded(true);
                    }}
                  />
                </div>
                <figcaption>
                  {/* Manuscript title (the derived/edited short title) when the
                      manifest carries more than just the signature — so the
                      lightbox names the manuscript, not only the image file.
                      Real titles show in full at any length; only when the title
                      fell back to the *whole summary* (a descriptive sentence)
                      and the user hasn't edited it do we cap it (with an
                      ellipsis + full-text tooltip) so the caption isn't a
                      paragraph. */}
                  {(title.trim() || (mapping?.manuscript?.signature || '').trim()) && (() => {
                    const t = title.trim();
                    const isFallback = mapping?.manuscript?.titleFromSummaryFallback
                      && t === (mapping?.manuscript?.title || '').trim();
                    const short = (isFallback && t.length > 50) ? t.slice(0, 50).replace(/\s+\S*$/, '') + '…' : t;
                    // Append the shelfmark/signature (e.g. "— KW 70 H 36") so the
                    // lightbox caption matches the wizard header identity.
                    const sig = (mapping?.manuscript?.signature || '').trim();
                    const line = short && sig ? `${short} — ${sig}` : (short || sig);
                    return <span className="iiif-lightbox__title" title={t !== short ? t : undefined}>{line}</span>;
                  })()}
                  <span className="iiif-lightbox__meta">
                    Image {pos + 1} of {canv.length}
                    {lightbox.label ? ` — ${lightbox.label}` : ''}
                    {lightbox.fullResUrl && (
                      <>{' · '}<a href={lightbox.fullResUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>full-res ↗</a></>
                    )}
                  </span>
                </figcaption>
              </figure>
              <button
                type="button"
                className="iiif-lightbox__nav iiif-lightbox__nav--next"
                onClick={(e) => { e.stopPropagation(); stepLightbox(1); }}
                disabled={pos >= canv.length - 1}
                aria-label="Next image"
              >›</button>
            </div>
          );
        })()}

        {showJson && parsed?.raw && (
          <div className="iiif-jsonview" onClick={() => setShowJson(false)} role="dialog" aria-modal="true" aria-label="Manifest JSON">
            <div className="iiif-jsonview__panel" onClick={(e) => e.stopPropagation()}>
              <div className="iiif-jsonview__head">
                <strong>Manifest JSON</strong>
                {parsed.manifest?.sourceUrl && (
                  <a className="iiif-jsonview__src" href={parsed.manifest.sourceUrl} target="_blank" rel="noopener noreferrer">{parsed.manifest.sourceUrl} ↗</a>
                )}
                <span className="iiif-jsonview__spacer" />
                <button
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => navigator.clipboard?.writeText(JSON.stringify(parsed.raw, null, 2))}
                  title="Copy the JSON to the clipboard"
                >Copy</button>
                <button type="button" className="btn btn--quiet btn--icon-only" onClick={() => setShowJson(false)} aria-label="Close">×</button>
              </div>
              <pre className="iiif-jsonview__body">{JSON.stringify(parsed.raw, null, 2)}</pre>
            </div>
          </div>
        )}

        {showReport && manifest && (
          <ReportManifestModal
            onClose={() => setShowReport(false)}
            manifest={manifest}
            manuscript={mapping?.manuscript}
            sourceUrl={manifest.sourceUrl || manifest.id || activeManifestKey}
            recordedIssues={activeRecentEntry?.issues || []}
            allRecordedIssueNumbers={recent.flatMap((r) => (r.issues || []).map((i) => i.number))}
            canRecord={!!activeManifestKey}
            onRecordIssue={handleRecordIssue}
            onRemoveIssue={handleRemoveIssue}
          />
        )}
      </div>
    </div>
  );
}
