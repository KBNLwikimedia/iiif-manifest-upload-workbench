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
import { findManuscriptItems } from '../api/wikidata.js';
import { runIiifImport } from '../api/iiif-pipeline.js';
import { categoryExists, searchCategories } from '../api/commons.js';
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
  // Explicit opt-in (default OFF): the user must approve category creation
  // via the checkbox in the confirm step before the tool may create it.
  const [createCat, setCreateCat] = React.useState(false);
  const [catExists, setCatExists] = React.useState(null); // null = checking/unknown
  const [catSuggestions, setCatSuggestions] = React.useState(null); // null = loading
  // Combobox dropdown state (Commons-searchbox-style typeahead).
  const [catOpen, setCatOpen] = React.useState(false);
  const [catIdx, setCatIdx] = React.useState(-1);

  // The first check after a manifest is parsed runs immediately (no debounce
  // — the category was set programmatically, not typed); later user edits
  // debounce. Reset to immediate in acceptParse.
  const catImmediateRef = React.useRef(true);

  // Live category check + suggestions.
  React.useEffect(() => {
    const cat = category.replace(/^\s*Category\s*:\s*/i, '').trim();
    if (!cat) { setCatExists(null); setCatSuggestions(null); return undefined; }
    let alive = true;
    setCatExists(null);
    setCatSuggestions(null);
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
      suggestCategories(cat)
        .then((hits) => { if (alive) setCatSuggestions(hits.filter((h) => h !== cat).slice(0, 10)); })
        .catch(() => { if (alive) setCatSuggestions([]); });
    }, delay);
    return () => { alive = false; clearTimeout(t); };
  }, [category]);
  const [qid, setQid] = React.useState('');
  const [qidCandidates, setQidCandidates] = React.useState(null); // null = loading

  // selection (step 3)
  const [selected, setSelected] = React.useState(() => new Set());
  // hover zoom in the gallery: { canvas, left, top } or null. The preview
  // requests a larger IIIF rendition (700px) than the 400px tile thumbs.
  const [hoverPreview, setHoverPreview] = React.useState(null);

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
    setQid('');
    setQidCandidates(null);
    setCatExists(null);
    setError(null);
    setStep('review');
    // Fire the Q-id auto-lookup + category existence check (best-effort).
    // OI-30: guard with a per-parse token so a superseded lookup (user loaded
    // another manifest meanwhile) can't overwrite the current candidates/Q-id,
    // and only auto-fill when the field is still empty (never clobber a value
    // the user typed while the lookup was in flight).
    const myLookup = ++qidLookupRef.current;
    findManuscriptItems(manuscript.signature)
      .then((hits) => {
        if (qidLookupRef.current !== myLookup) return;
        setQidCandidates(hits);
        if (hits.length === 1) setQid((q) => q || hits[0].qid);
      })
      .catch(() => { if (qidLookupRef.current === myLookup) setQidCandidates([]); });
    // category existence + suggestions run in the debounced effect above
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
    const toImport = pendingCategory
      ? chosen.map((it) => ({ ...it, iiifPendingCategory: pendingCategory }))
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
  const reportOf = (level) => report.filter((e) => e.level === level);
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
              {/* validation report */}
              {report.length > 0 && (
                <div className="iiif-report">
                  {reportOf('error').map((e, i) => (
                    <p key={`e${i}`} className="iiif-report__line iiif-report__line--error">⛔ {e.message}</p>
                  ))}
                  {reportOf('warning').map((e, i) => (
                    <p key={`w${i}`} className="iiif-report__line iiif-report__line--warning">⚠️ {e.message}</p>
                  ))}
                  {reportOf('info').map((e, i) => (
                    <p key={`i${i}`} className="iiif-report__line">ℹ️ {e.message}</p>
                  ))}
                </div>
              )}

              {manifest && mapping && (
                <>
                  {/* First-page preview thumbnail (public IIIF thumb). */}
                  {manifest.canvases[0]?.thumbUrl && (
                    <figure className="iiif-review-thumb">
                      <img
                        src={manifest.canvases[0].thumbUrl}
                        alt={`First page of ${manifest.label || 'the manuscript'}`}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    </figure>
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

                  {/* editable mapping settings */}
                  <div className="iiif-settings">
                    <label className="iiif-label" htmlFor="iiif-title">Short title (used in filenames and the category)</label>
                    <input id="iiif-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />

                    <label className="iiif-label" htmlFor="iiif-cat">Commons category for this manuscript</label>
                    <div className="iiif-combobox">
                      <input
                        id="iiif-cat"
                        type="text"
                        value={category}
                        className={catExists === null && category.trim() ? 'iiif-input--checking' : ''}
                        role="combobox"
                        aria-expanded={catOpen && !!catSuggestions?.length}
                        aria-autocomplete="list"
                        autoComplete="off"
                        onChange={(e) => { setCategory(e.target.value); setCatOpen(true); setCatIdx(-1); }}
                        onFocus={() => setCatOpen(true)}
                        onBlur={() => setTimeout(() => setCatOpen(false), 150)}
                        onKeyDown={(e) => {
                          const list = catSuggestions || [];
                          if (!list.length) return;
                          if (e.key === 'ArrowDown') { e.preventDefault(); setCatOpen(true); setCatIdx((i) => (i + 1) % list.length); }
                          else if (e.key === 'ArrowUp') { e.preventDefault(); setCatIdx((i) => (i <= 0 ? list.length - 1 : i - 1)); }
                          else if (e.key === 'Enter' && catOpen && catIdx >= 0) { e.preventDefault(); setCategory(list[catIdx]); setCatOpen(false); setCatIdx(-1); }
                          else if (e.key === 'Escape') { setCatOpen(false); setCatIdx(-1); }
                        }}
                      />
                      {catOpen && catSuggestions && catSuggestions.length > 0 && (
                        <ul className="iiif-combobox__list" role="listbox">
                          {catSuggestions.map((s, i) => (
                            <li
                              key={s}
                              role="option"
                              aria-selected={i === catIdx}
                              className={`iiif-combobox__item${i === catIdx ? ' iiif-combobox__item--active' : ''}`}
                              // mousedown, not click: fires before the input's
                              // blur closes the dropdown.
                              onMouseDown={(e) => { e.preventDefault(); setCategory(s); setCatOpen(false); setCatIdx(-1); }}
                              onMouseEnter={() => setCatIdx(i)}
                            >
                              {s}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <p className="iiif-hint">
                      {catExists === null && category.trim() && 'Checking Commons…'}
                      {catExists === true && (
                        <span className="iiif-cat-exists">✔ This category already exists on Commons — files will be added to it.</span>
                      )}
                      {catExists === false && (
                        <span className="iiif-cat-missing">✚ This category does not exist yet — you will be asked to approve its creation in the final step.</span>
                      )}
                      {catExists === 'unknown' && (
                        <span>⚠️ Couldn't check Commons just now (network) — it'll be treated as not yet existing.</span>
                      )}
                    </p>

                    <label className="iiif-label" htmlFor="iiif-qid">
                      Wikidata item of the manuscript (feeds{' '}
                      <a href="https://www.wikidata.org/wiki/Property:P6243" target="_blank" rel="noopener noreferrer">digital representation of (P6243)</a>{' '}
                      +{' '}
                      <a href="https://www.wikidata.org/wiki/Property:P180" target="_blank" rel="noopener noreferrer">depicts (P180)</a>)
                    </label>
                    <input id="iiif-qid" type="text" placeholder="Q…" value={qid} onChange={(e) => setQid(e.target.value)} />
                    <p className="iiif-hint">
                      {qidCandidates === null && 'Searching Wikidata by signature…'}
                      {qidCandidates && qidCandidates.length === 0 && 'No Wikidata item found by signature — leave empty or enter one manually.'}
                      {qidCandidates && qidCandidates.length > 0 && (
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
                            </span>
                          ))}
                        </>
                      )}
                    </p>
                  </div>
                </>
              )}
            </div>
          )}

          {step === 'select' && manifest && (
            <div className="iiif-step-select">
              {manifest.downscaledCount > 0 && (
                <p className="iiif-hint iiif-downscale-note">
                  A “&gt;25 MP” tag means the source image is larger than 25 megapixels. The KB's IIIF image server caps what it delivers at 25 MP, so those pages arrive slightly smaller than the original (but still high-res) — e.g. an 8040 × 6030 page (48 MP) downloads at ~25 MP. This is a limit of the IIIF server — not of Wikimedia Commons, which accepts much larger files.
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
                        {' '}<strong>I approve creating this category</strong> (under “{KB_PARENT_CATEGORY}”) when the first page is published
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
      </div>
    </div>
  );
}
