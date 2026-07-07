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
import { categoryExists, createCategoryPage } from '../api/commons.js';
import { KB_PARENT_CATEGORY } from '../api/iiif-map.js';
import { DEMO_MODE } from '../config.js';

const Icon = window.Icon;

const STEP_TITLES = {
  input: 'Import IIIF manifest',
  review: 'Check the manifest',
  select: 'Select pages',
  confirm: 'Ready to import',
  running: 'Importing…',
  done: 'Import finished',
};

export function IiifImportModal({ onClose, onAddItems, onUpdateItem, onReplaceItem }) {
  const [step, setStep] = React.useState('input');
  const [url, setUrl] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  // parse result
  const [parsed, setParsed] = React.useState(null); // { ok, report, manifest }

  // mapping settings (step 2, editable)
  const [title, setTitle] = React.useState('');
  const [category, setCategory] = React.useState('');
  const [createCat, setCreateCat] = React.useState(true);
  const [catExists, setCatExists] = React.useState(null); // null = unknown
  const [qid, setQid] = React.useState('');
  const [qidCandidates, setQidCandidates] = React.useState(null); // null = loading

  // selection (step 3)
  const [selected, setSelected] = React.useState(() => new Set());

  // pipeline (step 5)
  const abortRef = React.useRef({ current: false });
  const [progress, setProgress] = React.useState({ done: 0, total: 0 });
  const [summary, setSummary] = React.useState(null);

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

  // --- step 1 → 2: parse ---------------------------------------------------

  const acceptParse = (result) => {
    setParsed(result);
    if (!result.manifest) { setError(null); setStep('review'); return; }
    const { manuscript } = mapManifest(result.manifest);
    setTitle(manuscript.title);
    setCategory(manuscript.categoryName);
    setSelected(new Set(result.manifest.canvases.map((c) => c.index)));
    setQid('');
    setQidCandidates(null);
    setCatExists(null);
    setError(null);
    setStep('review');
    // Fire the Q-id auto-lookup + category existence check (best-effort).
    findManuscriptItems(manuscript.signature)
      .then((hits) => {
        setQidCandidates(hits);
        if (hits.length === 1) setQid(hits[0].qid);
      })
      .catch(() => setQidCandidates([]));
    categoryExists(manuscript.categoryName).then(setCatExists).catch(() => {});
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
    return mapManifest(parsed.manifest, { wikidataQid: qid.trim() || null });
  }, [parsed, qid]); // user-edited title/category are applied in effectiveItems below

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
    setStep('running');
    setSummary(null);
    abortRef.current = { current: false };
    setProgress({ done: 0, total: chosen.length });

    // Create the home category first (Q8) — suggest → user accepted/edited
    // → create. Skipped when it already exists or the user unticked it.
    let catNote = null;
    const cat = category.replace(/^\s*Category\s*:\s*/i, '').trim();
    if (cat && createCat && catExists !== true) {
      try {
        const res = await createCategoryPage(cat, `[[Category:${KB_PARENT_CATEGORY}]]`);
        catNote = res.existed ? 'Category already existed.' : 'Category created.';
      } catch (e) {
        catNote = `Category creation failed: ${e.message} — publish will flag it (you can create it manually).`;
      }
    }

    const result = await runIiifImport(chosen, {
      onAddItems,
      onUpdateItem,
      onReplaceItem,
      onItemDone: (_r, _i) => setProgress((p) => ({ ...p, done: p.done + 1 })),
      abortRef: abortRef.current,
    });
    setSummary({ ...result, catNote });
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
              {step === 'confirm' && `${chosen.length} pages will be downloaded and stashed (~${totalMB} MB through your browser).`}
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
                  {/* manuscript passport */}
                  <table className="iiif-passport">
                    <tbody>
                      {manifest.metadata.filter((m) => !m.placeholder && m.value).map((m, i) => (
                        <tr key={i}>
                          <th>{m.label}</th>
                          <td>{m.value.length > 220 ? `${m.value.slice(0, 220)}…` : m.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* editable mapping settings */}
                  <div className="iiif-settings">
                    <label className="iiif-label" htmlFor="iiif-title">Short title (used in filenames and the category)</label>
                    <input id="iiif-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />

                    <label className="iiif-label" htmlFor="iiif-cat">Commons category for this manuscript</label>
                    <input id="iiif-cat" type="text" value={category} onChange={(e) => { setCategory(e.target.value); setCatExists(null); }} />
                    <p className="iiif-hint">
                      {catExists === true
                        ? 'This category already exists on Commons — files will be added to it.'
                        : (
                          <label className="iiif-check">
                            <input type="checkbox" checked={createCat} onChange={(e) => setCreateCat(e.target.checked)} />
                            {' '}Create this category (under “{KB_PARENT_CATEGORY}”) when the import starts
                          </label>
                        )}
                    </p>

                    <label className="iiif-label" htmlFor="iiif-qid">Wikidata item of the manuscript (feeds “digital representation of” + depicts)</label>
                    <input id="iiif-qid" type="text" placeholder="Q…" value={qid} onChange={(e) => setQid(e.target.value)} />
                    <p className="iiif-hint">
                      {qidCandidates === null && 'Searching Wikidata by signature…'}
                      {qidCandidates && qidCandidates.length === 0 && 'No Wikidata item found by signature — leave empty or enter one manually.'}
                      {qidCandidates && qidCandidates.length > 0 && (
                        <>
                          Found by signature:{' '}
                          {qidCandidates.map((c) => (
                            <button key={c.qid} className="btn btn--quiet iiif-qid-pick" onClick={() => setQid(c.qid)}>
                              {c.qid} — {c.label}
                            </button>
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
              <div className="iiif-select-bar">
                <button className="btn btn--quiet" onClick={() => toggleAll(true)}>Select all</button>
                <button className="btn btn--quiet" onClick={() => toggleAll(false)}>Select none</button>
                {manifest.downscaledCount > 0 && (
                  <span className="iiif-hint">“25 MP” = delivered downscaled by the image server (accepted, design Q9)</span>
                )}
              </div>
              <div className="iiif-gallery">
                {manifest.canvases.map((c) => (
                  <label key={c.index} className={`iiif-canvas${selected.has(c.index) ? ' iiif-canvas--on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={selected.has(c.index)}
                      onChange={() => toggleOne(c.index)}
                    />
                    <img src={c.thumbUrl} alt={c.label || `canvas ${c.index + 1}`} loading="lazy" />
                    <span className="iiif-canvas__label">
                      {c.label || `#${c.index + 1}`}
                      {c.downscaled && <em className="iiif-canvas__badge">25 MP</em>}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {step === 'confirm' && (
            <div className="iiif-step-confirm">
              <p><strong>{chosen.length}</strong> pages → your upload stash, then review &amp; publish from the table as usual.</p>
              <ul className="iiif-recap">
                <li><strong>Filenames:</strong> {chosen[0] ? `File:${chosen[0].iiif.targetFilename}` : '—'}{chosen.length > 1 ? ` … File:${chosen[chosen.length - 1].iiif.targetFilename}` : ''}</li>
                <li><strong>Category:</strong> {category}{catExists === true ? ' (exists)' : createCat ? ' (will be created)' : ' (must exist before publish!)'}</li>
                <li><strong>License:</strong> <code>{mapping?.manuscript.license}</code></li>
                <li><strong>Author:</strong> <code>{mapping?.manuscript.author}</code></li>
                <li><strong>Wikidata:</strong> {qid.trim() || '— none —'}</li>
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
