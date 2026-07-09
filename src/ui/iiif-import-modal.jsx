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
import { fetchManifest, parseManifestFile } from '../api/iiif.js';
import { mapManifest } from '../api/iiif-map.js';
import { findManuscriptItems, resolveQid } from '../api/wikidata.js';
import { runIiifImport } from '../api/iiif-pipeline.js';
import { categoryExists, searchCategories, findManuscriptCategoryVariants } from '../api/commons.js';
import { KB_PARENT_CATEGORY, KB_LICENSE_WIKITEXT } from '../api/iiif-map.js';
import { DEMO_MODE } from '../config.js';

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

// A larger IIIF rendition for the lightbox (1200 px wide — well under the
// 25 MP cap), falling back to the tile thumb / full-res URL.
const largeRendition = (c) => (c?.serviceId ? `${c.serviceId}/full/1200,/0/default.jpg` : (c?.thumbUrl || c?.fullResUrl || ''));

const stripCatPrefix = (s) => String(s || '').replace(/^\s*Category\s*:\s*/i, '').trim();
const commonsCatUrl = (name) =>
  `https://commons.wikimedia.org/wiki/Category:${encodeURIComponent(stripCatPrefix(name).replace(/ /g, '_'))}`;

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
  review: 'Check the manifest',
  select: 'Select pages',
  confirm: 'Ready to import',
  running: 'Importing…',
  done: 'Import finished',
};

export function IiifImportModal({ onClose, onAddItems, onUpdateItem, onReplaceItem, onEnsureArtworkTemplate, initialFile }) {
  const [step, setStep] = React.useState('input');
  const [url, setUrl] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

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
  // hover zoom in the gallery: { canvas, left, top } or null. The preview
  // requests a larger IIIF rendition (700px) than the 400px tile thumbs.
  const [hoverPreview, setHoverPreview] = React.useState(null);
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

  // Esc closes (except mid-run — abort first); lock body scroll while open.
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && step !== 'running') onClose(); };
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
    setExcludedFields(new Set());
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

  const loadUrl = async () => {
    const u = url.trim();
    if (!u) return;
    setBusy(true); setError(null);
    try {
      acceptParse(await fetchManifest(u));
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
      acceptParse(await parseManifestFile(file));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
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
      return {
        ...it,
        title: base,
        categories: cat ? [cat] : it.categories,
        descriptions: { ...it.descriptions, nl: it.descriptions.nl.replace(mapping.manuscript.title, t || mapping.manuscript.title) },
        iiif: { ...it.iiif, targetFilename: `${base}.jpg` },
      };
    });
  }, [mapping, title, category]);

  const chosen = effectiveItems.filter((it) => selected.has(it.iiif.canvasIndex));
  const totalMB = chosen.length * 12; // rough average from the sample corpus

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

    const result = await runIiifImport(toImport, {
      onAddItems,
      onUpdateItem,
      onReplaceItem,
      onItemDone: (_r, _i) => setProgress((p) => ({ ...p, done: p.done + 1 })),
      abortRef: abortRef.current,
    });
    setSummary({
      ...result,
      catNote: pendingCategory
        ? `Category “${pendingCategory}” will be created when you publish the first page.`
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

  return (
    <div className="modal-backdrop" onClick={step === 'running' ? undefined : onClose}>
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
            <p className="modal__sub">
              {step === 'input' && 'Paste a IIIF Presentation 3.0 manifest URL, or pick a downloaded manifest .json file.'}
              {step === 'review' && (manifest ? `${manifest.label || 'Untitled manifest'} — ${manifest.canvasCount} pages` : 'The manifest could not be used.')}
              {step === 'select' && `${selected.size} of ${manifest?.canvasCount ?? 0} pages selected`}
              {step === 'confirm' && (
                <>
                  {chosen.length} pages will be downloaded from the IIIF server and stashed on Wikimedia Commons. An <strong>estimate of ~{totalMB} MB</strong> will be transferred through your browser.
                </>
              )}
              {step === 'running' && `${progress.done} / ${progress.total} pages processed — keep this tab open.`}
              {step === 'done' && 'The imported pages are now rows in your stash — review and publish from the table.'}
            </p>
          </div>
          {step !== 'running' && (
            <button className="btn btn--quiet btn--icon-only" onClick={onClose} aria-label="Close">
              {Icon ? <Icon name="close" size={16} /> : '×'}
            </button>
          )}
        </header>

        <div className="modal__body iiif-modal__body">

          {step === 'input' && (
            <div className="iiif-step-input">
              <label className="iiif-label" htmlFor="iiif-url">Manifest URL</label>
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
                <button className="btn btn--progressive" onClick={loadUrl} disabled={busy || !url.trim()}>
                  {busy ? 'Loading…' : 'Load'}
                </button>
              </div>
              <p className="iiif-or">— or —</p>
              <label className="btn iiif-file-btn">
                Choose a manifest .json file
                <input
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={(e) => loadFile(e.target.files?.[0])}
                  disabled={busy}
                />
              </label>
              {error && <p className="iiif-error" role="alert">{error}</p>}
            </div>
          )}

          {step === 'review' && (
            <div className="iiif-step-review">
              {/* validation report — only rendered when there's something to
                  show, so a manifest with no (visible) issues doesn't leave an
                  empty box at the top. */}
              {hasReport && (
                <div className="iiif-report">
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
                          <figure key={c.index} className="iiif-carousel__item" title={c.label || `page ${i + 1}`}>
                            <button
                              type="button"
                              className="iiif-carousel__thumb"
                              onClick={() => setLightbox(c)}
                              aria-label={`Enlarge page ${i + 1}${c.label ? ` (${c.label})` : ''}`}
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
                      {/* The manifest's own summary is the richest description
                          the KB ships — show it in full, above the metadata
                          pairs (it is not part of metadata[]). */}
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
                    <label className="iiif-label" htmlFor="iiif-title">Short title (used in filenames and the category)</label>
                    <input id="iiif-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />

                    <fieldset className="iiif-fieldset">
                      <legend>Categories</legend>

                      <label className="iiif-label" htmlFor="iiif-cat">Suggested category for this manuscript</label>
                      <CategoryCombobox
                        id="iiif-cat"
                        value={category}
                        onChange={setCategory}
                        inputClassName={catExists === null && category.trim() ? 'iiif-input--checking' : ''}
                      />
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
                              <p className="iiif-existing-cats__foot">…or keep “{cur}” — it'll be created for you when you publish the first page.</p>
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
                        Parent category <span className="iiif-label__note">— the umbrella the manuscript's category is filed under</span>
                      </label>
                      <CategoryCombobox
                        id="iiif-parent-cat"
                        value={parentCategory}
                        onChange={setParentCategory}
                      />
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

                      <label className="iiif-label" htmlFor="iiif-qid">Item of the manuscript</label>
                      <input id="iiif-qid" type="text" placeholder="Q…" value={qid} onChange={(e) => setQid(e.target.value)} />
                      {qidNote && qidNote.qid === qid.trim().toUpperCase() && (
                        <p className="iiif-hint">ℹ️ {qidNote.text}</p>
                      )}
                      <p className="iiif-hint">
                        {qidCandidates === null && 'Searching Wikidata by signature…'}
                        {qidCandidates === 'error' && (
                          <span>
                            ⚠️ Couldn't reach Wikidata just now —{' '}
                            <button
                              type="button"
                              className="iiif-linkbtn"
                              onClick={() => mapping && runQidLookup(mapping.manuscript.signature)}
                            >retry the lookup</button>
                            {' '}or enter a Q-id manually.
                          </span>
                        )}
                        {Array.isArray(qidCandidates) && qidCandidates.length === 0 && 'No Wikidata item found by signature — leave empty or enter one manually.'}
                        {Array.isArray(qidCandidates) && qidCandidates.length > 0 && (
                          <>
                            Found by signature:{' '}
                            {qidCandidates.map((c) => (
                              <span key={c.qid} className="iiif-qid-candidate">
                                <button
                                  className="btn btn--quiet iiif-qid-pick"
                                  onClick={() => setQid(c.qid)}
                                  title="Use this item"
                                >
                                  {qid.trim() === c.qid ? '✓ ' : ''}{c.qid}
                                </button>
                                {' '}
                                <a
                                  href={`https://www.wikidata.org/wiki/${c.qid}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title="Open this item on Wikidata (new tab)"
                                >
                                  {c.label} ↗
                                </a>
                                {(c.commonsGallery || c.commonsPage) && (
                                  <>
                                    {' · '}
                                    <a
                                      href={`https://commons.wikimedia.org/wiki/${encodeURIComponent((c.commonsGallery || c.commonsPage).replace(/ /g, '_'))}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      title="This item's gallery page on Commons (Wikidata P935, new tab)"
                                    >Gallery ↗</a>
                                  </>
                                )}
                                {c.commonsCategory && (
                                  <>
                                    {' · '}
                                    <a
                                      href={commonsCatUrl(c.commonsCategory)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      title="This item's category on Commons (Wikidata P373, new tab)"
                                    >Category ↗</a>
                                  </>
                                )}
                              </span>
                            ))}
                          </>
                        )}
                      </p>
                      <p className="iiif-hint iiif-qid-feeds">
                        Feeds{' '}
                        <a href="https://www.wikidata.org/wiki/Property:P6243" target="_blank" rel="noopener noreferrer">digital representation of (P6243)</a>{' '}
                        +{' '}
                        <a href="https://www.wikidata.org/wiki/Property:P180" target="_blank" rel="noopener noreferrer">depicts (P180)</a>.
                      </p>
                    </fieldset>
                  </div>
                </>
              )}
            </div>
          )}

          {step === 'select' && manifest && (
            <div className="iiif-step-select">
              {manifest.downscaledCount > 0 && (
                <p className="iiif-hint iiif-downscale-note">
                  {manifest.downscaledCount} of the {manifest.canvasCount} pages are larger than 25 megapixels — they carry a “&gt;25 MP” tag below. The KB's IIIF image server caps what it delivers at 25 MP, so those pages arrive slightly smaller than the original (but still high-res) — e.g. an 8040 × 6030 page (48 MP) downloads at ~25 MP. This is a limit of the IIIF server — not of Wikimedia Commons, which accepts much larger files.
                </p>
              )}
              <div className="iiif-select-bar">
                <button className="btn btn--quiet" onClick={() => toggleAll(true)}>Select all</button>
                <button className="btn btn--quiet" onClick={() => toggleAll(false)}>Select none</button>
                <button className="btn btn--quiet" onClick={invertSelection}>Invert selection</button>
              </div>
              <div className="iiif-gallery">
                {manifest.canvases.map((c) => {
                  // Full-detail native tooltip: labels are ellipsized in the
                  // tile, so hovering must reveal the whole story — canvas
                  // label + the Commons filename this page would get.
                  const target = effectiveItems.find((it) => it.iiif.canvasIndex === c.index);
                  const tooltip = [
                    c.label || `canvas ${c.index + 1}`,
                    target ? `→ File:${target.iiif.targetFilename}` : null,
                    c.downscaled ? `Delivered downscaled to ~${target?.iiif.expectedWidth || c.expectedWidth}×${target?.iiif.expectedHeight || c.expectedHeight}px (25 MP cap)` : null,
                  ].filter(Boolean).join('\n');
                  return (
                    <label
                      key={c.index}
                      className={`iiif-canvas${selected.has(c.index) ? ' iiif-canvas--on' : ''}`}
                      title={tooltip}
                      onMouseEnter={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        // Place the zoom panel beside the tile — right of it
                        // when there's room, else left. Vertically clamped so
                        // tall pages stay inside the viewport.
                        const panelW = 440;
                        const left = r.right + panelW + 20 < window.innerWidth ? r.right + 12 : Math.max(8, r.left - panelW - 12);
                        const top = Math.max(8, Math.min(r.top, window.innerHeight - Math.min(window.innerHeight * 0.7, 640) - 8));
                        setHoverPreview({ canvas: c, left, top });
                      }}
                      onMouseLeave={() => setHoverPreview(null)}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(c.index)}
                        onChange={() => toggleOne(c.index)}
                      />
                      <img src={c.thumbUrl} alt={c.label || `canvas ${c.index + 1}`} loading="lazy" />
                      {c.downscaled && (
                        <em className="iiif-canvas__badge" title="This page is larger than 25 megapixels, so it arrives slightly smaller (still high-res).">&gt;25 MP</em>
                      )}
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
                })}
              </div>
              {hoverPreview && (
                <div className="iiif-hover-preview" style={{ left: hoverPreview.left, top: hoverPreview.top }} aria-hidden="true">
                  <img
                    src={hoverPreview.canvas.serviceId
                      ? `${hoverPreview.canvas.serviceId}/full/700,/0/default.jpg`
                      : hoverPreview.canvas.thumbUrl}
                    alt=""
                    onError={(e) => { if (e.target.src !== hoverPreview.canvas.thumbUrl) e.target.src = hoverPreview.canvas.thumbUrl; }}
                  />
                  <span className="iiif-hover-preview__label">{hoverPreview.canvas.label || `#${hoverPreview.canvas.index + 1}`}</span>
                </div>
              )}
            </div>
          )}

          {step === 'confirm' && (
            <div className="iiif-step-confirm">
              <p><strong>{chosen.length}</strong> pages → your upload stash, then review &amp; publish from the table as usual.</p>
              <div className="iiif-recap-files">
                <strong>Target filenames ({chosen.length}):</strong>
                <div className="iiif-filelist" role="list">
                  {chosen.map((it) => (
                    <div key={it.iiif.canvasIndex} role="listitem">File:{it.iiif.targetFilename}</div>
                  ))}
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
                        >{stripCatPrefix(parentCategory) || defaultParent} ↗</a>) when the first page is published
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
              <p className="iiif-hint">{progress.done} / {progress.total} pages</p>
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
                  {summary.aborted && <p>⏹️ Import was cancelled before finishing.</p>}
                  {summary.catNote && <p>🗂️ {summary.catNote}</p>}
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="modal__foot iiif-modal__foot">
          {step === 'review' && (
            <>
              <button className="btn" onClick={() => setStep('input')}>Back</button>
              <button className="btn btn--progressive" disabled={!parsed?.ok} onClick={() => setStep('select')}>
                Next: select pages
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
              <button className="btn btn--progressive" onClick={start}>
                Start import ({chosen.length} pages)
              </button>
            </>
          )}
          {step === 'running' && (
            <button className="btn" onClick={() => { abortRef.current.current = true; }}>
              Cancel after current page
            </button>
          )}
          {step === 'done' && (
            <button className="btn btn--progressive" onClick={onClose}>Go to the table</button>
          )}
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
              aria-label={`Page ${pos + 1}`}
            >
              <button type="button" className="iiif-lightbox__close" onClick={(e) => { e.stopPropagation(); setLightbox(null); }} aria-label="Close">×</button>
              <button
                type="button"
                className="iiif-lightbox__nav iiif-lightbox__nav--prev"
                onClick={(e) => { e.stopPropagation(); stepLightbox(-1); }}
                disabled={pos <= 0}
                aria-label="Previous page"
              >‹</button>
              <figure className="iiif-lightbox__fig" onClick={(e) => e.stopPropagation()}>
                <div className="iiif-lightbox__imgbox">
                  {!lightboxLoaded && <span className="iiif-lightbox__spinner" role="status" aria-label="Loading image…" />}
                  <img
                    key={lightbox.index}
                    src={lightboxUseThumb && lightbox.thumbUrl ? lightbox.thumbUrl : largeRendition(lightbox)}
                    alt={lightbox.label || `page ${pos + 1}`}
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
                  Page {pos + 1} of {canv.length}
                  {lightbox.label ? ` — ${lightbox.label}` : ''}
                  {lightbox.fullResUrl && (
                    <>{' · '}<a href={lightbox.fullResUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>full-res ↗</a></>
                  )}
                </figcaption>
              </figure>
              <button
                type="button"
                className="iiif-lightbox__nav iiif-lightbox__nav--next"
                onClick={(e) => { e.stopPropagation(); stepLightbox(1); }}
                disabled={pos >= canv.length - 1}
                aria-label="Next page"
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
      </div>
    </div>
  );
}
